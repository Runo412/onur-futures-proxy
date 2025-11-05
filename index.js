// index.js  — Render proxy (Spot + Futures) with fallback hosts & CORS
import express from "express";
import fetch from "node-fetch";

const app = express();

// ----- CORS (kolay test için açık) -----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ----- Upstream host listeleri (önce GCP) -----
const SPOT_HOSTS = [
  "https://api-gcp.binance.com",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://data-api.binance.vision" // son çare
];

const FUT_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://dapi.binance.com" // bazı bölgelerde çalışabiliyor
];

// Render’ın health-check’i ve hızlı test için
app.get("/", (_req, res) => {
  res.type("text").send("onur-futures-proxy: OK");
});

// Genel forwarder
async function forwardWithFallback(req, res, hosts) {
  let lastErr = null;
  const path = req.originalUrl; // /api/... veya /fapi/...
  for (const host of hosts) {
    const url = host + path;
    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers: {
          // Binance bazen user-agent/cf istemeyebilir; sade bir UA verelim
          "User-Agent": "Mozilla/5.0",
          "Content-Type": req.get("Content-Type") || "application/json",
        },
        // Sadece GET yaptığımız için body yok; gerekirse buraya eklenebilir
      });

      // 2xx ise direkt döndür
      if (upstream.ok) {
        // response headers’ı kopyalayalım (minimum)
        res.status(upstream.status);
        upstream.headers.forEach((v, k) => {
          if (!["content-security-policy", "content-encoding"].includes(k.toLowerCase())) {
            res.setHeader(k, v);
          }
        });
        const buf = await upstream.buffer();
        return res.send(buf);
      }

      // 403/451 gibi engellerde fallback’e devam edelim
      lastErr = new Error(`HTTP ${upstream.status} @ ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  // Hepsi fail
  res.status(502).json({ ok: false, error: "All upstreams failed", lastError: String(lastErr) });
}

// /api/*  → SPOT
app.use("/api", (req, res) => forwardWithFallback(req, res, SPOT_HOSTS));
// /fapi/* → FUTURES
app.use("/fapi", (req, res) => forwardWithFallback(req, res, FUT_HOSTS));

// Sunucu
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Proxy running on port", PORT);
});
