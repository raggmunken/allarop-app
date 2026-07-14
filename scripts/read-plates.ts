/**
 * Bulk-plåtläsning: läs registreringsskyltar ur bilderna på aktiva fordon som saknar
 * regnr i annonstexten (GRATIS vision-modell), korsvalidera mot biluppgifters märke,
 * och berika vid träff. Ikappkörning; löpande sköts av schemaläggaren (readPlatePass).
 * Gratis-modellen är rate-limitad → svep om 8, avbryts vid ihållande tomma svep.
 *
 * Kör: npx tsx scripts/read-plates.ts     Logg: data/read-plates.log
 */

// Minimal .env-laddare (samma som cli.ts - scriptet körs direkt via tsx).
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
import { readPlatePass } from "../src/vehicle/enrich.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  let read = 0;
  let matched = 0;
  let emptyRuns = 0;
  for (;;) {
    const r = await readPlatePass(8);
    read += r.read;
    matched += r.matched;
    if (r.scanned === 0) break; // inga fler fordon utan regnr att läsa
    // Alla i svepet plåtlästes utan träff → räkna tomma svep (skyltar syns sällan).
    if (r.read === 0) {
      if (++emptyRuns >= 40) break; // ~320 bilder utan läsbar skylt i rad → klart nog
    } else {
      emptyRuns = 0;
    }
    log(`plåt: ${read} avlästa, ${matched} validerade & berikade (tomma svep i rad: ${emptyRuns})`);
  }
  log(`KLART: ${read} skyltar avlästa, ${matched} korsvaliderade → fordonsdata.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
