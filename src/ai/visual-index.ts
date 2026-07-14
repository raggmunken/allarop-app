/**
 * Visuell bildsök: in-memory-index över AKTIVA objekts huvudbild-embeddings (DINOv2) →
 * "hitta visuellt lika objekt". Brute-force cosinus (vektorerna är L2-normaliserade →
 * prickprodukt) är trivialt för <100k aktiva. Indexet laddas lat och uppdateras på TTL
 * (nya embeddings trillar in via backfillen). Grund för framtida cross-house-dedup.
 */

import { pool } from "../db/pool.ts";
import { cosine, decodeVec } from "./embed.ts";

interface IndexRow {
  house: string;
  external_id: string;
  title: string | null;
  category: string | null;
  image: string | null;
  vec: Float32Array;
}

const REFRESH_MS = Number(process.env.VISUAL_INDEX_TTL_MS ?? 600_000); // 10 min
let index: IndexRow[] = [];
let byKey = new Map<string, IndexRow>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (Date.now() - loadedAt < REFRESH_MS && index.length > 0) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      // Huvudbildens embedding per aktivt objekt (samma bild prisjämförelsen gatar på).
      const { rows } = await pool.query<{
        house: string;
        external_id: string;
        title: string | null;
        category: string | null;
        image: string | null;
        emb: Buffer;
      }>(
        `SELECT i.house, i.external_id, i.title, i.category,
                m.url AS image, m.embedding AS emb
         FROM items i
         JOIN LATERAL (
           SELECT m.url, m.embedding FROM media m
           WHERE m.house=i.house AND m.owner_type='item' AND m.owner_external_id=i.external_id
             AND m.kind='image' AND m.embedding IS NOT NULL
           ORDER BY m.sort NULLS LAST LIMIT 1
         ) m ON true
         WHERE i.status='active' AND (i.ends_at IS NULL OR i.ends_at > now())`,
      );
      const next: IndexRow[] = [];
      const map = new Map<string, IndexRow>();
      for (const r of rows) {
        const vec = decodeVec(r.emb);
        if (vec == null) continue;
        const row: IndexRow = { house: r.house, external_id: r.external_id, title: r.title, category: r.category, image: r.image, vec };
        next.push(row);
        map.set(`${r.house}/${r.external_id}`, row);
      }
      index = next;
      byKey = map;
      loadedAt = Date.now();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export interface VisualHit {
  house: string;
  external_id: string;
  title: string | null;
  category: string | null;
  image: string | null;
  score: number;
}

/**
 * Top-N visuellt lika AKTIVA objekt till (house, id). Returnerar tomt om målet saknar
 * embedding i indexet ännu (backfillen inte hunnit). minScore filtrerar bort brus.
 */
export async function visualSimilar(
  house: string,
  id: string,
  limit = 12,
  // DINOv3 ViT-L: samma kategori 0,45-0,78, olika ~0,04 → 0,45 hittar visuellt lika
  // (samma-kategori-nivå) utan kategori-brus. Kalibrerat 2026-07-07 (var 0,3 för DINOv2).
  minScore = Number(process.env.VISUAL_SEARCH_MIN ?? 0.45),
): Promise<VisualHit[]> {
  await ensureLoaded();
  const target = byKey.get(`${house}/${id}`);
  if (!target) return [];
  const scored: VisualHit[] = [];
  for (const r of index) {
    if (r === target) continue;
    const score = cosine(target.vec, r.vec);
    if (score >= minScore) {
      scored.push({ house: r.house, external_id: r.external_id, title: r.title, category: r.category, image: r.image, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
