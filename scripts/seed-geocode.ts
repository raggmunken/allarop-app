/** Bulk-geokodning: slå upp alla aktiva orter → lat/lon (Nominatim, 1,1s/ort). ~600 orter
 * ≈ 11 min engång, cachas permanent. Löpande sköts av schemaläggaren (geocodePass).
 * Kör: npx tsx scripts/seed-geocode.ts */
import { readFileSync } from "node:fs";
try { for (const line of readFileSync(".env", "utf8").split("\n")) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !line.trim().startsWith("#") && process.env[m[1]!] == null) process.env[m[1]!] = m[2]!; } } catch { /* */ }
import { pool } from "../src/db/pool.ts";
import { geocodePass } from "../src/geo/geocode.ts";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main(): Promise<void> {
  let scanned = 0, resolved = 0;
  for (;;) {
    const r = await geocodePass(20);
    if (r.scanned === 0) break;
    scanned += r.scanned; resolved += r.resolved;
    log(`geokod: ${scanned} orter, ${resolved} hittade`);
  }
  log(`KLART: ${scanned} orter, ${resolved} hittade.`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
