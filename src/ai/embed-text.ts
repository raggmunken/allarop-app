/**
 * Text-embeddings via alpr-sidecarens /embed-text (multilingual-e5-small, 384-dim).
 * Semantisk sök: en sökfrågas vektor jämförs (cosinus) mot varje aktivt objekts titel+
 * beskrivnings-vektor → "ram minne" hamnar nära "arbetsminne DDR4" fast orden skiljer.
 * e5 kräver prefix: dokument embeddas som "passage", sökfrågor som "query". Vektorerna
 * L2-normaliseras server-side → cosinus == prickprodukt. Lagras little-endian float32 i
 * items.text_embedding (samma bytea-mönster som bild-embeddingarna).
 */

import { alprAvailable } from "../vehicle/alpr.ts";

const ALPR_URL = process.env.ALPR_URL ?? "http://localhost:8099";
/** multilingual-e5-base = 768-dim (env-override om modellen byts). */
export const EMBED_TEXT_DIM = Number(process.env.EMBED_TEXT_DIM ?? 768);

export { alprAvailable };

/**
 * Embedda en batch texter → en Float32Array per text (null om sidecarn svarar fel/är nere,
 * eller nollvektor-plats för tom text). kind styr e5-prefixet: "passage" för objekt som
 * indexeras, "query" för en sökfråga. Batchning = ett ONNX-anrop för hela listan.
 */
export async function embedTexts(
  texts: string[],
  kind: "passage" | "query" = "passage",
  timeoutMs = 60_000,
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  try {
    const res = await fetch(`${ALPR_URL}/embed-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts, prefix: kind }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return texts.map(() => null);
    const j = (await res.json()) as { dim?: number; embeddings?: number[][] | null };
    if (j.dim !== EMBED_TEXT_DIM || !Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) {
      return texts.map(() => null);
    }
    return j.embeddings.map((e) =>
      Array.isArray(e) && e.length === EMBED_TEXT_DIM ? Float32Array.from(e) : null,
    );
  } catch {
    return texts.map(() => null);
  }
}

// Query-embeddingar cachas i minnet (permanent per API-process) - sökfrågor upprepas ofta,
// och e5-vektorn för en given fråga är konstant. Eliminerar sidecar-anropet för upprepade
// sökningar helt. KORT timeout: är sidecaren upptagen (bakgrunds-embed) hellre snabb lexikal
// sök (semantik hoppas över den gången) än att hänga i sekunder.
const queryCache = new Map<string, Float32Array>();
const QUERY_TIMEOUT_MS = Number(process.env.SEARCH_QUERY_EMBED_TIMEOUT_MS ?? 2000);

/** En sökfråga → dess query-embedding (cachad; null om sidecarn är nere/upptagen). */
export async function embedQuery(q: string): Promise<Float32Array | null> {
  const key = q.toLowerCase().trim();
  const hit = queryCache.get(key);
  if (hit) return hit;
  const [vec] = await embedTexts([q], "query", QUERY_TIMEOUT_MS);
  if (vec != null) {
    if (queryCache.size > 5000) queryCache.clear(); // enkel storleksgräns
    queryCache.set(key, vec);
  }
  return vec ?? null;
}
