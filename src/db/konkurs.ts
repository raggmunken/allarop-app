/**
 * Konkurs-flaggning: sätter items.is_konkurs för objekt vars AUKTION är en konkurs/
 * likvidation (auktionens titel/kontakt ~ konkurs/advokat/likvidation). Per-objekt-texten
 * är för gles (55 st); auktions-nivån ger ~900. Härleds periodiskt - nya objekt får NULL
 * vid ingest och flaggas här. Auktioners konkurs-status ändras sällan → bara oflaggade.
 */

import { pool } from "./pool.ts";

export interface KonkursPassResult {
  updated: number;
}

/** Flagga oflaggade aktiva objekt (is_konkurs IS NULL). Billigt; körs på intervall. */
export async function konkursPass(): Promise<KonkursPassResult> {
  const r = await pool.query(
    `UPDATE items i SET is_konkurs = EXISTS (
       SELECT 1 FROM auctions a
       WHERE a.house = i.house AND a.external_id = i.auction_external_id
         AND (a.title ILIKE '%konkurs%' OR a.contact ILIKE '%konkurs%'
              OR a.contact ILIKE '%advokat%' OR a.title ILIKE '%likvidation%')
     )
     WHERE i.status = 'active' AND i.is_konkurs IS NULL`,
  );
  return { updated: r.rowCount ?? 0 };
}
