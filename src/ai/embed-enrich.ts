/**
 * Embedding-berikning: beräkna DINOv2-bild-embedding på HUVUDBILDEN per objekt →
 * media.embedding. Driver den visuella jämförbarhetsgaten i prisjämförelsen/fynd.
 * Berikar BÅDE aktiva objekt (mål) OCH sålda (price_history-kandidater) - gaten kräver
 * embedding på båda sidor för att slå till (annars behålls kandidaten, missing-safe).
 * Prioriterar aktiva som slutar snart. Gratis/lokalt (CPU), samma trickle-mönster som OCR.
 */

import { pool } from "../db/pool.ts";
import { alprAvailable } from "../vehicle/alpr.ts";
import { embedImagesBatch, encodeVec } from "./embed.ts";

// Sentinel = tom bytea: "försökt, bilden gick ej att hämta". embedding IS NOT NULL →
// väljs ALDRIG om (annars retryas döda URL:er i oändlighet). decodeVec(tom)=null →
// behandlas som "ingen embedding" av gaten (missing-safe), helt ofarligt.
const DEAD_IMAGE = Buffer.alloc(0);

export interface EmbedPassResult {
  scanned: number;
  embedded: number; // bilder som fick en embedding
}

/**
 * En batch: välj huvudbilder utan embedding (aktiva slutar-snart + sålda historik-
 * kandidater interfolierade), embedda, spara. Partiell täckning är SÄKER - gaten
 * hoppas över när endera sidan saknar embedding. limit = antal BILDER per svep.
 */
export async function embedPass(
  limit = Number(process.env.EMBED_BATCH ?? 12),
  concurrency = Number(process.env.EMBED_CONCURRENCY ?? 6),
): Promise<EmbedPassResult> {
  // scanned=-1 = sidecar nere/upptagen (SKILJT från 0 = inget jobb kvar) → bulk-seedaren
  // väntar och provar om i stället för att felaktigt tro sig klar.
  if (!(await alprAvailable())) return { scanned: -1, embedded: 0 };
  // Huvudbildens media-rad (samma bild som prisjämförelsen visar/gatar på) utan embedding.
  // Aktiva slutar-snart-först + en andel sålda historik-kandidater (som faktiskt jämförs).
  const { rows } = await pool.query<{ id: string; url: string }>(
    `(SELECT m.id::text AS id, m.url
      FROM items i
      JOIN LATERAL (
        SELECT m.id, m.url FROM media m
        WHERE m.house=i.house AND m.owner_type='item' AND m.owner_external_id=i.external_id
          AND m.kind='image' AND m.url !~ '_mid\\.' AND m.embedding IS NULL
        ORDER BY m.sort NULLS LAST LIMIT 1
      ) m ON true
      WHERE i.status='active' AND i.category IS NOT NULL
      ORDER BY i.ends_at ASC NULLS LAST
      LIMIT $1)
     UNION ALL
     (SELECT m.id::text AS id, m.url
      FROM price_history ph
      JOIN LATERAL (
        SELECT m.id, m.url FROM media m
        WHERE m.house=ph.house AND m.owner_type='item' AND m.owner_external_id=ph.item_external_id
          AND m.kind='image' AND m.url !~ '_mid\\.' AND m.embedding IS NULL
        ORDER BY m.sort NULLS LAST LIMIT 1
      ) m ON true
      WHERE ph.sold AND ph.final_bid > 0
      ORDER BY ph.ended_at DESC NULLS LAST
      LIMIT $2)`,
    // Aktiva prioriteras (70%): de blir framtidens sålda och deras bilder finns kvar NU
    // → embeddar vi dem innan avslut växer sold-täckningen garanterat. Historik = fyllnad.
    [Math.ceil(limit * 0.7), Math.floor(limit * 0.3)],
  );
  let embedded = 0;
  let dead = 0;
  // BATCHAD GPU-inferens: en ONNX-Run över GPU_BATCH bilder är MÅNGFALDIGT snabbare/bild på GPU
  // än en i taget (amorterar kernel-launch + CPU↔GPU-memcpy). Vi delar kandidaterna i chunkar
  // om GPU_BATCH, och kör batchConc chunkar samtidigt så CDN-hämtningen av nästa chunk överlappar
  // GPU-Run:en av den förra. concurrency = ungefärlig total fetch-parallellism (batchConc×GPU_BATCH).
  const GPU_BATCH = Math.max(1, Number(process.env.EMBED_GPU_BATCH ?? 12));
  const chunks: { id: string; url: string }[][] = [];
  for (let i = 0; i < rows.length; i += GPU_BATCH) chunks.push(rows.slice(i, i + GPU_BATCH));
  const batchConc = Math.max(1, Math.min(Math.round(concurrency / GPU_BATCH) || 1, chunks.length));
  let nextChunk = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const ci = nextChunk++;
      if (ci >= chunks.length) return;
      const chunk = chunks[ci]!;
      const results = await embedImagesBatch(chunk.map((r) => r.url));
      for (let k = 0; k < chunk.length; k++) {
        const r = chunk[k]!;
        const { vec, imageFailed } = results[k]!;
        if (vec != null) {
          await pool.query(`UPDATE media SET embedding=$2, embedded_at=now() WHERE id=$1 AND embedding IS NULL`, [r.id, encodeVec(vec)]);
          embedded++;
        } else if (imageFailed) {
          // Bilden gick ej att hämta (död URL) → sentinel, retryas aldrig igen.
          await pool.query(`UPDATE media SET embedding=$2, embedded_at=now() WHERE id=$1 AND embedding IS NULL`, [r.id, DEAD_IMAGE]);
          dead++;
        }
        // annars: sidecar nere/transient → lämna NULL, prova om nästa svep
      }
    }
  }
  await Promise.all(Array.from({ length: batchConc }, () => worker()));
  return { scanned: rows.length, embedded: embedded + dead };
}
