/**
 * Backfill av AI-attribut (items.attrs: märke/modell/designer/typ/år/material) för
 * objekt klassade INNAN attribut-extraktionen fanns i klassnings-prompten. TEXT-ONLY
 * (titel + beskrivning, inga bildtokens → ~1/4 av vision-kostnaden). Nya objekt får
 * attrs automatiskt via klassnings-passet - detta script är engångs-ikappkörning.
 *
 * Ordning: AKTIVA först (målen användare öppnar), sedan avslutade NYAST först (färska
 * priser väger tyngst i jämförelsen). attrs='{}' = försökt men inget belagt (skiljer
 * från NULL = ej försökt) → avbrytbart/återupptagbart utan om-hämtning. Budgetvakten
 * flippar automatiskt till gratismodeller vid AI_USAGE_MAX_USD-taket.
 *
 * Kör: npx tsx scripts/enrich-attrs.ts     Logg: data/enrich-attrs.log
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
import { buildAttrsPrompt, callLlm, parseAttrsResponse } from "../src/ai/classify-llm.ts";
import { currentUsage } from "../src/ai/budget.ts";

const BATCH = 25; // text-only utan taxonomi → större batchar än vision-passets 10
const WORKERS = 4;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface Row {
  house: string;
  external_id: string;
  title: string;
  description: string | null;
}

/** Nästa kandidater utan attrs: aktiva först, sedan avslutade nyast först. */
async function fetchCandidates(limit: number, skip: Set<string>): Promise<Row[]> {
  // OCR-texten (modellkoder avlästa i bild) läggs som ledtråd efter beskrivningen -
  // hjälper LLM:en fånga modellkoder som inte står i annonstexten.
  const { rows } = await pool.query<Row>(
    `SELECT house, external_id, title,
            left(coalesce(description,'') ||
                 CASE WHEN coalesce(ocr_text,'') <> '' THEN ' [text i bild: ' || ocr_text || ']' ELSE '' END,
                 600) AS description
     FROM items
     WHERE attrs IS NULL AND title IS NOT NULL
       AND NOT (house || '/' || external_id = ANY($2::text[]))
     ORDER BY (status = 'active') DESC, ends_at DESC NULLS LAST
     LIMIT $1`,
    [limit, [...skip]],
  );
  return rows;
}

async function remaining(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) n FROM items WHERE attrs IS NULL AND title IS NOT NULL`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY saknas (.env).");
    process.exit(1);
  }
  let total = 0;
  let withFields = 0;
  let consecFails = 0;
  const failedOnce = new Set<string>();
  for (;;) {
    const candidates = await fetchCandidates(WORKERS * BATCH * 10, failedOnce);
    if (candidates.length === 0) break;
    const chunks: Row[][] = [];
    for (let i = 0; i < candidates.length; i += BATCH) chunks.push(candidates.slice(i, i + BATCH));
    let next = 0;
    let aborted = false;
    await Promise.all(
      Array.from({ length: Math.min(WORKERS, chunks.length) }, async () => {
        for (;;) {
          if (aborted) return;
          const chunk = chunks[next++];
          if (!chunk) return;
          const text = await callLlm(
            buildAttrsPrompt(chunk.map((r) => ({ title: r.title, desc: r.description }))),
          ).catch(() => null);
          if (text == null) {
            consecFails++;
            for (const c of chunk) failedOnce.add(`${c.house}/${c.external_id}`);
            if (consecFails >= 8) { aborted = true; return; }
            await new Promise((res) => setTimeout(res, 20_000));
            continue;
          }
          consecFails = 0;
          const verdicts = parseAttrsResponse(text, chunk.length);
          for (let i = 0; i < chunk.length; i++) {
            const r = chunk[i]!;
            const attrs = verdicts.get(i);
            if (attrs == null) {
              // Inget verdikt för raden (trunkerat svar) → hoppa denna körning.
              failedOnce.add(`${r.house}/${r.external_id}`);
              continue;
            }
            // '{}' skrivs också - markerar "försökt, inget belagt" (terminering).
            await pool.query(
              `UPDATE items SET attrs=$3::jsonb WHERE house=$1 AND external_id=$2 AND attrs IS NULL`,
              [r.house, r.external_id, JSON.stringify(attrs)],
            );
            total++;
            if (Object.keys(attrs).length > 0) withFields++;
          }
        }
      }),
    );
    log(`attrs: ${total} satta (${withFields} med fält), ~${await remaining()} kvar (förbrukning $${(await currentUsage()).toFixed(2)})`);
    if (aborted) { log("ihållande fel (nyckel/modeller nere) - avbryter; kör igen senare."); break; }
  }
  log(`KLART: ${total} objekt attribut-försökta (${withFields} med belagda fält).`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
