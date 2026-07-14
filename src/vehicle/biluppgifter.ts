/**
 * Fordonsdata via biluppgifter.se (recon 2026-07-06): `/fordon/{regnr}/` är REN SSR-HTML
 * utan bot-vägg (robots.txt tillåter /fordon/) med label/value-par (`span.label`/`span.value`):
 * ägare, besiktning + mätarställning, årlig skatt, kreditköp/leasad, teknik. Sidan bär
 * även länken `/valuation/{regnr}/{estKm}/` → MARKNADSVÄRDERING (bilhandlarpris +
 * privatpris, intervall). Källa: Transportstyrelsens öppna register. Hämtas ARTIGT
 * (throttle ≥ 1 s mellan anrop) och cachas permanent per regnr (vehicle_data-tabellen).
 */

const BASE = "https://biluppgifter.se";

/** Fälten vi läser ut (allt utan inloggning; null = saknas på sidan). */
export interface VehicleData {
  regnr: string;
  /** Ur <title>: "FXH667 Peugeot 207 SW 1.6 HDi Vit 2008 - Biluppgifter.se". */
  summary: string | null;
  status: string | null; // "I Trafik" / "Avställd"
  firstRegistered: string | null;
  ownerCount: number | null;
  lastOwnerChange: string | null;
  inspectedAt: string | null; // senast besiktigad
  inspectBy: string | null; // besiktigas senast
  odometerMil: number | null; // mätarställning vid besiktning (mil)
  taxSekPerYear: number | null;
  taxMonth: string | null;
  onCredit: boolean | null; // kreditköp (belastning)
  leased: boolean | null;
  imported: boolean | null;
  horsepower: number | null;
  gearbox: string | null;
  fuel: string | null;
  fourWheelDrive: boolean | null;
  /** Värdering (intervall i kr) ur /valuation/. */
  dealerPriceMin: number | null;
  dealerPriceMax: number | null;
  privatePriceMin: number | null;
  privatePriceMax: number | null;
  /** Km-uppskattningen värderingen bygger på (ur sidans egen valuation-länk). */
  valuationKm: number | null;
  sourceUrl: string;
}

/** Svenskt regnr ur fritext: ABC123 eller ABC12D (I,Q,V,Å,Ä,Ö används ej; "ABC 123" tillåts). */
export function regnrFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /\b([A-HJ-PR-UW-Z]{3})\s?(\d{2}[\dA-HJ-PR-UW-Z])\b/.exec(text.toUpperCase());
  if (!m) return null;
  const reg = `${m[1]}${m[2]}`;
  // Tre lika bokstäver + "000" är oftast mönster/platshållare, inte riktiga skyltar.
  return /^(.)\1\1/.test(reg) && /000/.test(reg) ? null : reg;
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Alla label/value-par ur fordonssidan. Två markup-former: listrader
 * `span.label`+`span.value` och info-tiles `<em>VÄRDE</em><span>ETIKETT</span>`
 * (Hästkrafter, Växellåda m.fl. i topp-panelen).
 */
function labelValues(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<span class="label">([\s\S]*?)<\/span>\s*<span class="value">([\s\S]*?)<\/span>/g)) {
    const label = decode(m[1]!.replace(/<[^>]+>/g, " "));
    const value = decode(m[2]!.replace(/<[^>]+>/g, " "));
    if (label && value && !out.has(label)) out.set(label, value);
  }
  for (const m of html.matchAll(/<em>([^<]{1,60})<\/em>\s*<span>([^<]{1,60})<\/span>/g)) {
    const label = decode(m[2]!);
    const value = decode(m[1]!);
    if (label && value && !out.has(label)) out.set(label, value);
  }
  return out;
}

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const yesNo = (s: string | undefined): boolean | null =>
  s == null ? null : /^ja/i.test(s) ? true : /^nej/i.test(s) ? false : null;
const date = (s: string | undefined): string | null => {
  const m = s != null ? /\d{4}-\d{2}-\d{2}/.exec(s) : null;
  return m ? m[0] : null;
};

