// index.js — Render proxy (Spot via CF Worker, Futures best-effort)
import express from "express";
import fetch from "node-fetch";

const app = express();

// ---- Upstreams ----
// SPOT'u Cloudflare Worker üzerinden geçiriyoruz (451/403 bypass)
const SPOT_CF_PROXY = "https://onur-binance-proxy.mecankapisi.workers.dev";

// FUTURES için doğrudan Binance (bölge engeli olabilir; en iyi hostları deneriz)
const FUTURES_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com"
];

// ortak yardımcı
async function hop(url, res, where, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64)",
        ...headers
      },
      signal: ac.signal
    });
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      return res.status(r.status).json(j);
    } catch {
      return res.status(r.status).send(text || `${r.status} ${r.statusText}`);
    }
  } catch (e) {
    return res.status(502).json({ ok:false, where, error:String(e) });
  } finally {
    clearTimeout(t);
  }
}

// health
app.get("/", (_req, res) => res.json({ ok:true, ts: Date.now() }));

// teşhis
app.get("/which", (_req, res) => res.json({
  spot_via: SPOT_CF_PROXY,
  futures_candidates: FUTURES_HOSTS
}));

// ----- SPOT: Render -> CF Worker -> Binance -----
app.use("/api", async (req, res) => {
  const url = `${SPOT_CF_PROXY}${req.originalUrl}`; // /api/... aynen forward
  return hop(url, res, "spot-via-cf");
});

// ----- FUTURES: doğrudan Binance (engellenirse JSON hata) -----
app.use("/fapi", async (req, res) => {
  let last = null;
  for (const base of FUTURES_HOSTS) {
    const url = `${base}${req.originalUrl}`; // /fapi/... aynen forward
    try {
      const r = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64)",
          "origin": "https://www.binance.com",
          "referer": "https://www.binance.com/"
        }
      });
      const text = await r.text();
      if (r.status === 200) {
        try { return res.status(200).json(JSON.parse(text)); }
        catch { return res.status(200).send(text); }
      }
      last = { status: r.status, body: text.slice(0, 400), host: base };
      continue;
    } catch (e) {
      last = { status: 502, body: String(e), host: base };
      continue;
    }
  }
  return res.status(last?.status || 451).json({ ok:false, where:"futures", last });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy up on :" + PORT));
