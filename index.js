// index.js — TAMAMINI YAPIŞTIR
import express from "express";
import fetch from "node-fetch";

const app = express();

// --- UPSTREAMS ---
const SPOT_CF_PROXY = "https://onur-binance-proxy.mecankapisi.workers.dev"; // ÇALIŞAN Cloudflare Worker'İN
const FUTURES_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
];

// Ortak fetch yardımcı
async function hop(url, res, where, extraHeaders = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 12_000);

  try {
    const r = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "*/*",
        ...extraHeaders,
      },
      signal: c.signal,
    });
    const text = await r.text();

    // JSON ise JSON dön, değilse düz metin
    try {
      const j = JSON.parse(text);
      return res.status(r.status).json(j);
    } catch {
      return res.status(r.status).send(text || `${r.status} ${r.statusText}`);
    }
  } catch (e) {
    return res
      .status(502)
      .json({ ok: false, where, status: 502, error: String(e) });
  } finally {
    clearTimeout(t);
  }
}

// Health
app.get("/", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Hangi upstream?
app.get("/which", (_req, res) =>
  res.json({
    spot_via: SPOT_CF_PROXY,
    futures_candidates: FUTURES_HOSTS,
  })
);

// --- SPOT ---
// Render -> CF Worker -> Binance (451'i by-pass ediyor)
app.use("/api", async (req, res) => {
  const url = `${SPOT_CF_PROXY}${req.originalUrl}`;
  // CF Worker zaten uygun headerları ekliyor; sadece forward
  return hop(url, res, "spot-via-cf");
});

// --- FUTURES --- (Binance bölge engeli devam edebilir)
app.use("/fapi", async (req, res) => {
  // Sırayla dene; hepsi 451 ise anlaşılır JSON döndür
  let last = null;
  for (const base of FUTURES_HOSTS) {
    const url = `${base}${req.originalUrl}`;
    try {
      const r = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "*/*",
          origin: "https://www.binance.com",
          referer: "https://www.binance.com/",
        },
      });
      if (r.status === 200) {
        const txt = await r.text();
        try {
          return res.status(200).json(JSON.parse(txt));
        } catch {
          return res.status(200).send(txt);
        }
      }
      last = { status: r.status, text: await r.text(), hostTried: base };
      // 451/403 ise diğer hostu dene
      continue;
    } catch (e) {
      last = { status: 502, text: String(e), hostTried: base };
      continue;
    }
  }
  return res
    .status(451)
    .json({ ok: false, where: "futures", reason: "region_block", last });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy up on :" + PORT));
