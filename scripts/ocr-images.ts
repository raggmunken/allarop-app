/**
 * Bulk-OCR av aktiva objekts bilder (RapidOCR via alpr-sidecaren) → items.ocr_text.
 * Ikappkörning; löpande sköts av schemaläggaren (ocrEnrichPass). Prioriterar
 * kategorier med modellkoder (verktyg/elektronik/fordon). Gratis/lokalt (ingen
 * OpenRouter) - bara CPU-tid. Avbrytbart/återupptagbart (ocr_text NULL = ej gjort).
 *
 * Kör: ALPR_URL=http://localhost:8099 npx tsx scripts/ocr-images.ts   Logg: data/ocr-images.log
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
import { ocrEnrichPass } from "../src/ai/ocr-enrich.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  let scanned = 0;
  let withText = 0;
  for (;;) {
    const r = await ocrEnrichPass(24);
    if (r.scanned === 0) break; // inga fler oskannade aktiva objekt
    scanned += r.scanned;
    withText += r.withText;
    if (scanned % 240 === 0) log(`ocr: ${scanned} bilder, ${withText} med text`);
  }
  log(`KLART: ${scanned} bilder OCR:ade, ${withText} med text.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
