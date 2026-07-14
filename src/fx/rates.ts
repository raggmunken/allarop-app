/**
 * Växelkurser (SEK per 1 enhet) från Frankfurter — gratis, öppet API, ECB-data,
 * ingen nyckel, ingen rate limit. Cachas i minnet med TTL (kurserna uppdateras
 * dagligen). Vid nätfel behålls senast hämtade (eller bara SEK).
 *
 * Frankfurter `base=SEK` ger "enhet per SEK" → vi inverterar till "SEK per enhet"
 * så frontend kan räkna: belopp_i_sek = belopp * rate[valuta].
 */

const TTL_MS = 6 * 3_600_000;
const SYMBOLS = "EUR,GBP,DKK,USD,NOK,CHF";

let cache: Record<string, number> = { SEK: 1 };
let fetchedAt = 0;

export async function sekRates(): Promise<Record<string, number>> {
  if (Date.now() - fetchedAt < TTL_MS && Object.keys(cache).length > 1) return cache;
  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=SEK&symbols=${SYMBOLS}`,
    );
    if (res.ok) {
      const d = (await res.json()) as { rates?: Record<string, number> };
      const out: Record<string, number> = { SEK: 1 };
      for (const [k, v] of Object.entries(d.rates ?? {})) {
        if (v > 0) out[k] = 1 / v; // enhet-per-SEK → SEK-per-enhet
      }
      if (Object.keys(out).length > 1) {
        cache = out;
        fetchedAt = Date.now();
      }
    }
  } catch {
    /* behåll befintlig cache */
  }
  return cache;
}
