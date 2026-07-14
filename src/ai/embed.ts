/**
 * Bild-embeddings via alpr-sidecarens /embed (DINOv2-small, 384-dim, rent visuell).
 * Används som VISUELL JÄMFÖRBARHETSGATE i prisjämförelsen/fynd-motorn: en kandidat är
 * bara jämförbar om dess bild är visuellt lik målets (cosinus-likhet över tröskel) -
 * fixar hög-varians-kategorier (smycken/konst/skrot) där titel-matchning inte räcker.
 * Vektorerna L2-normaliseras server-side → cosinus == prickprodukt. Lagras som little-
 * endian float32-bytea i media.embedding (ingen pgvector; priceStats kapar vid 150).
 */

import { alprAvailable } from "../vehicle/alpr.ts";

const ALPR_URL = process.env.ALPR_URL ?? "http://localhost:8099";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
/** DINOv3 ViT-L/16 = 1024-dim (env-override om modellen byts). */
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 1024);

export { alprAvailable };

/** Hämta bild i Node (bevisad CDN-åtkomst) → POSTa bytes → 384-dim embedding. Null vid fel. */
/** Hämta bild-bytes i Node (bevisad CDN-åtkomst). imageFailed=true → död URL/404/för stor
 * (meningslöst att prova om); false + buf=null används ej (fetch kastar → true). */
async function fetchImageBytes(url: string): Promise<{ buf: Buffer | null; imageFailed: boolean }> {
  try {
    const img = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(Number(process.env.IMAGE_FETCH_TIMEOUT_MS ?? 8_000)) });
    if (!img.ok) return { buf: null, imageFailed: true };
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length === 0 || buf.length > 8_000_000) return { buf: null, imageFailed: true };
    return { buf, imageFailed: false };
  } catch {
    return { buf: null, imageFailed: true }; // CDN-hämtning misslyckades → bilden är problemet
  }
}

/** vec = embedding. imageFailed=true → BILDEN gick ej att hämta (död URL/404/för stor) →
 * meningslöst att prova om (backfillen sätter en sentinel). imageFailed=false + vec=null
 * → SIDECAR-problem (nere/timeout) → transient, prova om senare. */
export async function embedImageResult(url: string): Promise<{ vec: Float32Array | null; imageFailed: boolean }> {
  const { buf, imageFailed } = await fetchImageBytes(url);
  if (buf == null) return { vec: null, imageFailed };
  try {
    const res = await fetch(`${ALPR_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { vec: null, imageFailed: false }; // sidecar-fel → transient
    const j = (await res.json()) as { dim?: number; embedding?: number[] | null };
    if (j.dim !== EMBED_DIM || !Array.isArray(j.embedding) || j.embedding.length !== EMBED_DIM) {
      return { vec: null, imageFailed: false };
    }
    return { vec: Float32Array.from(j.embedding), imageFailed: false };
  } catch {
    return { vec: null, imageFailed: false }; // sidecar timeout/nätfel → transient
  }
}

/**
 * BATCHA en grupp bild-URL:er: hämta alla parallellt, embedda i ETT sidecar-anrop
 * (/embed-batch amortiserar DINOv2-overhead → mycket snabbare på CPU än en i taget).
 * Returnerar {vec, imageFailed} i samma ordning som urls. Sidecar nere/batch-fel → alla
 * med lyckad hämtning får vec=null, imageFailed=false (transient, prova om nästa svep).
 */
export async function embedImagesBatch(
  urls: string[],
): Promise<{ vec: Float32Array | null; imageFailed: boolean }[]> {
  const fetched = await Promise.all(urls.map(fetchImageBytes));
  const out = fetched.map((f) => ({ vec: null as Float32Array | null, imageFailed: f.imageFailed }));
  const b64: string[] = [];
  const slots: number[] = [];
  fetched.forEach((f, i) => {
    if (f.buf != null) {
      b64.push(f.buf.toString("base64"));
      slots.push(i);
    }
  });
  if (b64.length === 0) return out;
  try {
    const res = await fetch(`${ALPR_URL}/embed-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: b64 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return out; // sidecar-fel → transient (vec kvar null, imageFailed false)
    const j = (await res.json()) as { dim?: number; embeddings?: (number[] | null)[] };
    if (j.dim !== EMBED_DIM || !Array.isArray(j.embeddings) || j.embeddings.length !== b64.length) {
      return out; // oväntat svar → transient
    }
    j.embeddings.forEach((e, k) => {
      const slot = slots[k]!;
      if (Array.isArray(e) && e.length === EMBED_DIM) {
        out[slot]!.vec = Float32Array.from(e);
      } else {
        out[slot]!.imageFailed = true; // hämtades men gick ej att avkoda → sentinel
      }
    });
  } catch {
    return out; // sidecar timeout → transient
  }
  return out;
}

export async function embedImage(url: string): Promise<Float32Array | null> {
  return (await embedImageResult(url)).vec;
}

/** Float32Array → little-endian bytea (numpy float32 tobytes-kompatibel på x86). */
export function encodeVec(v: Float32Array): Buffer {
  const b = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i]!, i * 4);
  return b;
}

/** bytea → Float32Array. Null/fel längd → null (skyddar mot skräp i kolumnen). */
export function decodeVec(buf: Buffer | null | undefined): Float32Array | null {
  if (buf == null || buf.length === 0 || buf.length % 4 !== 0) return null;
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Cosinus-likhet = prickprodukt (vektorerna är redan L2-normaliserade). Olika längd → 0. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
