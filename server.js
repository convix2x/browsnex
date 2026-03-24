const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const dns = require("dns");
const net = require("net");

const app = express();

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.jsonc"), "utf8"));
const PORT         = config.port         || 3000;
const MAX_SESSIONS = config.maxSessions  || 10;
const SESSION_TTL  = config.sessionTTL   || 300000;
const DOMAIN_MODE  = config.domainMode   || "blacklist";
const DOMAINS      = (config.domains     || []).map(d => d.toLowerCase());
const MEM_LIMIT_MB = config.memLimitMb   || 512;
const RATE_WINDOW  = config.rateWindow   || 60000;
const RATE_MAX     = config.rateMax      || 5;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessions = {};
const ratemap  = {};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function rateLimit(ip) {
  const now = Date.now();
  if (!ratemap[ip]) ratemap[ip] = [];
  ratemap[ip] = ratemap[ip].filter(t => now - t < RATE_WINDOW);
  if (ratemap[ip].length >= RATE_MAX) return false;
  ratemap[ip].push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const ip in ratemap) {
    ratemap[ip] = ratemap[ip].filter(t => now - t < RATE_WINDOW);
    if (!ratemap[ip].length) delete ratemap[ip];
  }
}, RATE_WINDOW);

function isPrivateIP(ip) {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  const privateRanges = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^fc00:/,
    /^fd/,
    /^fe80:/,
  ];
  return privateRanges.some(r => r.test(ip));
}

async function checkSSRF(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch (_) { return false; }
  if (net.isIP(hostname)) {
    return !isPrivateIP(hostname);
  }
  return new Promise((resolve) => {
    dns.lookup(hostname, (err, address) => {
      if (err || !address) return resolve(false);
      resolve(!isPrivateIP(address));
    });
  });
}

function checkDomain(url) {
  let hostname;
  try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) { return false; }
  const match = DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));
  if (DOMAIN_MODE === "whitelist") return match;
  return !match;
}

function sessionCount() {
  return Object.keys(sessions).length;
}

