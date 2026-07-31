/**
 * Hus-kategori-lager (LAGER 2) - används BARA som fallback när vår egen textklassning (lager 1)
 * inte hittar något. Extraherar husets egna kategori ur raw och mappar den till vår taxonomi.
 * Auctionet: category_id via autogenererad karta. Övriga: läsbar etikett → mappas via vår egen
 * klassificerare (etiketter är rena) + ett litet tillägg för bara-ord-etiketter.
 */

import { classifyByText, PARTIER } from "./classify.ts";
import { AUCTIONET_CATEGORY_MAP } from "./auctionet-map.ts";
import { traderaCategoryById, traderaCategoryToKey } from "./tradera-map.ts";

const BUDI: Record<string, string> = {
  "construction-home": "bygg/byggmaterial",
  cars: "fordon/personbilar",
  "leisure-electronics": "elektronik/ljud-bild-tv",
  construction: "entreprenad/gravmaskin-lastare",
  "forestry-agriculture": "lantbruk/traktor",
  transport: "fordon/lastbil-buss",
  "caravan-motorhome": "fordon/husbil-husvagn",
  "business-operations": "restaurang/butik",
  vehicle: "fordon/personbilar",
  it: "elektronik/datorer",
};

/** Tillägg för bara-ord-etiketter (kategorinamn) som titel-klassaren inte fångar. */
const LABEL: [RegExp, string][] = [
  [/personbil|\bbilar\b/, "fordon/personbilar"],
  [/lastbil|\btransport\b/, "fordon/lastbil-buss"],
  [/\bkonst\b/, "konst/konst-tavlor"],
  [/m[öo]bler/, "mobler/mobler-sub"],
  [/smycken/, "smycken/smycken-sub"],
  [/elektronik|\bdata\b|\bit\b/, "elektronik/datorer"],
  [/entreprenad/, "entreprenad/gravmaskin-lastare"],
  [/lantbruk|jordbruk/, "lantbruk/traktor"],
  [/skogsbruk|\bskog\b/, "lantbruk/skogsmaskin"],
  [/\bverktyg\b/, "verktyg/handverktyg"],
  [/hush[åa]ll/, "hem/husgerad-kok"],
  [/kl[äa]der|\bmode\b/, "klader/klader-skor"],
  [/\bbygg\b|\bhem\b/, "bygg/byggmaterial"],
  [/fritid|elektronik/, "elektronik/ljud-bild-tv"],
  [/aff[äa]rs|butik|kontor/, "restaurang/butik"],
];

/** Etikett (t.ex. "Trädgårdsmaskiner", "Bilar") → taxonomi-nyckel. Null om okänd. */
function mapLabel(label?: string | null): string | null {
  if (!label || label.length < 2) return null;
  const byText = classifyByText(label);
  if (byText && byText !== PARTIER) return byText;
  const l = ` ${label.toLowerCase()} `;
  for (const [re, k] of LABEL) if (re.test(l)) return k;
  return null;
}

function nested(raw: Record<string, unknown>): Record<string, unknown> {
  const it = raw.item as Record<string, unknown> | undefined;
  return it && typeof it === "object" ? it : raw;
}

/**
 * Husets egna kategori mappad till vår taxonomi + rå-etiketten (för catch-all-koll i classify).
 * Returnerar {key:null} för hus utan användbar kategori (då styr titel-lagret + Övrigt).
 */
export function houseCategoryKey(house: string, raw: Record<string, unknown> | null | undefined): {
  key: string | null;
  raw: string | null;
} {
  if (!raw) return { key: null, raw: null };
  if (house === "auctionet") {
    const id = raw.category_id != null ? String(raw.category_id) : "";
    return { key: AUCTIONET_CATEGORY_MAP[id] ?? null, raw: id || null };
  }
  const o = nested(raw);
  if (house === "budi") {
    const c = String(o.category ?? "");
    return { key: BUDI[c] ?? mapLabel(c), raw: c || null };
  }
  if (house === "vaxxa") {
    // Typesense: subcategory är finkornig, category grov. Prova finkornig först.
    const sub = (o as { subcategory?: string }).subcategory;
    const label = String(sub ?? o.category ?? "");
    return { key: mapLabel(label), raw: label || null };
  }
  if (house === "klaravik") {
    const label = String((o as { categoryNameLevel1?: string }).categoryNameLevel1 ?? "");
    return { key: mapLabel(label), raw: label || null };
  }
  if (house === "tradera") {
    // Traderas EGEN kategori är den starkaste signalen: löv-namn (categoryName, från
    // full-crawlen) först, annars rot-id → rot-namn (snabbsvepet) → samma regelkarta.
    const o = nested(raw);
    const name = String((o as { categoryName?: string }).categoryName ?? "");
    if (name) return { key: traderaCategoryToKey(name), raw: name };
    const id = Number((o as { categoryId?: unknown }).categoryId);
    const key = traderaCategoryById(Number.isFinite(id) ? id : null);
    return { key, raw: key ? String(id) : null };
  }
  // Hus-typ-default: Pantbanken (pantbank) är ~95 % smycken/silver/klockor → oklassat = smycken.
  if (house === "pantbanken") return { key: "smycken/smycken-sub", raw: "pantbank" };
  return { key: null, raw: null };
}
