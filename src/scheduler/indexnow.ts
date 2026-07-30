/**
 * IndexNow-ping (SEO-audit E11): meddelar IndexNow (Bing m.fl.) om NYA och
 * NYAVSLUTADE objekt så de crawlas direkt i stället för att upptäckas via
 * sitemap/organisk crawl. Helt fire-and-forget: ALLA fel (indexnow.org nere,
 * DNS, timeout) fångas och loggas som en rad — pingen får aldrig störa eller
 * stoppa schemaläggaren.
 *
 * Nyckeln är PUBLIK by design: IndexNow-protokollet kräver att nyckelfilen
 * /<nyckel>.txt är hämtbar på domänen (serveras av API:t, se api/server.ts).
 * Sätt INDEXNOW_KEY i miljön för att styra den; hårdkodade fallbacken nedan är
 * stabil och matchar nyckelfilen som serveras.
 */

export const INDEXNOW_KEY =
  process.env.INDEXNOW_KEY ?? "86a25860203387a0689c8a8f8685670e";

const HOST = "allarop.se";
const KEY_LOCATION = `https://${HOST}/${INDEXNOW_KEY}.txt`;
/** IndexNow tillåter max 10 000 URL:er per POST. */
const BATCH_MAX = 10_000;
/** Tak per flush-svep — resten ligger kvar i bufferten till nästa svep. */
const FLUSH_MAX = 3_000;
/** Skydd mot obegränsad buffertillväxt om pingen aldrig når fram. */
const BUFFER_MAX = 50_000;

// Dedupe via Set — samma objekt kan både insertas och avslutas i samma svep.
const pending = new Set<string>();

function objektUrl(house: string, externalId: string): string {
  return `https://${HOST}/objekt/${encodeURIComponent(house)}/${encodeURIComponent(externalId)}`;
}

/** Buffra ett NYTT objekt (första insert) för IndexNow-ping. Kastar aldrig. */
export function addInserted(house: string, externalId: string): void {
  if (pending.size >= BUFFER_MAX) return;
  pending.add(objektUrl(house, externalId));
}

/** Buffra ett NYAVSLUTAT objekt (status bytte till ended). Kastar aldrig. */
export function addEnded(house: string, externalId: string): void {
  addInserted(house, externalId); // samma URL-ping oavsett orsak
}

/**
 * Skicka buffrade URL:er till IndexNow (max FLUSH_MAX per svep, i batcher om
 * BATCH_MAX). POST:en körs i bakgrunden (void) och alla fel fångas i ping() —
 * flush() kan aldrig kasta eller blockera ingest-loopen.
 */
export function flush(): void {
  if (pending.size === 0) return;
  const urls = [...pending].slice(0, FLUSH_MAX);
  for (const u of urls) pending.delete(u);
  void ping(urls).catch(() => { /* redan loggat i ping() */ });
}

async function ping(urls: string[]): Promise<void> {
  for (let i = 0; i < urls.length; i += BATCH_MAX) {
    const batch = urls.slice(i, i + BATCH_MAX);
    try {
      const res = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host: HOST,
          key: INDEXNOW_KEY,
          keyLocation: KEY_LOCATION,
          urlList: batch,
        }),
        signal: AbortSignal.timeout(5_000), // kort timeout — aldrig hänga ingest
      });
      console.log(`indexnow: pingade ${batch.length} URL:er → HTTP ${res.status}`);
    } catch (e) {
      // Tyst by design: indexnow.org nere/nätverksfel får aldrig påverka ingest.
      // Batch:ens URL:er ratas — de upptäcks ändå via sitemap/organisk crawl.
      console.log(`indexnow: ping misslyckades (${(e as Error).message}) — ${batch.length} URL:er ratas`);
    }
  }
}
