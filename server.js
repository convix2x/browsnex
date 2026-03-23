const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessions = {};

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

async function getOrCreateSession(cid, url, width, height, clientUA) {
  if (sessions[cid]) {
    const s = sessions[cid];
    if (s.url !== url) {
      s.url = url;
      s.navigating = true;
      try {
        await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        console.error("[nav]", e.message);
      }
      s.navigating = false;
    }
    return s;
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

  session.navigating = true;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.error("[nav]", e.message);
  }
  session.navigating = false;

  sessions[cid] = session;
  return session;
}

async function destroySession(cid) {
  const s = sessions[cid];
  if (!s) return;
  delete sessions[cid];
  console.log(`[session] closing ${cid}`);
  try { await s.browser.close(); } catch (_) {}
}

app.get("/stream", async (req, res) => {
  const url    = req.query.url || "https://earth.nullschool.net";
  const cid    = req.query.cid || "default";
  const width  = parseInt(req.query.w) || 375;
  const height = parseInt(req.query.h) || 667;
  const ua     = req.query.ua || "mobile";

  let session;
  try {
    session = await getOrCreateSession(cid, url, width, height, ua);
  } catch (err) {
    res.status(500).send("Failed: " + err.message);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=--FRAME",
    "Cache-Control": "no-cache, no-store",
    "Pragma": "no-cache",
    "Connection": "close",
  });

  session.listeners.add(res);

  var closed = false;
  var cleanup = function () {
    if (closed) return;
    closed = true;
    session.listeners.delete(res);
    if (session.listeners.size === 0) {
      destroySession(cid);
    }
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
});

app.post("/input/tap", async (req, res) => {
  const { cid, x, y } = req.body;
  const session = sessions[cid];
  if (!session) return res.status(404).end();
  await session.page.evaluate(() => {
    if (document.activeElement) document.activeElement.blur();
  }).catch(() => {});
  session.page.mouse.click(x, y).catch(() => {});
  res.end();
});

app.post("/input/scroll", (req, res) => {
  const { cid, dx, dy } = req.body;
  const session = sessions[cid];
  if (!session) return res.status(404).end();
  session.page.mouse.wheel({ deltaX: dx, deltaY: dy }).catch(() => {});
  res.end();
});

app.post("/input/type", (req, res) => {
  const { cid, text } = req.body;
  const session = sessions[cid];
  if (!session) return res.status(404).end();
  session.page.keyboard.type(text, { delay: 0 }).catch(() => {});
  res.end();
});

app.post("/input/key", (req, res) => {
  const { cid, key } = req.body;
  const session = sessions[cid];
  if (!session) return res.status(404).end();
  session.page.keyboard.press(key).catch(() => {});
  res.end();
});

app.get("/scrollinfo", async (req, res) => {
  const session = sessions[req.query.cid];
  if (!session) return res.json({ scrollY: 0, scrollHeight: 1000, innerHeight: 667 });
  try {
    const info = await session.page.evaluate(() => ({
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      innerHeight: window.innerHeight
    }));
    res.json(info);
  } catch (_) {
    res.json({ scrollY: 0, scrollHeight: 1000, innerHeight: 667 });
  }
});

app.post("/input/scrollto", async (req, res) => {
  const session = sessions[req.body.cid];
  if (!session) return res.status(404).end();
  session.page.evaluate(function (y) { window.scrollTo(0, y); }, req.body.y).catch(() => {});
  res.end();
});

app.post("/input/back", (req, res) => {
  const session = sessions[req.body.cid];
  if (!session) return res.status(404).end();
  session.page.goBack().catch(() => {});
  res.end();
});

app.post("/input/forward", (req, res) => {
  const session = sessions[req.body.cid];
  if (!session) return res.status(404).end();
  session.page.goForward().catch(() => {});
  res.end();
});

app.post("/input/reload", (req, res) => {
  const session = sessions[req.body.cid];
  if (!session) return res.status(404).end();
  session.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  res.end();
});

app.get("/meta", async (req, res) => {
  const session = sessions[req.query.cid];
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
  console.log(`\n  Browsnex running → http://localhost:${PORT}\n`);
});