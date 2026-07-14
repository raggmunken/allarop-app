/**
 * Bulk-seed av fynd-motorns uppskattade slutvärden (items.est_value_sek) för alla aktiva
 * objekt. Ikappkörning; löpande sköts av schemaläggaren (estimatePass). Tungt (en trigram-
 * fråga per objekt) → begränsad batch, men gratis/lokalt. Avbrytbart (est_at NULL = ej gjort).
 *
 * Kör: npx tsx scripts/seed-estimates.ts     Logg: data/seed-estimates.log
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

import { pool } from "../src/db/pool.ts";
import { estimatePass } from "../src/price/estimate.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  let scanned = 0;
  let estimated = 0;
  for (;;) {
    const r = await estimatePass(40);
    if (r.scanned === 0) break; // alla aktiva har en färsk uppskattning
    scanned += r.scanned;
    estimated += r.estimated;
    if (scanned % 400 === 0) log(`fynd-est: ${scanned} objekt, ${estimated} med uppskattat värde`);
  }
  log(`KLART: ${scanned} objekt, ${estimated} med uppskattat värde.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
