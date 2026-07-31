/**
 * Backfill: klassificera befintliga Tradera-objekt med KÄLLANS egen kategori.
 * Objekt som kom in innan categoryName-vägen fanns har bara raw.categoryId (rot-id
 * från snabbsvepet) → traderaCategoryById → vår nyckel, conf 'house'. Objekt med
 * raw.categoryName (full-crawl, löv) → traderaCategoryToKey.
 * Starkare confidence (llm/learned) rörs ALDRIG; bara none/mixed/text/house ersätts
 * om nyckeln skiljer sig (idempotent).
 *
 * Kör: npx tsx scripts/backfill-tradera-cats.ts
 */
import { pool, closePool } from "../src/db/pool.ts";
import { traderaCategoryById, traderaCategoryToKey } from "../src/categories/tradera-map.ts";

async function main(): Promise<void> {
  const before = await pool.query(
    `SELECT COALESCE(category,'(null)') AS kat, count(*) FROM items
     WHERE house='tradera' AND status='active' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
  );
  console.log("FÖRE:", before.rows.map((r) => `${r.kat}=${r.count}`).join(", "));

  let updated = 0;

  // 1) categoryId (rot-id) → rot-namn → nyckel.
  const { rows: cids } = await pool.query<{ cid: string }>(
    `SELECT DISTINCT raw->>'categoryId' AS cid FROM items
     WHERE house='tradera' AND status='active' AND raw->>'categoryId' IS NOT NULL`,
  );
  for (const { cid } of cids) {
    const key = traderaCategoryById(Number(cid));
    if (!key) continue;
    const r = await pool.query(
      `UPDATE items SET category=$1, category_conf='house'
       WHERE house='tradera' AND status='active'
         AND raw->>'categoryId'=$2
         AND category_conf IN ('none','mixed','text','house')
         AND category IS DISTINCT FROM $1`,
      [key, cid],
    );
    updated += r.rowCount ?? 0;
  }

  // 2) categoryName (löv) → nyckel.
  const { rows: names } = await pool.query<{ cname: string }>(
    `SELECT DISTINCT raw->>'categoryName' AS cname FROM items
     WHERE house='tradera' AND status='active' AND raw->>'categoryName' IS NOT NULL`,
  );
  for (const { cname } of names) {
    const key = traderaCategoryToKey(cname);
    if (!key) continue;
    const r = await pool.query(
      `UPDATE items SET category=$1, category_conf='house'
       WHERE house='tradera' AND status='active'
         AND raw->>'categoryName'=$2
         AND category_conf IN ('none','mixed','text','house')
         AND category IS DISTINCT FROM $1`,
      [key, cname],
    );
    updated += r.rowCount ?? 0;
  }

  const after = await pool.query(
    `SELECT COALESCE(category,'(null)') AS kat, count(*) FROM items
     WHERE house='tradera' AND status='active' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
  );
  console.log(`Uppdaterade ${updated} objekt.`);
  console.log("EFTER:", after.rows.map((r) => `${r.kat}=${r.count}`).join(", "));
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
