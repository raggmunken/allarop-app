/**
 * Bulk-omuppskatta ALLA aktiva objekts slutvärde (fynd-motorn) mot den nu mycket större
 * historiken (inkl. 155k Tradera-comps) + den förbättrade ordöverlapp-matchningen. Behövs
 * som engångskörning: schemaläggarens estimatePass har 18h TTL så befintliga (ofta est_count=0)
 * uppskattningar skulle annars inte dra nytta av det nya datat förrän om ~ett dygn.
 *
 * Sidindelad (håller minnet nere: embeddings hämtas per sida) + worker-pool. Återupptagbar
 * via id-cursor. Kör: npx tsx scripts/reestimate.ts
 */

import { pool } from "../src/db/pool.ts";
import { priceStats } from "../src/db/repo.ts";
import { decodeVec } from "../src/ai/embed.ts";

const WORKERS = Number(process.env.REEST_WORKERS ?? 5);
const PAGE = 800;

interface Row {
  house: string; external_id: string; title: string; category: string | null;
  lot_count: number | null; attrs: any; emb: Buffer | null;
}

async function estimateOne(it: Row): Promise<boolean> {
  const s = await priceStats(it.title, {
    exclHouse: it.house, exclId: it.external_id, category: it.category,
    lotCount: it.lot_count, attrs: it.attrs, targetEmbedding: decodeVec(it.emb),
  }).catch(() => null);
  await pool.query(
    `UPDATE items SET est_value_sek=$3, est_count=$4, est_p25=$5, est_p75=$6, est_at=now()
     WHERE house=$1 AND external_id=$2`,
    [it.house, it.external_id, s?.median ?? null, s?.count ?? 0, s?.p25 ?? null, s?.p75 ?? null],
  );
  return s?.median != null;
}

async function main(): Promise<void> {
  let cursorHouse = "", cursorId = "";
  let done = 0, est = 0;
  for (;;) {
    const { rows } = await pool.query<Row & { external_id: string }>(
      `SELECT i.house, i.external_id, i.title, i.category, i.lot_count, i.attrs,
              (SELECT m.embedding FROM media m WHERE m.house=i.house AND m.owner_type='item'
                 AND m.owner_external_id=i.external_id AND m.kind='image' AND m.embedding IS NOT NULL
               ORDER BY m.sort NULLS LAST LIMIT 1) emb
       FROM items i
       WHERE i.status='active' AND i.title IS NOT NULL AND i.category IS NOT NULL
         AND (i.house, i.external_id) > ($1, $2)
       ORDER BY i.house, i.external_id LIMIT ${PAGE}`,
      [cursorHouse, cursorId],
    );
    if (rows.length === 0) break;
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < rows.length) {
        const it = rows[idx++]!;
        if (await estimateOne(it)) est++;
        done++;
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    const last = rows[rows.length - 1]!;
    cursorHouse = last.house; cursorId = last.external_id;
    process.stdout.write(`\r  ${done} omuppskattade  (${est} fick uppskattning)   `);
  }
  console.log(`\nKlart. ${done} objekt, ${est} med användbar uppskattning.`);
  await pool.end();
}

main().catch((e) => { console.error("FEL:", e); process.exit(1); });
