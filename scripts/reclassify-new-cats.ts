/**
 * Omklassa BEFINTLIGA objekt in i de NYA taxonomi-kategorierna (media/*, skonhet/*,
 * bocker/*, samla/serietidningar|samlarkort|militaria|vykort|modell-hobby|mynt|
 * frimarken|leksaker, klader/barnklader). Dessa fanns INTE när LLM:en klassade, så
 * där den precisa regel-klassaren (classifyByText) nu tydligt landar ett objekt i en
 * NY kategori är det mer korrekt än den gamla LLM-etiketten → skriv över (conf 'text').
 *
 * Konservativt: BARA regex-träffar (hög precision), BARA in i nya kategorier, rör aldrig
 * objekt som klassas till en gammal kategori. Fri (ingen LLM). Kör: npx tsx scripts/reclassify-new-cats.ts
 */

import { pool } from "../src/db/pool.ts";
import { classifyByText } from "../src/categories/classify.ts";

const NEW_CATS = new Set([
  "media/vinyl", "media/cd-kassett", "media/film", "media/tvspel", "media/konsol",
  "skonhet/parfym", "skonhet/smink", "skonhet/hudvard",
  "bocker/bocker-sub", "bocker/tidningar", "bocker/kartor-tryck",
  "samla/serietidningar", "samla/samlarkort", "samla/militaria", "samla/vykort",
  "samla/modell-hobby", "samla/mynt", "samla/frimarken", "samla/leksaker",
  "klader/barnklader",
]);

async function main(): Promise<void> {
  let cursor = 0;
  let scanned = 0, moved = 0;
  const perCat: Record<string, number> = {};
  for (;;) {
    const { rows } = await pool.query<{ id: number; title: string; description: string | null; category: string | null }>(
      `SELECT id, title, description, category FROM items
       WHERE id > $1 AND status='active' ORDER BY id ASC LIMIT 5000`,
      [cursor],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      scanned++;
      cursor = r.id;
      const k = classifyByText(r.title, r.description);
      if (k && NEW_CATS.has(k) && k !== r.category) {
        await pool.query(
          `UPDATE items SET category=$1, category_conf='text' WHERE id=$2`,
          [k, r.id],
        );
        moved++;
        perCat[k] = (perCat[k] ?? 0) + 1;
      }
    }
    process.stdout.write(`\r  skannat ${scanned}  flyttat ${moved}   `);
  }
  console.log(`\nKlart. ${moved} objekt omklassade in i nya kategorier:`);
  for (const [k, n] of Object.entries(perCat).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  await pool.end();
}

main().catch((e) => { console.error("FEL:", e); process.exit(1); });
