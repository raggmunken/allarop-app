/** Bygg statisk Auctionet category_id → vår taxonomi-nyckel (blad→topp via parent-kedja). */
import { writeFileSync } from "node:fs";
import { pool } from "../src/db/pool.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149";

// Auctionets 25 toppkategorier → vår taxonomi (deras är konst/antik-tunga, engelska namn).
const TOP: Record<number, string> = {
  25: "konst/konst-tavlor", 117: "konst/antikt", 50: "bocker/bocker-sub", 35: "konst/mattor",
  9: "mobler/porslin-glas", 31: "smycken/klockor", 46: "samla/mynt", 261: "samla/vintage",
  134: "konst/antikt", 16: "mobler/mobler-sub", 270: "bygg/tradgard", 6: "mobler/porslin-glas",
  13: "smycken/smycken-sub", 59: "sport/jakt-fiske", 1: "mobler/belysning", 42: "mobler/prydnad",
  43: "ovrigt/diverse", 57: "elektronik/foto", 38: "smycken/guld-silver", 58: "konst/antikt",
  44: "samla/leksaker", 249: "fordon/personbilar", 49: "klader/klader-skor",
  137: "samla/vintage", 170: "samla/vintage",
};

const cache = new Map<number, { parent: number | null }>();
async function fetchCat(id: number): Promise<{ parent: number | null }> {
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const res = await fetch(`https://auctionet.com/api/v2/categories/${id}.json`, { headers: { "User-Agent": UA } });
    const j = (await res.json()) as { category?: { parent_id?: number | null } };
    const rec = { parent: j.category?.parent_id ?? null };
    cache.set(id, rec);
    return rec;
  } catch {
    return { parent: null };
  }
}
/** Gå uppåt till en topp-25-kategori. */
async function topOf(id: number): Promise<number | null> {
  let cur: number | null = id;
  for (let i = 0; i < 8 && cur != null; i++) {
    if (TOP[cur]) return cur;
    cur = (await fetchCat(cur)).parent;
  }
  return null;
}

const { rows } = await pool.query<{ cid: string }>(
  "SELECT DISTINCT raw->>'category_id' cid FROM items WHERE house='auctionet' AND raw->>'category_id' IS NOT NULL",
);
const ids = rows.map((r) => Number(r.cid)).filter(Number.isFinite);
console.log(`resolverar ${ids.length} blad-id...`);
const map: Record<number, string> = {};
for (const id of ids) {
  const top = await topOf(id);
  if (top && TOP[top]) map[id] = TOP[top]!;
}
console.log(`mappade ${Object.keys(map).length}/${ids.length}`);

const body = `/** AUTOGENERERAD (scripts/build-auctionet-map.ts): Auctionet category_id → taxonomi-nyckel. */
export const AUCTIONET_CATEGORY_MAP: Record<string, string> = ${JSON.stringify(
  Object.fromEntries(Object.entries(map)),
  null,
  0,
).replace(/","/g, '",\n  "').replace(/\{"/, '{\n  "').replace(/"\}/, '"\n}')};
`;
writeFileSync("src/categories/auctionet-map.ts", body);
console.log("skrev src/categories/auctionet-map.ts");
await pool.end();
