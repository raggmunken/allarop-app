/**
 * Bulk-seed av bild-embeddings (DINOv2-base) på huvudbilder → media.embedding. Driver
 * den visuella jämförbarhetsgaten. Ikappkörning; löpande sköts av schemaläggaren
 * (embedPass). Gratis/lokalt (CPU) - bara bild-hämtning + inferens. Avbrytbart
 * (embedding NULL = ej gjort). Aktiva + sålda historik-kandidater interfolierade.
 *
 * Kör: ALPR_URL=http://localhost:8099 npx tsx scripts/seed-embeddings.ts  Logg: data/seed-embeddings.log
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
import { embedPass } from "../src/ai/embed-enrich.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  let scanned = 0;
  let embedded = 0;
  for (;;) {
    const r = await embedPass(24);
    if (r.scanned === 0) break; // alla huvudbilder embeddade
    scanned += r.scanned;
    embedded += r.embedded;
    if (scanned % 240 === 0) log(`embed: ${scanned} bilder, ${embedded} embeddade`);
  }
  log(`KLART: ${scanned} bilder, ${embedded} embeddade.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
