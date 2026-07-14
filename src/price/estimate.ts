/**
 * FYND-motorn: beräknar ett uppskattat SLUTVÄRDE per aktivt objekt ur jämförbara sålda
 * (samma prisstatistik-maskineri som "vad har liknande gått för" - kategori-gate,
 * attribut-gate, antal-gate, verifierat-sålt, SEK-omräkning). Median väljs (robust mot
 * outliers). Lagras på objektet (items.est_value_sek/est_count/est_at) så fynd-flaggan
 * (nuvarande pris << uppskattat värde) kan beräknas billigt vid varje läsning.
 *
 * Prioriterar objekt som slutar snart (där ett fynd är mest akut) + aldrig-beräknade.
 * TTL: räknas om när historiken/attributen hunnit växa. "Hellre inget än fel" - est_count
 * lagras även när det är för få comparables (0), så vi inte flaggar fynd på tunt underlag.
 */

import { pool } from "../db/pool.ts";
import { priceStats } from "../db/repo.ts";
import { ItemAttrs } from "../db/similar.ts";
import { decodeVec } from "../ai/embed.ts";

const TTL_HOURS = Number(process.env.ESTIMATE_TTL_HOURS ?? 18);

export interface EstimatePassResult {
  scanned: number;
  estimated: number; // fick en användbar uppskattning (>=3 comparables)
}

export async function estimatePass(limit = Number(process.env.ESTIMATE_BATCH ?? 20)): Promise<EstimatePassResult> {
  const { rows } = await pool.query<{
    house: string;
    external_id: string;
    title: string;
    category: string | null;
    lot_count: number | null;
    attrs: ItemAttrs | null;
    emb: Buffer | null;
  }>(
    // Målets egen huvudbild-embedding hämtas med (redan lagrad av embedPass - ingen live-
    // hämtning) → visuell gate mot kandidaterna. Saknas den → null → gaten hoppas över.
    `SELECT i.house, i.external_id, i.title, i.category, i.lot_count, i.attrs,
            (SELECT m.embedding FROM media m
             WHERE m.house=i.house AND m.owner_type='item' AND m.owner_external_id=i.external_id
               AND m.kind='image' AND m.embedding IS NOT NULL
             ORDER BY m.sort NULLS LAST LIMIT 1) emb
     FROM items i
     WHERE i.status='active' AND (i.ends_at IS NULL OR i.ends_at > now())
       AND i.title IS NOT NULL AND i.category IS NOT NULL
       AND (i.est_at IS NULL OR i.est_at < now() - ($1 || ' hours')::interval)
     ORDER BY (i.est_at IS NULL) DESC, i.ends_at ASC NULLS LAST
     LIMIT $2`,
    [TTL_HOURS, limit],
  );
  let estimated = 0;
  for (const it of rows) {
    const stats = await priceStats(it.title, {
      exclHouse: it.house,
      exclId: it.external_id,
      category: it.category,
      lotCount: it.lot_count,
      attrs: it.attrs,
      targetEmbedding: decodeVec(it.emb),
    }).catch(() => null);
    const median = stats?.median ?? null;
    const count = stats?.count ?? 0;
    await pool.query(
      `UPDATE items SET est_value_sek=$3, est_count=$4, est_p25=$5, est_p75=$6, est_at=now()
       WHERE house=$1 AND external_id=$2`,
      [it.house, it.external_id, median, count, stats?.p25 ?? null, stats?.p75 ?? null],
    );
    if (median != null) estimated++;
  }
  return { scanned: rows.length, estimated };
}
