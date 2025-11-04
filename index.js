import express from "express";
import fetch from "node-fetch";

const app = express();

app.get("/", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.use("/fapi", async (req, res) => {
  try {
    const targetBase = "https://fapi.binance.com";
    const url = `${targetBase}${req.originalUrl}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const r = await fetch(url, {
      method: req.method,
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "accept": "*/*",
        "origin": "https://www.binance.com"
      },
      body:
        req.method !== "GET" && req.method !== "HEAD" ? req : undefined,
      redirect: "manual",
      signal: controller.signal
    });

    clearTimeout(timer);
    res.status(r.status);
    for (const [k, v] of r.headers) {
      if (
        ![
          "content-security-policy",
          "strict-transport-security"
        ].includes(k.toLowerCase())
      ) {
        res.setHeader(k, v);
      }
    }
    const buf = await r.buffer();
    return res.end(buf);
  } catch (e) {
    return res
      .status(502)
      .json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Futures proxy listening on :" + PORT)
);
