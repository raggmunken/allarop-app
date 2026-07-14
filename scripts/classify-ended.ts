/**
 * Kategorisera AVSLUTADE objekt med BILD + TEXT (historiken bakom prisjämförelsen) -
 * samma facit-kvalitet som aktiva. 99,9 % av avslutade har bild; de utan (eller med
 * ohämtbar bild) text-klassas i samma batch (classifyVisionBatch hanterar splitten).
 * AI:n sätter samtidigt lot_count (antal likadana huvudföremål - räknar i bilden).
 * Nyast avslutade först (färska priser väger tyngst). Avslutade sveps aldrig om av
 * schemaläggaren → direkta UPDATE:er är beständiga. Avbrytbart/återupptagbart.
 *
 * Kör: npx tsx scripts/classify-ended.ts     Logg: data/classify-ended.log
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
import { lexicon } from "../src/categories/learned.ts";
import { classifyVisionBatch, imageAttempted, VisionRow } from "../src/ai/classify-llm.ts";
import { currentUsage } from "../src/ai/budget.ts";

const BATCH = 10;
const WORKERS = 4;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Nästa kandidater: avslutade som ej är LLM-facit ('learned' görs OM med bild). */
async function fetchCandidates(limit: number, skip: Set<string>): Promise<VisionRow[]> {
  const { rows } = await pool.query<VisionRow>(
    `SELECT i.house, i.external_id, i.title, left(i.description, 400) AS description,
            (SELECT m.url FROM media m WHERE m.house=i.house AND m.owner_type='item'
               AND m.owner_external_id=i.external_id AND m.kind='image'
             ORDER BY m.sort NULLS LAST LIMIT 1) AS image
     FROM items i
     WHERE i.status <> 'active' AND i.title IS NOT NULL
       AND (i.category_conf IS NULL OR i.category_conf <> 'llm')
       AND NOT (i.house || '/' || i.external_id = ANY($2::text[]))
     ORDER BY i.ends_at DESC NULLS LAST
     LIMIT $1`,
    [limit, [...skip]],
  );
  return rows;
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY saknas (.env).");
    process.exit(1);
  }
  await lexicon.ensureLoaded();
  let total = 0;
  let consecFails = 0;
  const failedOnce = new Set<string>();
  for (;;) {
    // Skippa även objekt som fått vision-försök utan verdict (imageAttempted i
    // classify-llm) - annars refetchas de i evighet (spinn 2026-07-06: sista 10
    // objekten fick ogiltiga taxonominycklar → 3 700+ varv på samma batch).
    const skip = new Set([...failedOnce, ...imageAttempted]);
    const candidates = await fetchCandidates(WORKERS * BATCH * 10, skip);
    if (candidates.length === 0) break;
    const chunks: VisionRow[][] = [];
    for (let i = 0; i < candidates.length; i += BATCH) chunks.push(candidates.slice(i, i + BATCH));
    let next = 0;
    let aborted = false;
    await Promise.all(
      Array.from({ length: Math.min(WORKERS, chunks.length) }, async () => {
        for (;;) {
          if (aborted) return;
          const chunk = chunks[next++];
          if (!chunk) return;
          // Ett enstaka oväntat fel (transient DB/nätverk) får inte döda en flertimmars-
          // körning - behandla som misslyckad batch (märk + backoff) och rulla vidare.
          const r = await classifyVisionBatch(chunk).catch((e) => {
            log(`batch-fel: ${e instanceof Error ? e.message : e}`);
            return null;
          });
          if (r == null) {
            consecFails++;
            for (const c of chunk) failedOnce.add(`${c.house}/${c.external_id}`);
            if (consecFails >= 8) { aborted = true; return; }
            await new Promise((res) => setTimeout(res, 20_000));
            continue;
          }
          consecFails = 0;
          total += r.classified;
        }
      }),
    );
    const rem = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM items WHERE status <> 'active' AND title IS NOT NULL
         AND (category_conf IS NULL OR category_conf <> 'llm')`,
    );
    log(`avslutade: ${total} klassade, ~${rem.rows[0]?.n} kvar (förbrukning $${(await currentUsage()).toFixed(2)})`);
    if (aborted) { log("ihållande fel (budgettak/modeller nere) - avbryter; kör igen senare."); break; }
  }
  log(`KLART: ${total} avslutade klassade med bild+text.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
