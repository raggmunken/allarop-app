/**
 * Konflikt mellan textklassning och husets egen kategori: huvudkategorin
 * (delen före "/") skiljer sig åt. Bara relevant när text hittade en säker
 * träff (conf='text' - inte 'mixed', som är en äkta blandlåda) och huset
 * har en mappad kategori att jämföra mot.
 */
import { Confidence } from "./classify.ts";

export function topLevel(key: string | null | undefined): string | null {
  if (!key) return null;
  const i = key.indexOf("/");
  return i === -1 ? key : key.slice(0, i);
}

export function detectConflict(
  textCategory: string,
  textConfidence: Confidence,
  houseKey: string | null,
): boolean {
  if (textConfidence !== "text") return false;
  if (!houseKey) return false;
  const a = topLevel(textCategory);
  const b = topLevel(houseKey);
  if (a == null || b == null) return false;
  return a !== b;
}
