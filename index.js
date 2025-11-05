// onur-binance-proxy / worker.js  —  TAMAMINI YAPIŞTIR
// Amaç: SPOT isteklerini Binance hostlarına akıllı sırayla yönlendirmek.
// Öncelik: api-gcp.binance.com -> api.binance.com -> api1 -> api2 -> api3
// (api3 bazı bölgelerde 451 verdiği için en sona atıldı. İstersen tamamen kaldır.)

const SPOT_HOSTS = [
  "https://api-gcp.binance.com",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com", // sorun çıkarırsa bu satırı sil
  // "https://data-api.binance.vision", // genelde daha yavaş / farklı kontroller var
];

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function getJsonFromAny(path) {
  let lastErr = null;
  for (const base of SPOT_HOSTS) {
    const url = base + path;
    try {
      const r = await fetch(url, {
        headers: {
          "user-agent": UA,
          accept: "*/*",
          origin: "https://www.binance.com",
          referer: "https://www.binance.com/",
        },
      });
      const text = await r.text();
      // 200 ise JSON döndürmeye çalış
      if (r.status === 200) {
        try {
          return { ok: true, host: base, data: JSON.parse(text) };
        } catch {
          // JSON değilse düz metin döndür
          return { ok: true, host: base, text };
        }
      }
      // 451/403 gibi durumlarda sıradakine geç
      lastErr = { status: r.status, host: base, body: text.slice(0, 200) };
      continue;
    } catch (e) {
      lastErr = { status: 502, host: url, body: String(e) };
      continue;
    }
  }
  return { ok: false, error: "All spot hosts failed", lastErr };
}

function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export default {
  async fetch(req) {
    try {
      const url = new URL(req.url);

      // Sağlık
      if (url.pathname === "/" || url.pathname === "/ping") {
        return jsonResponse({ ok: true, ts: Date.now() });
      }

      // Hangi host seçilmiş? (deneme amaçlı)
      if (url.pathname === "/which") {
        return jsonResponse({ spot_hosts: SPOT_HOSTS });
      }

      // Yalnızca /api/* yolunu SPOT’a geçiriyoruz
      if (url.pathname.startsWith("/api/")) {
        // ?which=1 verilirse sadece seçilen hostu göster
        const wantWhich = url.searchParams.has("which");
        const path = url.pathname + url.search;

        // /api/v3/time veya exchangeInfo gibi çağrıları sırayla dene
        const j = await getJsonFromAny(path);
        if (wantWhich) {
          // sadece hangi host kullanıldı bilgisini ver
          if (j.ok) return jsonResponse({ host: j.host, ok: true });
          return jsonResponse({ ok: false, lastErr: j.lastErr }, 502);
        }

        if (j.ok) {
          if (j.data !== undefined) return jsonResponse(j.data);
          // JSON değilse düz döndür
          return new Response(j.text || "", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        return jsonResponse(
          { ok: false, error: j.error, last: j.lastErr },
          451
        );
      }

      // diğer path’ler
      return jsonResponse({ ok: false, error: "Not Found" }, 404);
    } catch (e) {
      return jsonResponse({ ok: false, error: String(e) }, 500);
    }
  },
};
