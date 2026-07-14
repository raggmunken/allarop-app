/**
 * Bulk-uppslag av fordonsdata (biluppgifter.se) för ALLA aktiva fordon med regnr -
 * ikappkörning; löpande underhåll sköts av schemaläggarpasset (vehicleEnrichPass).
 * Källan throttlas globalt (~1 anrop/s i biluppgifter.ts) → ta höjd för ~2 s per
 * fordon (sida + värdering). Avbrytbart/återupptagbart (vehicle_data är permanent).
 *
 * Kör: npx tsx scripts/enrich-vehicles.ts     Logg: data/enrich-vehicles.log
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
import { vehicleEnrichPass } from "../src/vehicle/enrich.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  let total = 0;
  let found = 0;
  for (;;) {
    const r = await vehicleEnrichPass(25, 100_000); // skanna HELA aktiva fordonsbeståndet
    total += r.looked;
    found += r.found;
    if (r.looked === 0) break; // inga fler osedda regnr i beståndet
    log(`fordon: ${total} regnr uppslagna (${found} träffar)`);
  }
  log(`KLART: ${total} regnr uppslagna, ${found} med fordonsdata.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
