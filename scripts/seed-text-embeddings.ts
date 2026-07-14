/**
 * Bulk-seed av TEXT-embeddings (multilingual-e5-small) på titel+beskrivning per aktivt
 * objekt → items.text_embedding. Driver den semantiska halvan av hybrid-söken. Ikapp-
 * körning; löpande sköts av schemaläggaren (embedTextPass). Gratis/lokalt (CPU), batchat.
 * Avbrytbart (text_embedding NULL = ej gjort).
 *
 * Kör: ALPR_URL=http://localhost:8099 npx tsx scripts/seed-text-embeddings.ts
 */

import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]!] == null) process.env[m[1]!] = m[2]!;
  }
} catch {
  /* ingen .env - ok */
}
process.env.ALPR_URL = process.env.ALPR_URL || "http://localhost:8099";

import { pool } from "../src/db/pool.ts";
import { embedTextPass } from "../src/ai/embed-text-enrich.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  let scanned = 0;
  let embedded = 0;
  for (;;) {
    const r = await embedTextPass(64);
    if (r.scanned === 0) break; // alla aktiva objekt embeddade
    scanned += r.scanned;
    embedded += r.embedded;
    if (scanned % 640 === 0) log(`text-embed: ${scanned} objekt, ${embedded} embeddade`);
  }
  log(`KLART: ${scanned} objekt, ${embedded} embeddade.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
