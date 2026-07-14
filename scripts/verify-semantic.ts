/** Verifiering av den ADAPTIVA z-gaten (samma logik som semanticTopK): visa per fråga vad
 * gaten släpper igenom (äkta träffar) resp. avvisar (brus → TOMT = hellre inget än fel). */
import { readFileSync } from "node:fs";
try { for (const line of readFileSync(".env", "utf8").split("\n")) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !line.trim().startsWith("#") && process.env[m[1]!] == null) process.env[m[1]!] = m[2]!; } } catch { /* */ }
process.env.ALPR_URL = process.env.ALPR_URL || "http://localhost:8099";
import { pool } from "../src/db/pool.ts";
import { decodeVec, cosine } from "../src/ai/embed.ts";
import { embedQuery } from "../src/ai/embed-text.ts";

const Z = Number(process.env.SEARCH_SEM_Z ?? 4.0);
const FLOOR = Number(process.env.SEARCH_SEM_FLOOR ?? 0.74);
const QUERIES = ["soffa", "guld ring", "matta", "cykel", "borrmaskin", "tv",
  "hörlurar", "dammsugare", "elgitarr", "kylskåp", "rymdraket"];

async function main(): Promise<void> {
  const { rows } = await pool.query<{ title: string; emb: Buffer }>(
    `SELECT i.title, i.text_embedding AS emb FROM items i
     WHERE i.status='active' AND i.text_embedding IS NOT NULL AND octet_length(i.text_embedding)>0`);
  const idx = rows.map((r) => ({ title: r.title, vec: decodeVec(r.emb)! })).filter((r) => r.vec);
  console.log(`Index: ${idx.length} objekt, z-tröskel=${Z}\n`);
  for (const q of QUERIES) {
    const qv = await embedQuery(q); if (!qv) continue;
    const s = idx.map((r) => ({ title: r.title, v: cosine(qv, r.vec) }));
    const mean = s.reduce((a, b) => a + b.v, 0) / s.length;
    const std = Math.sqrt(s.reduce((a, b) => a + (b.v - mean) ** 2, 0) / s.length) || 1e-9;
    const cutoff = Math.max(FLOOR, mean + Z * std);
    const hits = s.filter((x) => x.v >= cutoff).sort((a, b) => b.v - a.v).slice(0, 5);
    if (hits.length === 0) { console.log(`"${q}"  → TOMT (ingen äkta träff, brus avvisat)`); continue; }
    console.log(`"${q}"  → ${hits.length} träffar:`);
    for (const h of hits) console.log(`     ${h.v.toFixed(3)}  ${h.title.slice(0, 60)}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
