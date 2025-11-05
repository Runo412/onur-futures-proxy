// index.js — Render proxy (Spot + Futures) w/ robust fallback & clear errors
import express from "express";
import fetch from "node-fetch";

const app = express();
const TIMEOUT_MS = 12000;

const SPOT_HOSTS = [
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api.binance.com",
  "https://data-api.binance.vision"
];

const FUTURES_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com"
];

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "*/*",
        origin: "https://www.binance.com",
        ...(init.headers || {})
      }
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function tryHosts(hosts, path, method = "GET", body = null) {
  let last = { status: 0, text: "", host: "" };
  for (const base of hosts) {
    const url = base + path; // path'i artık aynen geçiyoruz ( /api/... , /fapi/... )
    try {
      const res = await fetchWithTimeout(url, { method, body });
      const text = await res.text();
      if (res.ok) {
        try { return { ok: true, host: base, json: JSON.parse(text) }; }
        catch { return { ok: true, host: base, text }; }
      }
      last = { status: res.status, text, host: base };
    } catch (e) {
      last = { status: 0, text: String(e), host: base };
    }
  }
  return { ok: false, ...last };
}

// Health
app.get("/", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Which host?
app.get("/which", async (_req, res) => {
  const r = await tryHosts(SPOT_HOSTS, "/api/v3/time");
  res.json(r.ok ? { ok: true, host: r.host, serverTime: r.json?.serverTime }
                : { ok: false, error: r.text, host: r.host, status: r.status });
});

// Spot pass-through (yolu aynen gönder)
app.use("/api", async (req, res) => {
  const path = req.originalUrl; // /api/...
  const r = await tryHosts(SPOT_HOSTS, path, req.method);
  if (r.ok) return res.status(200).type("application/json")
                    .send(r.json ? JSON.stringify(r.json) : r.text);
  return res.status(r.status || 502).json({
    ok: false, where: "spot", host: r.host, status: r.status,
    error: r.text?.slice(0, 400)
  });
});

// Futures pass-through (yolu aynen gönder)
app.use("/fapi", async (req, res) => {
  const path = req.originalUrl; // /fapi/...
  const r = await tryHosts(FUTURES_HOSTS, path, req.method);
  if (r.ok) return res.status(200).type("application/json")
                    .send(r.json ? JSON.stringify(r.json) : r.text);
  return res.status(r.status || 502).json({
    ok: false, where: "futures", host: r.host, status: r.status,
    error: r.text?.slice(0, 400)
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("proxy up on", PORT));
