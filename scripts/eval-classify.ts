/** Utvärdera klassificeraren mot riktiga item-titlar i DB. Körs: tsx scripts/eval-classify.ts */
import { pool } from "../src/db/pool.ts";
import { classifyByText } from "../src/categories/classify.ts";
import { CAT_LABELS, OVRIGT } from "../src/categories/taxonomy.ts";

const { rows } = await pool.query<{ title: string; description: string | null; house: string }>(
  "SELECT title, description, house FROM items WHERE status='active' AND title IS NOT NULL",
);
console.log(`objekt: ${rows.length}`);

let classified = 0;
const byMain = new Map<string, number>();
for (const r of rows) {
  const key = classifyByText(r.title, r.description);
  if (key) {
    classified++;
    const main = key.split("/")[0]!;
    byMain.set(main, (byMain.get(main) ?? 0) + 1);
  }
}
console.log(`klassade ur TITEL enbart: ${classified} (${((classified / rows.length) * 100).toFixed(1)}%) - resten faller till hus-kategori/Övrigt`);
console.log("\nfördelning (huvudkategori):");
for (const [m, c] of [...byMain.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(6)}  ${m}`);
}

console.log("\n=== dina exempel + stickprov ===");
const probes = ["dykutrustning", "3d-skrivare", "3d skrivare", "flytväst", "grävmaskin", "collier", "husvagn", "kaffemaskin"];
for (const p of probes) {
  const hit = rows.find((r) => r.title.toLowerCase().includes(p));
  if (hit) {
    const k = classifyByText(hit.title, hit.description) ?? OVRIGT;
    const lbl = CAT_LABELS[k];
    console.log(`  "${p}" → ${hit.title.slice(0, 45)}  ⇒  ${lbl ? lbl.main + " > " + lbl.sub : k}`);
  } else {
    console.log(`  "${p}" → (inget aktivt objekt just nu)`);
  }
}

console.log("\n=== 15 slumpade objekt (ögonkoll) ===");
for (const r of rows.sort(() => Math.random() - 0.5).slice(0, 15)) {
  const k = classifyByText(r.title, r.description) ?? OVRIGT;
  const lbl = CAT_LABELS[k];
  console.log(`  [${(lbl ? lbl.main + ">" + lbl.sub : "ÖVRIGT").padEnd(34)}] ${r.title.slice(0, 50)}`);
}

await pool.end();
