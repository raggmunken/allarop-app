/**
 * Striktare "samma objekt"-matchning för prisjämförelser (priceStats). Trigram-likhet
 * fångar liknande TEXT men inte att lotten faktiskt är jämförbar - auktionstitlar för
 * samma modell finns i många ANTAL ("stolar, 4 st" / "ett par" / enstaka) och VARIANTER
 * (Malmsten har många stolsmodeller). Fel antal/variant ger helt fel prisbild.
 *
 * Två regler ovanpå trigram-matchningen:
 *  1. ANTAL: explicit antal i titeln ("4 st", "ett par") måste STÄMMA. Mål med känt
 *     flertal matchar bara samma antal (okänt → bort). Mål utan antal (typiskt enstaka)
 *     utesluter kända flerpack.
 *  2. MODELL: citerade modellnamn i målets titel ("Lilla Åland", "Eva", "Pernilla")
 *     måste förekomma i jämförelsens titel - skiljer varianter åt.
 */

/**
 * AI-extraherade objektattribut (items.attrs, jsonb) - sätts av klassnings-passet i
 * SAMMA anrop som kategorin (b=märke, m=modell, d=designer, t=typ-substantiv, y=år,
 * mat=material). Fält som inte kan beläggas ur text/bild utelämnas (aldrig gissade).
 */
export interface ItemAttrs {
  b?: string | null;
  m?: string | null;
  d?: string | null;
  t?: string | null;
  y?: number | null;
  mat?: string | null;
  /** Svenskt regnr (fordon) - ur text eller AVLÄST PÅ SKYLTEN i bilden av vision-passet. */
  reg?: string | null;
}

const normAttr = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Två textattribut oförenliga? Bara när BÅDA finns och ingen innehåller den andra. */
function textMismatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = normAttr(a);
  const y = normAttr(b);
  return x !== y && !x.includes(y) && !y.includes(x);
}

/**
 * Attribut-gate för prisjämförelsen: avvisa par där AI-extraherade attribut BEVISAR
 * olikhet (Transit-fallet: veteranhusbil 1970 mot skåpbil 2012). Saknade fält avvisar
 * ALDRIG (hellre AI-bildgranskning än fel utslag på tunn data). Material gatar inte
 * (substring-fällan "silver"⊂"nysilver" biter åt båda håll) - bara lagrat.
 */
export function attrsCompatible(t: ItemAttrs | null | undefined, s: ItemAttrs | null | undefined): boolean {
  if (!t || !s) return true;
  if (textMismatch(t.b, s.b)) return false; // olika märken
  if (textMismatch(t.m, s.m)) return false; // olika modeller
  if (textMismatch(t.d, s.d)) return false; // olika designers
  if (textMismatch(t.t, s.t)) return false; // olika objekttyper (husbil vs skåpbil)
  if (t.y != null && s.y != null && Math.abs(t.y - s.y) > 20) return false; // olika epoker
  return true;
}

/** Explicit antal ur titeln: "4 st"/"4 stycken"/"4st." → 4, "ett par"/"1 par" → 2. Null = ej angivet. */
export function lotCount(title: string): number | null {
  const st = /(\d+)\s*(?:stycken|styck|st)\.?\b/i.exec(title);
  if (st) {
    const n = Number(st[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (/\bett\s+par\b|\b1\s+par\b|,\s*par\b|\bpar,|\bpar\s+(?=[”"“])/i.test(title)) return 2;
  return null;
}

/**
 * Citerade modell-/serienamn ur titeln: "Lilla Åland", ”String” (raka + typografiska
 * dubbelcitat; enkla apostrofer undviks - de är oftast genitiv/förkortningar).
 */
export function quotedModels(title: string): string[] {
  const out: string[] = [];
  for (const m of title.matchAll(/[”"“„]([^”"“„]{2,40})[”"“„]/g)) {
    const s = m[1]!.trim();
    if (s.length >= 2) out.push(s);
  }
  return out;
}

/**
 * Matchar något av målets citerade modellnamn i jämförelsens titel? Hela frasen är
 * ofta FÖR strikt ("EA208 Soft Pad Chair" vs historikens "Eames EA208") → per fras:
 *   - hela frasen som delsträng, ELLER
 *   - någon siffer-bärande token (modellnummer: "ea208", "p360s") ensam, ELLER
 *   - minst 60 % av frasens bokstavstokens (≥3 tecken) - "Lilla Åland" kräver båda.
 */
export function modelMatch(models: string[], sampleTitle: string): boolean {
  const lower = sampleTitle.toLowerCase();
  for (const phrase of models) {
    const p = phrase.toLowerCase();
    if (lower.includes(p)) return true;
    const tokens = p.split(/[^a-z0-9åäöé]+/).filter((t) => t.length >= 3);
    const digitToks = tokens.filter((t) => /\d/.test(t));
    if (digitToks.some((t) => lower.includes(t))) return true;
    const alpha = tokens.filter((t) => !/\d/.test(t));
    if (alpha.length > 0) {
      const hits = alpha.filter((t) => lower.includes(t)).length;
      if (hits >= Math.ceil(alpha.length * 0.6)) return true;
    }
  }
  return false;
}

/**
 * Är en såld lott jämförbar med målet? (utöver trigram-likheten)
 * - Antal: AI-räknat antal (items.lot_count - vision räknar i bilden) går FÖRE
 *   titel-regexen; känt↔känt måste vara lika; målets kända flertal kräver samma kända
 *   antal; känt flertal på ena sidan mot okänt/enstaka på andra → nej.
 * - Modell (opts.requireModel, default på): målets citerade modellnamn måste matcha
 *   (modelMatch). priceStats stänger av kravet i en ANDRA pass om den strikta svälter
 *   (<3) - auto-AI-bildgranskningen verifierar ändå varje visad träff.
 */
export function isComparable(
  targetTitle: string,
  sampleTitle: string,
  counts: { t?: number | null; s?: number | null } = {},
  opts: { requireModel?: boolean; attrs?: { t?: ItemAttrs | null; s?: ItemAttrs | null } } = {},
): boolean {
  // Attribut-gaten gäller i BÅDA passen (även loose) - bevisad olikhet i märke/modell/
  // typ/epok är aldrig jämförbar, oavsett hur svulten historiken är.
  if (!attrsCompatible(opts.attrs?.t, opts.attrs?.s)) return false;
  const t = counts.t ?? lotCount(targetTitle);
  const s = counts.s ?? lotCount(sampleTitle);
  if (t != null && t > 1) {
    if (s !== t) return false; // "4 st" jämförs BARA med "4 st"
  } else {
    // Mål = enstaka/okänt antal → uteslut kända flerpack (deras pris gäller flera).
    if (s != null && s > 1) return false;
  }
  if (opts.requireModel !== false) {
    const models = quotedModels(targetTitle);
    if (models.length > 0 && !modelMatch(models, sampleTitle)) return false;
  }
  return true;
}
