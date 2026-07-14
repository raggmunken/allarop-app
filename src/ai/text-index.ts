/**
 * Semantiskt sökindex: in-memory-index över AKTIVA objekts text-embeddings (e5-small) →
 * en sökfrågas query-vektor jämförs (cosinus) mot alla objekt-vektorer. Brute-force är
 * trivialt för <100k aktiva (384-dim prickprodukt). Indexet laddas lat och uppdateras på
 * TTL (nya embeddings trillar in via backfillen). Utgör den semantiska halvan av hybrid-
 * söken (repo.ts fuserar detta med den lexikala trigram-söken via RRF). Sidecar nere eller
 * tomt index → semanticTopK returnerar [] och söken degraderar till ren lexikal.
 */

import { pool } from "../db/pool.ts";
import { cosine, decodeVec } from "./embed.ts";
import { embedQuery } from "./embed-text.ts";

interface TextRow {
  house: string;
  external_id: string;
  vec: Float32Array;
}

const REFRESH_MS = Number(process.env.TEXT_INDEX_TTL_MS ?? 600_000); // 10 min
let index: TextRow[] = [];
let loadedAt = 0;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (Date.now() - loadedAt < REFRESH_MS && index.length > 0) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const { rows } = await pool.query<{ house: string; external_id: string; emb: Buffer }>(
        `SELECT i.house, i.external_id, i.text_embedding AS emb
         FROM items i
         WHERE i.status='active' AND (i.ends_at IS NULL OR i.ends_at > now())
           AND i.text_embedding IS NOT NULL AND octet_length(i.text_embedding) > 0`,
      );
      const next: TextRow[] = [];
      for (const r of rows) {
        const vec = decodeVec(r.emb);
        if (vec == null) continue;
        next.push({ house: r.house, external_id: r.external_id, vec });
      }
      index = next;
      loadedAt = Date.now();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export interface SemanticHit {
  house: string;
  external_id: string;
  score: number;
}

/** Antal objekt i det laddade semantiska indexet (0 = ej redo → hybrid faller till lexikal). */
export async function semanticIndexSize(): Promise<number> {
  await ensureLoaded();
  return index.length;
}

// ADAPTIV tröskel (z-score). e5:s cosinus-baslinje är FRÅGEBEROENDE: en helt orelaterad
// fråga ("dammsugare" utan dammsugare i lagret) toppar ändå på ~0,83 - en FAST tröskel
// kan inte skilja det från en äkta träff på 0,83. Men fördelningen skiljer: en äkta träff
// är en statistisk AVVIKARE högt över frågans egen brusnivå (z 4-6), medan brus toppar på
// z ~2,5-3,8. Vi behåller bara träffar med z >= SEARCH_SEM_Z → fråga utan matchning ger
// TOMT (hellre inget än fel); lexikal sök står kvar oavsett. Kalibrerat mot real data.
const SEM_Z = Number(process.env.SEARCH_SEM_Z ?? 4.0);
const SEM_ABS_FLOOR = Number(process.env.SEARCH_SEM_FLOOR ?? 0.74); // sanity-golv mot pytt-std

/**
 * Semantiskt närmaste AKTIVA objekt till en sökfråga, ADAPTIVT grindade: bara statistiska
 * avvikare (z >= SEM_Z över frågans egen poängfördelning) behålls, mest lik först. Tomt om
 * sidecarn är nere, indexet är tomt, ELLER ingen äkta träff finns (då toppar bara brus) -
 * det sista är avsiktligt (hellre inget än fel). limit kapar antalet.
 */
export async function semanticTopK(q: string, limit = 300): Promise<SemanticHit[]> {
  await ensureLoaded();
  if (index.length < 50) return []; // för lite data för meningsfull fördelning
  const qv = await embedQuery(q);
  if (qv == null) return [];
  const scores = new Float64Array(index.length);
  let sum = 0;
  for (let i = 0; i < index.length; i++) {
    const s = cosine(qv, index[i]!.vec);
    scores[i] = s;
    sum += s;
  }
  const mean = sum / index.length;
  let varSum = 0;
  for (let i = 0; i < index.length; i++) varSum += (scores[i]! - mean) ** 2;
  const std = Math.sqrt(varSum / index.length) || 1e-9;
  const cutoff = Math.max(SEM_ABS_FLOOR, mean + SEM_Z * std);
  const scored: SemanticHit[] = [];
  for (let i = 0; i < index.length; i++) {
    if (scores[i]! >= cutoff) {
      const r = index[i]!;
      scored.push({ house: r.house, external_id: r.external_id, score: scores[i]! });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
