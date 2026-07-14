/**
 * OCR-berikning: läs text UR BILDEN (modellkoder, skyltar, märken) med RapidOCR-
 * endpointen i alpr-sidecaren → items.ocr_text. Prioriterar kategorier där modellkoder
 * betyder något (verktyg/maskiner, data/elektronik, fordon). Texten är BRUSIG (aldrig
 * visad som fakta) → används som SÖKBAR signal (searchItems) + ledtråd till modell-
 * extraktionen. Skanna bara FÖRSTA bilden (hjältebilden visar oftast objektet med
 * synligt märke) - att OCR:a hela galleriet vore dyrt för liten extra vinst.
 */

import { pool } from "../db/pool.ts";
import { alprAvailable, readOcr } from "../vehicle/alpr.ts";

/** Kategori-prefix där text i bild oftast bär modellkoder (prioriteras i kön). */
const PRIORITY = ["verktyg", "elektronik", "fordon", "hem", "sport"];

export interface OcrPassResult {
  scanned: number;
  withText: number; // bilder som gav läsbar text
}

export async function ocrEnrichPass(limit = Number(process.env.OCR_ENRICH_BATCH ?? 12)): Promise<OcrPassResult> {
  if (!(await alprAvailable())) return { scanned: 0, withText: 0 };
  // Aktiva objekt som inte OCR:ats än (ocr_text IS NULL), prioriterade kategorier först,
  // med minst en bild. NULL=ej försökt, ''=försökt tomt (utesluts → kön terminerar).
  const { rows } = await pool.query<{ house: string; external_id: string; image: string }>(
    `SELECT i.house, i.external_id,
            (SELECT m.url FROM media m WHERE m.house=i.house AND m.owner_type='item'
               AND m.owner_external_id=i.external_id AND m.kind='image' AND m.url !~ '_mid\\.'
             ORDER BY m.sort NULLS LAST LIMIT 1) AS image
     FROM items i
     WHERE i.status='active' AND i.ocr_text IS NULL
     ORDER BY (i.category IS NOT NULL AND split_part(i.category,'/',1) = ANY($1::text[])) DESC,
              i.ends_at NULLS LAST
     LIMIT $2`,
    [PRIORITY, limit * 4],
  );
  const todo = rows.filter((r) => r.image != null).slice(0, limit);
  let withText = 0;
  for (const it of todo) {
    const text = await readOcr(it.image);
    if (text == null) continue; // nätfel/sidecar nere → lämna NULL, prova om
    // Även tom text lagras ('') → markerar försökt (kön terminerar).
    await pool.query(
      `UPDATE items SET ocr_text=$3 WHERE house=$1 AND external_id=$2 AND ocr_text IS NULL`,
      [it.house, it.external_id, text],
    );
    if (text.length > 0) withText++;
  }
  return { scanned: todo.length, withText };
}
