// index.js  (tamamini yapistir)
import express from "express";
import fetch from "node-fetch";

const app = express();

// ortak fetch wrapper
async function proxyFetch(targetBase, req, res, where) {
  const url = `${targetBase}${req.originalUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const r = await fetch(url, {
      method: req.method,
      headers: {
        // Binance 403/451 azaltma
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "*/*",
        origin: "https://www.binance.com",
        referer: "https://www.binance.com/",
      },
      signal: controller.signal,
    });

    const text = await r.text();
    // JSON ise JSON ver; değilse text döndür ama status’ü koru
    try {
      const json = JSON.parse(text);
      if (!r.ok) {
        return res
          .status(r.status)
          .json({ ok: false, where, host: targetBase, status: r.status, ...json });
      }
      return res.status(r.status).json(json);
    } catch {
      return res
        .status(r.status)
        .send(text || `${r.status} ${r.statusText}`);
    }
  } catch (err) {
    return res
      .status(502)
      .json({ ok: false, where, host: targetBase, status: 502, error: String(err) });
  } finally {
    clearTimeout(timer);
  }
}

// health
app.get("/", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Hangi host?
app.get("/which", (_req, res) =>
  res.json({
    spot: "https://api-gcp.binance.com",
    futures: "https://fapi.binance.com",
  })
);

// SPOT proxy (Türkiye için en stabil host)
app.use("/api", async (req, res) => {
  const spotBase = "https://api-gcp.binance.com";
  return proxyFetch(spotBase, req, res, "spot");
});

// FUTURES proxy (TR’de 403 dönebilir)
app.use("/fapi", async (req, res) => {
  const futBase = "https://fapi.binance.com";
  return proxyFetch(futBase, req, res, "futures");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy up on :" + PORT));