function writeFrame(res, buf) {
  try {
    res.write(`--FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
    res.write(buf);
    res.write("\r\n");
  } catch (_) {}
}

function buildUA(clientUA) {
  if (!clientUA || clientUA === "mobile") {
    return "Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
  }
  return "Mozilla/5.0 (" + clientUA + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
}

function loadInternalPage(name, vars) {
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, "internal", name), "utf8");
  } catch (_) {
    html = "<h1>{{title}}</h1>";
  }
  for (const [k, v] of Object.entries(vars)) {
    html = html.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
  }
  return html;
}

async function destroySession(cid) {
  const s = sessions[cid];
  if (!s) return;
  if (s.ttlTimer) clearTimeout(s.ttlTimer);
  if (s.memTimer) clearInterval(s.memTimer);
  delete sessions[cid];
  log(`[session] closing ${cid}`);
  try { await s.browser.close(); } catch (_) {}
}

function touchSession(cid) {
  const s = sessions[cid];
  if (!s) return;
  if (s.ttlTimer) clearTimeout(s.ttlTimer);
  s.lastSeen = Date.now();
  s.ttlTimer = setTimeout(() => {
    if (sessions[cid] && sessions[cid].listeners.size === 0) {
      log(`[session] TTL expired ${cid}`);
      destroySession(cid);
    }
  }, SESSION_TTL);
}

async function getOrCreateSession(cid, url, width, height, clientUA) {
  if (sessions[cid]) {
    const s = sessions[cid];
    touchSession(cid);
    if (s.url !== url) {
      s.url = url;
      s.navigating = true;
      try {
        await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        log(`[nav] ${e.message}`);
      }
      s.navigating = false;
    }
    return s;
  }

  if (sessionCount() >= MAX_SESSIONS) {
    throw new Error("Max sessions reached (" + MAX_SESSIONS + ")");
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--no-first-run",
      "--disable-blink-features=AutomationControlled",
      `--js-flags=--max-old-space-size=${MEM_LIMIT_MB}`,
      `--window-size=${width},${height}`,
    ],
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setUserAgent(buildUA(clientUA));

  const cdp = await page.target().createCDPSession();

  const session = {
    browser, page, cdp,
    url, width, height,
    listeners: new Set(),
    navigating: false,
    driftUrl: null,
    quality: 50,
    scale: 1.0,
    lastFrameMs: 0,
    adjusting: false,
    manualQuality: false,
    lastSeen: Date.now(),
    ttlTimer: null,
    memTimer: null,
  };

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });

  async function setQuality(q, scale) {
    if (session.adjusting) return;
    session.adjusting = true;
    session.quality = q;
    session.scale = scale;
    try {
      await cdp.send("Page.stopScreencast");
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: q,
        maxWidth: Math.round(width * scale),
        maxHeight: Math.round(height * scale),
        everyNthFrame: 1,
      });
    } catch (_) {}
    session.adjusting = false;
  }

  cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
    const start = Date.now();
    const buf = Buffer.from(data, "base64");
    for (const res of session.listeners) writeFrame(res, buf);
    try { await cdp.send("Page.screencastFrameAck", { sessionId }); } catch (_) {}
    const ms = Date.now() - start;
    session.lastFrameMs = ms;
    if (session.manualQuality) return;
    if (ms > 120) {
      const q = Math.max(20, session.quality - 10);
      const sc = Math.max(0.4, session.scale - 0.1);
      if (q !== session.quality || sc !== session.scale) setQuality(q, sc);
    } else if (ms < 40) {
      const q = Math.min(70, session.quality + 5);
      const sc = Math.min(1.0, session.scale + 0.05);
      if (q !== session.quality || sc !== session.scale) setQuality(q, sc);
    }
  });

  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    if (session.navigating) return;
    const current = frame.url();
    if (current && current !== "about:blank" && current !== session.url) {
      session.driftUrl = current;
      session.url = current;
    }
  });

  browser.on("disconnected", () => {
    if (!sessions[cid]) return;
    log(`[crash] browser disconnected for ${cid}, recovering...`);
    const listeners = [...session.listeners];
    destroySession(cid);
    if (listeners.length > 0) {
      getOrCreateSession(cid, session.url, width, height, clientUA)
        .then(s => {
          for (const res of listeners) s.listeners.add(res);
        })
        .catch(e => log(`[crash] recovery failed: ${e.message}`));
    }
  });

  session.memTimer = setInterval(async () => {
    try {
      const metrics = await cdp.send("Performance.getMetrics");
      const jsHeap = metrics.metrics.find(m => m.name === "JSHeapUsedSize");
      if (jsHeap && jsHeap.value > MEM_LIMIT_MB * 1024 * 1024) {
        log(`[mem] session ${cid} exceeded ${MEM_LIMIT_MB}MB, closing`);
        for (const res of session.listeners) {
          try { res.end(); } catch (_) {}
        }
        destroySession(cid);
      }
    } catch (_) {}
  }, 30000);

  await cdp.send("Performance.enable").catch(() => {});

  sessions[cid] = session;
  touchSession(cid);

  session.navigating = true;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    log(`[nav] ${e.message}`);
  }
  session.navigating = false;

  return session;
}

async function streamResponse(req, res, session, cid) {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=--FRAME",
    "Cache-Control": "no-cache, no-store",
    "Pragma": "no-cache",
    "Connection": "close",
  });
  session.listeners.add(res);
  touchSession(cid);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    session.listeners.delete(res);
    touchSession(cid);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

app.get("/stream", async (req, res) => {
  const ip     = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const url    = req.query.url || "https://earth.nullschool.net";
  const cid    = req.query.cid || "default";
  const width  = parseInt(req.query.w) || 375;
  const height = parseInt(req.query.h) || 667;
  const ua     = req.query.ua || "mobile";

  if (!rateLimit(ip)) {
    res.status(429).send("Too many sessions — try again later");
    return;
  }

  const ssrfOk = await checkSSRF(url);
  if (!ssrfOk) {
    let session;
    try { session = await getOrCreateSession(cid, "about:blank", width, height, ua); } catch (e) { res.status(503).send(e.message); return; }
    const html = loadInternalPage("blocked.html", { hostname: "private/internal address" });
    await session.page.goto("data:text/html," + encodeURIComponent(html)).catch(() => {});
    await streamResponse(req, res, session, cid);
    return;
  }

  if (!checkDomain(url)) {
    let session;
    try { session = await getOrCreateSession(cid, "about:blank", width, height, ua); } catch (e) { res.status(503).send(e.message); return; }
    const html = loadInternalPage("blocked.html", { hostname: new URL(url).hostname });
    await session.page.goto("data:text/html," + encodeURIComponent(html)).catch(() => {});
    await streamResponse(req, res, session, cid);
    return;
  }

  let session;
  try {
    session = await getOrCreateSession(cid, url, width, height, ua);
  } catch (err) {
    res.status(503).send(err.message);
    return;
  }

  await streamResponse(req, res, session, cid);
});

function getSession(cid) {
  const s = sessions[cid];
  if (s) touchSession(cid);
  return s;
}

app.post("/input/tap", async (req, res) => {
  const { cid, x, y } = req.body;
  const session = getSession(cid);
  if (!session) return res.status(404).end();
  await session.page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }).catch(() => {});
  session.page.mouse.click(x, y).catch(() => {});
  res.end();
});

app.post("/input/scroll", (req, res) => {
  const { cid, dx, dy } = req.body;
  const session = getSession(cid);
  if (!session) return res.status(404).end();
  session.page.mouse.wheel({ deltaX: dx, deltaY: dy }).catch(() => {});
  res.end();
});

app.post("/input/type", (req, res) => {
  const { cid, text } = req.body;
  const session = getSession(cid);
  if (!session) return res.status(404).end();
  session.page.keyboard.type(text, { delay: 0 }).catch(() => {});
  res.end();
});

app.post("/input/key", (req, res) => {
  const { cid, key } = req.body;
  const session = getSession(cid);
  if (!session) return res.status(404).end();
  session.page.keyboard.press(key).catch(() => {});
  res.end();
});

app.get("/scrollinfo", async (req, res) => {
  const session = getSession(req.query.cid);
  if (!session) return res.json({ scrollY: 0, scrollHeight: 1000, innerHeight: 667 });
  try {
    const info = await session.page.evaluate(() => ({
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    res.json(info);
  } catch (_) {
    res.json({ scrollY: 0, scrollHeight: 1000, innerHeight: 667 });
  }
});

app.post("/input/scrollto", (req, res) => {
  const session = getSession(req.body.cid);
  if (!session) return res.status(404).end();
  session.page.evaluate((y) => window.scrollTo(0, y), req.body.y).catch(() => {});
  res.end();
});

app.post("/quality", async (req, res) => {
  const session = getSession(req.body.cid);
  if (!session) return res.status(404).end();
  const preset = req.body.preset;
  const presets = {
    low:    { quality: 20, scale: 0.4 },
    medium: { quality: 40, scale: 0.7 },
    high:   { quality: 70, scale: 1.0 },
  };
  if (preset === "auto") {
    session.manualQuality = false;
  } else if (presets[preset]) {
    session.manualQuality = true;
    const p = presets[preset];
    session.quality = p.quality;
    session.scale = p.scale;
    try {
      await session.cdp.send("Page.stopScreencast");
      await session.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: p.quality,
        maxWidth: Math.round(session.width * p.scale),
        maxHeight: Math.round(session.height * p.scale),
        everyNthFrame: 1,
      });
    } catch (_) {}
  }
  res.end();
});

app.post("/input/back",    (req, res) => { const s = getSession(req.body.cid); if (!s) return res.status(404).end(); s.page.goBack().catch(() => {}); res.end(); });
app.post("/input/forward", (req, res) => { const s = getSession(req.body.cid); if (!s) return res.status(404).end(); s.page.goForward().catch(() => {}); res.end(); });
app.post("/input/reload",  (req, res) => { const s = getSession(req.body.cid); if (!s) return res.status(404).end(); s.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); res.end(); });

app.get("/meta", async (req, res) => {
  const session = getSession(req.query.cid);
  if (!session) return res.json({ title: "Browsnex", driftUrl: null });
  try {
    const driftUrl = session.driftUrl;
    session.driftUrl = null;
    res.json({ title: await session.page.title(), driftUrl });
  } catch (_) {
    res.json({ title: "Browsnex", driftUrl: null });
  }
});

app.get("/", (req, res) => {
  if (req.query.url) {
    res.sendFile(path.join(__dirname, "public", "browser.html"));
  } else {
    res.sendFile(path.join(__dirname, "public", "landing.html"));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  log(`  Browsnex running → http://localhost:${PORT}`);
  log(`  Max sessions: ${MAX_SESSIONS}, TTL: ${SESSION_TTL/1000}s, Security mode: ${DOMAIN_MODE}, Mem limit: ${MEM_LIMIT_MB}MB`);
});