/**
 * Kombinerad, SEKVENTIELL ikapp-seed: dränerar först TEXT-embeddings (semantisk sök), sen
 * BILD-embeddings (visuell gate + retention). Sekventiellt = ingen självkonkurrens om den
 * enprocessiga sidecaren. Tålig: scanned<0 = sidecar upptagen (schemaläggarens burst) →
 * vänta och prova om; scanned===0 = FAKTISKT klart. Avbrytbart/återupptagbart.
 *
 * Kör: ALPR_URL=http://localhost:8099 npx tsx scripts/seed-all-embeddings.ts
 */
import { readFileSync } from "node:fs";
try { for (const line of readFileSync(".env", "utf8").split("\n")) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !line.trim().startsWith("#") && process.env[m[1]!] == null) process.env[m[1]!] = m[2]!; } } catch { /* */ }
process.env.ALPR_URL = process.env.ALPR_URL || "http://localhost:8099";

import { pool } from "../src/db/pool.ts";
import { embedTextPass } from "../src/ai/embed-text-enrich.ts";
import { embedPass } from "../src/ai/embed-enrich.ts";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Dränera ett pass tills scanned===0 (klart). scanned<0 = upptagen → vänta/retry. */
async function drain(name: string, pass: () => Promise<{ scanned: number; embedded: number }>): Promise<void> {
  let scanned = 0, embedded = 0, busy = 0;
  for (;;) {
    const r = await pass();
    if (r.scanned < 0) { // sidecar upptagen/nere
      if (++busy % 12 === 0) log(`${name}: sidecar upptagen, väntar...`);
      await sleep(5000);
      continue;
    }
    busy = 0;
    if (r.scanned === 0) break; // faktiskt klart
    scanned += r.scanned; embedded += r.embedded;
    if (scanned % 640 < 64) log(`${name}: ${scanned} skannade, ${embedded} klara`);
  }
  log(`${name}: KLART (${scanned} skannade, ${embedded} klara)`);
}

async function main(): Promise<void> {
  log("Startar sekventiell seed: TEXT → BILD");
  await drain("text", () => embedTextPass(64));
  await drain("bild", () => embedPass(48)); // parallelliseras internt (EMBED_CONCURRENCY)
  log("ALLT KLART.");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
