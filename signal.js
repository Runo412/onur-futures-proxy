// --- HOST ROTATION (SPOT) ---
// Önce Binance Vision (genelde 451 yemez), sonra GCP mirror.
// exchangeInfo/klines için çalışır.
const SPOT_BASES = [
  "https://data-api.binance.vision",  // 1) vision mirror
  "https://api-gcp.binance.com",      // 2) gcp mirror
  "https://api2.binance.com"          // 3) fallback
];

// Basit fetch json + rota değiştirici
async function fetchJSON(urls, path, timeoutMs = 12000) {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  let lastErr = null;
  for (const base of urls) {
    const url = `${base}${path}`;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, {
        headers: {
          "user-agent": ua,
          "accept": "application/json,text/plain,*/*"
        },
        signal: ctl.signal
      });
      clearTimeout(t);
      if (!r.ok) {
        lastErr = new Error(`HTTP ${r.status} @ ${url}`);
        continue;
      }
      // vision bazen text döner; JSON değilse parse etmeyi dene
      const text = await r.text();
      try { return JSON.parse(text); } catch {
        // /api/v3/time tarafında vision 404 verirse, fallback D/N
        lastErr = new Error(`Non-JSON @ ${url} : ${text.slice(0,120)}`);
        continue;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("All hosts failed");
}

// Sunucu zamanı için gerekirse yerel fallback
async function getServerTime() {
  // vision’da /api/v3/time bazen 404; o yüzden doğrudan Date.now()’a düşer.
  try {
    const j = await fetchJSON(SPOT_BASES, "/api/v3/time");
    if (j && j.serverTime) return j.serverTime;
  } catch {}
  return Date.now();
}

// Sembol listesi
async function getSpotSymbols() {
  // permissions=SPOT param’ı vision’da desteklenir
  const data = await fetchJSON(SPOT_BASES, "/api/v3/exchangeInfo?permissions=SPOT");
  const syms = (data.symbols || [])
    .filter(s => s.status === "TRADING" && s.symbol.endsWith("USDT"))
    .map(s => s.symbol);
  return syms;
}

// Kline çekimi (1m/5m gibi)
async function getKlines(symbol, interval, limit = 30) {
  const p = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return await fetchJSON(SPOT_BASES, p);
}
