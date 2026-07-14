/** Backfilla category + category_conf för alla befintliga items. Kör: tsx scripts/backfill-categories.ts */
import { pool } from "../src/db/pool.ts";
import { classify } from "../src/categories/classify.ts";
import { houseCategoryKey } from "../src/categories/houseCategory.ts";

await pool.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS category TEXT");
await pool.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS category_conf TEXT");

const { rows } = await pool.query<{ house: string; external_id: string; title: string; description: string | null; raw: Record<string, unknown> | null }>(
  "SELECT house, external_id, title, description, raw FROM items WHERE title IS NOT NULL",
);
console.log(`klassar ${rows.length} objekt (lager 1 titel + lager 2 hus-kategori)...`);

const CHUNK = 500;
let done = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const batch = rows.slice(i, i + CHUNK);
  const values: string[] = [];
  const params: unknown[] = [];
  batch.forEach((r, j) => {
    const hc = houseCategoryKey(r.house, r.raw);
    const c = classify(r.title, r.description, hc.key, hc.raw);
    const b = j * 4;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
    params.push(r.house, r.external_id, c.category, c.confidence);
  });
  await pool.query(
    `UPDATE items AS it SET category=v.cat, category_conf=v.conf
     FROM (VALUES ${values.join(",")}) AS v(house, ext, cat, conf)
     WHERE it.house=v.house AND it.external_id=v.ext`,
    params,
  );
  done += batch.length;
  if (done % 5000 < CHUNK) console.log(`  ${done}/${rows.length}`);
}
console.log(`klart: ${done} objekt klassade`);
await pool.end();
