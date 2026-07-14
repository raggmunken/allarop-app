/**
 * Text-embedding-berikning: beräkna e5-embedding på titel+beskrivning per AKTIVT objekt →
 * items.text_embedding. Driver den semantiska halvan av hybrid-söken (text-index.ts).
 * Bara aktiva objekt embeddas (söken går över aktivt lager). Batchat för genomströmning:
 * hela svepet blir ett ONNX-anrop. Gratis/lokalt (CPU), samma trickle-mönster som OCR/bild.
 */

import { pool } from "../db/pool.ts";
import { alprAvailable } from "../vehicle/alpr.ts";
import { encodeVec } from "./embed.ts";
import { embedTexts } from "./embed-text.ts";

// Sentinel = tom bytea: objektet saknar text att embedda (ingen titel) → försökt, retryas ej.
const NO_TEXT = Buffer.alloc(0);

export interface EmbedTextPassResult {
  scanned: number;
  embedded: number;
}

/** Titel + kort beskrivning → texten som embeddas (e5 trunkerar vid 256 tokens ändå). */
function itemText(title: string | null, description: string | null): string {
  const t = (title ?? "").trim();
  const d = (description ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  return d ? `${t}. ${d}` : t;
}

/**
 * En batch: välj aktiva objekt utan text_embedding, embedda titel+beskrivning i ETT anrop,
 * spara. limit = antal objekt per svep. Nyast listade först (blir sökbara snabbast).
 */
export async function embedTextPass(
  limit = Number(process.env.EMBED_TEXT_BATCH ?? 32),
): Promise<EmbedTextPassResult> {
  // scanned=-1 = sidecar nere/upptagen (SKILJT från 0 = inget jobb kvar) → bulk-seedaren
  // väntar och provar om i stället för att felaktigt tro sig klar.
  if (!(await alprAvailable())) return { scanned: -1, embedded: 0 };
  const { rows } = await pool.query<{
    house: string;
    external_id: string;
    title: string | null;
    description: string | null;
  }>(
    `SELECT i.house, i.external_id, i.title, i.description
     FROM items i
     WHERE i.status='active' AND i.text_embedding IS NULL
     ORDER BY i.listed_at DESC NULLS LAST
     LIMIT $1`,
    [limit],
  );
  if (rows.length === 0) return { scanned: 0, embedded: 0 };

  const texts = rows.map((r) => itemText(r.title, r.description));
  const vecs = await embedTexts(texts, "passage");

  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const vec = vecs[i];
    if (texts[i]!.length === 0) {
      // Ingen text alls → sentinel (retryas ej).
      await pool.query(
        `UPDATE items SET text_embedding=$3, text_embedded_at=now()
         WHERE house=$1 AND external_id=$2 AND text_embedding IS NULL`,
        [r.house, r.external_id, NO_TEXT],
      );
      embedded++;
    } else if (vec != null) {
      await pool.query(
        `UPDATE items SET text_embedding=$3, text_embedded_at=now()
         WHERE house=$1 AND external_id=$2 AND text_embedding IS NULL`,
        [r.house, r.external_id, encodeVec(vec)],
      );
      embedded++;
    }
    // annars: sidecar nere/transient → lämna NULL, prova om nästa svep
  }
  return { scanned: rows.length, embedded };
}
