/**
 * Träna klassnings-lexikonet (learned_tokens) på Traderas märkta data - bulk (loop).
 * Kärnlogiken ligger i src/categories/train-tradera.ts (delas med schemaläggarpasset).
 *
 * Kör: npx tsx scripts/train-tradera-lexicon.ts [--reset] [--max N]
 */

import { pool } from "../src/db/pool.ts";
import { lexicon } from "../src/categories/learned.ts";
import { trainTraderaLexiconPass, resetTraderaTraining } from "../src/categories/train-tradera.ts";

async function main(): Promise<void> {
  if (process.argv.includes("--reset")) await resetTraderaTraining();
  const maxArg = process.argv.indexOf("--max");
  const maxRows = maxArg > -1 ? Number(process.argv[maxArg + 1]) : Infinity;

  await lexicon.ensureLoaded();
  const startTokens = lexicon.size();
  let processed = 0, learned = 0, skipped = 0;
  for (;;) {
    if (processed >= maxRows) break;
    const r = await trainTraderaLexiconPass(5000);
    processed += r.processed; learned += r.learned; skipped += r.skipped;
    process.stdout.write(`\r  bearbetat ${processed}  lärt ${learned}  hoppat ${skipped}   `);
    if (r.done) break;
  }
  console.log(`\nKlart. Lärt ${learned} titlar, hoppat ${skipped} (tvetydig/tom). ` +
    `Lexikon: ${startTokens} → ${lexicon.size()} tokens.`);
  await pool.end();
}

main().catch((e) => { console.error("FEL:", e); process.exit(1); });
