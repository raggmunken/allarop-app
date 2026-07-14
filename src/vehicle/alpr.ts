/**
 * Node-klient mot ANPR-sidecaren (fast-alpr). Dedikerad plåtläsning slår den generella
 * vision-LLM:en rejält på fordonsskyltar (verifierat 2026-07-06: läste DDC351 ur bild 1
 * som LLM:en missade) - lokalt, gratis, inga rate-limits. Hämtar bilden i Node (bevisad
 * CDN-åtkomst) och POSTar bytes → {plate, confidence}. Node äger valideringen: regnrFrom
 * (svenskt format) + korsvalidering mot märket (makeMatches) sker i anropande kod.
 */

import { regnrFrom } from "./biluppgifter.ts";

const ALPR_URL = process.env.ALPR_URL ?? "http://localhost:8099";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
/** Under denna confidence litar vi inte på läsningen (korsvalideringen fångar resten). */
const MIN_CONF = Number(process.env.ALPR_MIN_CONF ?? 0.4);

let available: boolean | null = null;
let checkedAt = 0;

/** Är sidecaren uppe? Cachas 60 s (nere → falla tillbaka på LLM utan att spamma). */
export async function alprAvailable(): Promise<boolean> {
  if (available != null && Date.now() - checkedAt < 60_000) return available;
  checkedAt = Date.now();
  try {
    // 8s (ej 3s): under tung embedding-last köar /health bakom en pågående inferens i den
    // enprocessiga sidecaren - 3s gav falska "nere" som stoppade bakgrundspassen i onödan.
    const res = await fetch(`${ALPR_URL}/health`, { signal: AbortSignal.timeout(8000) });
    available = res.ok;
  } catch {
    available = false;
  }
  return available;
}

/**
 * Läs svensk regskylt ur en bild via ANPR-sidecaren. Null = ingen läsbar skylt, för låg
 * confidence, eller sidecar nere. regnrFrom validerar formatet (skräp → null).
 */
export async function readPlateAlpr(imageUrl: string): Promise<string | null> {
  try {
    const img = await fetch(imageUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length === 0 || buf.length > 8_000_000) return null;
    const res = await fetch(`${ALPR_URL}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { plate?: string | null; confidence?: number };
    if (!j.plate || (j.confidence ?? 0) < MIN_CONF) return null;
    return regnrFrom(j.plate);
  } catch {
    return null;
  }
}

/**
 * Generell text-OCR ur en bild (RapidOCR-endpointen) → sammanfogad text. Returnerar
 * "" när ingen text hittas (markerar "OCR:at, tomt" i kön), null vid nätfel/sidecar nere.
 * BRUSIG - används bara som sökbar signal + modell-ledtråd, aldrig visad som fakta.
 */
export async function readOcr(imageUrl: string): Promise<string | null> {
  try {
    const img = await fetch(imageUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length === 0 || buf.length > 8_000_000) return null;
    const res = await fetch(`${ALPR_URL}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { text?: string };
    return (j.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  } catch {
    return null;
  }
}
