/**
 * Backfill: sveper REDAN lagrade aktiva 'text'-klassade objekt och flaggar
 * text/hus-konflikter som ingest-flödet (repo.ts) inte fångade eftersom de
 * ingicks INNAN konflikt-flaggan fanns. Ren JS/regex-jämförelse - ingen
 * AI-kostnad. Cursor i job_state (samma mönster som scheduler/backfill.ts);
 * när ett helt svep är klart startar nästa körning om från 0 (säkerhetsnät-
 * omkörning, inte en engångsmigrering).
 */
import { pool } from "../db/pool.ts";
import { getJobState, setJobState } from "../db/repo.ts";
import { classifyByText } from "./classify.ts";
import { houseCategoryKey } from "./houseCategory.ts";
import { detectConflict } from "./conflict.ts";

const JOB = "categorize:conflict-backfill";

export interface ConflictBackfillResult {
  scanned: number;
  flagged: number;
  doneAll: boolean;
}

export async function conflictBackfillPass(batchSize = 200): Promise<ConflictBackfillResult> {
  const state = await getJobState(JOB);
  const { rows } = await pool.query<{
    id: number; house: string; external_id: string; title: string;
    description: string | null; category: string; raw: Record<string, unknown> | null;
  }>(
    `SELECT id, house, external_id, title, description, category, raw
     FROM items
     WHERE status='active' AND category_conf='text'
     ORDER BY id
     OFFSET $1 LIMIT $2`,
    [state.cursor_offset, batchSize],
  );

  let flagged = 0;
  for (const r of rows) {
    const hc = houseCategoryKey(r.house, r.raw);
    const byText = classifyByText(r.title, r.description);
    if (byText == null) continue; // borde inte hända (conf='text' förutsätter en träff), skippa defensivt
    if (detectConflict(byText, "text", hc.key)) {
      await pool.query(`UPDATE items SET category_conflict=true WHERE id=$1`, [r.id]);
      flagged++;
    }
  }

  const doneAll = rows.length < batchSize;
  const newOffset = doneAll ? 0 : state.cursor_offset + rows.length; // klart svep → börja om
  await setJobState(JOB, newOffset, state.total, false); // 'done' hålls false - detta är en återkommande sweep, inte en engångsmigrering
  return { scanned: rows.length, flagged, doneAll };
}
