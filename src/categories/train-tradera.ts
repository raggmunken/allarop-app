/**
 * Träna klassnings-lexikonet (learned_tokens) på Traderas märkta data - EN bunden pass.
 * Mappar Tradera-kategorinamn → vår nyckel (tradera-map, null = hoppas över) och matar
 * titel-tokens → nyckel in i samma lexikon som LLM-läraren (learned.ts). Hela klassnings-
 * pipelinen (upsert lexikon-först + llmClassifyPass steg 1) plockar upp det automatiskt.
 *
 * Återupptagbar + ingen dubbelräkning: cursor på price_history.id (job_state
 * "tradera-train"). Upsert-uppdateringar behåller id → tränas ej om; nya sålda får nytt id
 * → tränas nästa pass. Körs som CLI (loop) OCH som schemaläggarpass (växer med crawlen).
 */

import { pool } from "../db/pool.ts";
import { lexicon, tokensOf } from "./learned.ts";
import { traderaCategoryToKey } from "./tradera-map.ts";
import { getJobState, setJobState } from "../db/repo.ts";

const JOB = "tradera-train";

export interface TrainResult {
  processed: number;
  learned: number;
  skipped: number;
  done: boolean; // true = ingen mer Tradera-data att träna på just nu
}

/** Kör EN pass: träna på upp till maxRows nya Tradera-rader förbi cursorn. */
export async function trainTraderaLexiconPass(maxRows = 5000): Promise<TrainResult> {
  await lexicon.ensureLoaded();
  const cursor = (await getJobState(JOB)).cursor_offset;
  const { rows } = await pool.query<{ id: string; item_title: string; category: string | null }>(
    `SELECT id, item_title, category FROM price_history
     WHERE house='tradera' AND id > $1 ORDER BY id ASC LIMIT $2`,
    [cursor, maxRows],
  );
  if (rows.length === 0) return { processed: 0, learned: 0, skipped: 0, done: true };

  const entries: { title: string; category: string }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const key = traderaCategoryToKey(r.category);
    if (!key || !r.item_title || tokensOf(r.item_title).length === 0) { skipped++; continue; }
    entries.push({ title: r.item_title, category: key });
  }
  if (entries.length) await lexicon.learn(entries);
  const lastId = Number(rows[rows.length - 1]!.id);
  await setJobState(JOB, lastId, null, false);
  return { processed: rows.length, learned: entries.length, skipped, done: rows.length < maxRows };
}

/** Nollställ tränings-cursorn (för omträning från början). */
export async function resetTraderaTraining(): Promise<void> {
  await setJobState(JOB, 0, null, false);
}