/** Ren parser: fordonssidans HTML → VehicleData (utan värdering; den fylls separat). */
export function parseVehiclePage(regnr: string, html: string): VehicleData | null {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  // "Hittade inget fordon" / omdirigering → sidan finns inte.
  if (!title.toUpperCase().includes(regnr.toUpperCase())) return null;
  const lv = labelValues(html);
  const valM = new RegExp(`valuation/${regnr.toLowerCase()}/(\\d+)`, "i").exec(html);
  return {
    regnr: regnr.toUpperCase(),
    summary: decode(title.replace(/\s*-\s*Biluppgifter\.se\s*$/i, "")) || null,
    status: lv.get("Status") ?? null,
    firstRegistered: date(lv.get("Först registrerad")),
    ownerCount: num(lv.get("Antal ägare")),
    lastOwnerChange: date(lv.get("Senaste ägarbyte")),
    inspectedAt: date(lv.get("Senast besiktigad")),
    inspectBy: date(lv.get("Besiktigas senast")),
    odometerMil: num(lv.get("Mätarställning (besiktning)")),
    taxSekPerYear: num(lv.get("Årlig skatt")),
    taxMonth: lv.get("Skattemånad") ?? null,
    onCredit: yesNo(lv.get("Kreditköp")),
    leased: yesNo(lv.get("Leasad")),
    imported: yesNo(lv.get("Import / Införsel")),
    horsepower: num(lv.get("Hästkrafter")),
    gearbox: lv.get("Växellåda") ?? null,
    fuel: lv.get("Drivmedel") ?? lv.get("Bränsle") ?? null,
    fourWheelDrive: yesNo(lv.get("Fyrhjulsdrift")),
    dealerPriceMin: null,
    dealerPriceMax: null,
    privatePriceMin: null,
    privatePriceMax: null,
    valuationKm: valM ? Number(valM[1]) : null,
    sourceUrl: `${BASE}/fordon/${regnr.toLowerCase()}/`,
  };
}

/** Ren parser: värderingssidan → prisintervall ("<h4>Bilhandlarpris:</h4>...<em>21 000 - 23 000 kr</em>"). */
export function parseValuation(html: string): {
  dealerMin: number | null; dealerMax: number | null;
  privateMin: number | null; privateMax: number | null;
} {
  const range = (label: string): [number | null, number | null] => {
    const m = new RegExp(`<h4>${label}:?</h4>[\\s\\S]{0,300}?<em>([^<]+)</em>`, "i").exec(html);
    if (!m) return [null, null];
    const nums = [...decode(m[1]!).matchAll(/[\d ]{2,}/g)].map((x) => num(x[0])).filter((n): n is number => n != null);
    if (nums.length === 0) return [null, null];
    return [nums[0]!, nums[1] ?? nums[0]!];
  };
  const [dealerMin, dealerMax] = range("Bilhandlarpris");
  const [privateMin, privateMax] = range("Privatpris");
  return { dealerMin, dealerMax, privateMin, privateMax };
}

/**
 * HÄMTNING: Cloudflare TLS-fingeravtryckar HTTP-klienten (Node-fetch → 403 "Just a
 * moment" trots att curl råkar passera) → CloakBrowser-mönstret (som Blinto/Effecta):
 * navigera origin EN gång per batch, kör alla GET som in-page-fetch (~200-300 ms/st,
 * bär den godkända sessionens cookies). Samtidighet 2 = artigt.
 *
 * Tri-state per regnr: VehicleData = träff; "notfound" = ÄKTA miss (riktig
 * biluppgifter-sida utan fordonet) → cachas permanent; null = transient
 * (challenge/nätfel) → cachas EJ, provas om nästa svep.
 */
export type VehicleLookup = VehicleData | "notfound" | null;

export async function fetchVehiclesBatch(regnrs: string[]): Promise<Map<string, VehicleLookup>> {
  const out = new Map<string, VehicleLookup>();
  if (regnrs.length === 0) return out;
  const { browserApi } = await import("../browser/cloak.ts");
  const pages = await browserApi(
    BASE,
    regnrs.map((r) => ({ path: `/fordon/${r.toLowerCase()}/`, headers: { Accept: "text/html" } })),
    { sessionPath: "/", concurrency: 2 },
  );
  const valPaths: { reg: string; path: string }[] = [];
  for (let i = 0; i < regnrs.length; i++) {
    const reg = regnrs[i]!;
    const html = pages[i];
    if (html == null) {
      out.set(reg, null);
      continue;
    }
    const v = parseVehiclePage(reg, html);
    if (v != null) {
      out.set(reg, v);
      if (v.valuationKm != null) valPaths.push({ reg, path: `/valuation/${reg.toLowerCase()}/${v.valuationKm}/` });
    } else {
      // Äkta miss bara om svaret är en riktig biluppgifter-sida (inte challenge).
      out.set(reg, /biluppgifter/i.test(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "") ? "notfound" : null);
    }
  }
  if (valPaths.length > 0) {
    const vals = await browserApi(
      BASE,
      valPaths.map((v) => ({ path: v.path, headers: { Accept: "text/html" } })),
      { sessionPath: "/", concurrency: 2 },
    );
    for (let i = 0; i < valPaths.length; i++) {
      const html = vals[i];
      const v = out.get(valPaths[i]!.reg);
      if (html == null || v == null || v === "notfound") continue;
      const val = parseValuation(html);
      v.dealerPriceMin = val.dealerMin;
      v.dealerPriceMax = val.dealerMax;
      v.privatePriceMin = val.privateMin;
      v.privatePriceMax = val.privateMax;
    }
  }
  return out;
}
