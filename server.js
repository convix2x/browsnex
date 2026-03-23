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

async function getOrCreateSession(id, url, width, height) {
  if (sessions[id]) {
    if (sessions[id].url !== url) {
      sessions[id].url = url;
      try {
        await sessions[id].page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        console.error("[nav]", e.message);
      }
    }
    return sessions[id];
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
  await page.setUserAgent(
    "Mozilla/5.0 (Linux; Android 10; Pixel 4) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/122.0.0.0 Mobile Safari/537.36"
  );

  const cdp = await page.target().createCDPSession();

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });

  const session = { browser, page, cdp, url, width, height, listeners: new Set() };

  cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
    const buf = Buffer.from(data, "base64");
    for (const res of session.listeners) writeFrame(res, buf);
    try { await cdp.send("Page.screencastFrameAck", { sessionId }); } catch (_) {}
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.error("[nav]", e.message);
  }

  sessions[id] = session;
  return session;
}

app.get("/stream", async (req, res) => {
  const url    = req.query.url || "https://google.com";
  const id     = req.query.id  || "default";
  const width  = parseInt(req.query.w) || 375;
  const height = parseInt(req.query.h) || 667;

  let session;
  try {
    session = await getOrCreateSession(id, url, width, height);
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

  const cleanup = () => session.listeners.delete(res);
  req.on("close", cleanup);
  req.on("error", cleanup);
});

app.post("/input/tap", async (req, res) => {
  const { id, x, y } = req.body;
  const session = sessions[id];
  if (!session) return res.status(404).end();
  await session.page.evaluate(() => {
    if (document.activeElement) document.activeElement.blur();
  }).catch(() => {});
  session.page.mouse.click(x, y).catch(() => {});
  res.end();
});

app.post("/input/type", (req, res) => {
  const { id, text } = req.body;
  const session = sessions[id];
  if (!session) return res.status(404).end();
  session.page.keyboard.type(text, { delay: 0 }).catch(() => {});
  res.end();
});

app.post("/input/key", (req, res) => {
  const { id, key } = req.body;
  const session = sessions[id];
  if (!session) return res.status(404).end();
  session.page.keyboard.press(key).catch(() => {});
  res.end();
});

app.post("/input/scroll", (req, res) => {
  const { id, dx, dy } = req.body;
  const session = sessions[id];
  if (!session) return res.status(404).end();
  session.page.mouse.wheel({ deltaX: dx, deltaY: dy }).catch(() => {});
  res.end();
});

app.get("/meta", async (req, res) => {
  const session = sessions[req.query.id];
  if (!session) return res.json({ title: "Browsnex", url: "" });
  try {
    res.json({ title: await session.page.title(), url: session.page.url() });
  } catch (_) {
    res.json({ title: "Browsnex", url: "" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Browsnex running → http://localhost:${PORT}`);
});