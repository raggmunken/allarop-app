/**
 * Retrade-klient. Retrade (retrade.eu) är en nordisk industri-/B2B-auktion med ett
 * RENT öppet JSON-API (ingen auth, curl-vänligt - ingen browser behövs):
 *   GET https://retrade.eu/api/auctions/public-list?locale=sv&page=N&pageSize=50
 *     → { auctions:[...], pagination:{ totalPages, totalItems, ... }, filters }
 *   GET https://retrade.eu/api/auctions/{id}
 *     → detalj: description, media[], status, bud, nästa minbud, märke/modell, m.m.
 *
 * Listan ger bud + EXAKT sluttid (ISO UTC) + plats + bild + titel. Detaljen ger
 * beskrivning, fullt galleri (media[].url), status (hasEnded/isSold), antal bud,
 * nästa giltiga bud, soft-close (effectiveEndAt). Köparavgiften ("auktionsavgift")
 * är en glidande skala som BARA visas vid budläggning → finns ej i API:t (external-
 * läge i avgiftsmotorn). Budgivare är anonymiserade (löpnummer) → inga bud-rader.
 */

const ORIGIN = "https://retrade.eu";
const LIST = `${ORIGIN}/api/auctions/public-list`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface RetradeListItem {
  id: string;
  heading: string;
  highestBid: number | null;
  currency: string;
  image: string | null;
  place: string | null;
  auctionEnd: string | null; // ISO UTC
}

export interface RetradeDetail {
  id: string;
  description: string | null;
  auctionEnd: string | null;
  effectiveEndAt: string | null; // soft-close-förlängd sluttid
  currency: string;
  hasEnded: boolean;
  isSold: boolean;
  highestBid: number | null;
  lowestValidBid: number | null; // nästa giltiga bud
  bidCount: number;
  brand: string | null;
  model: string | null;
  location: string | null;
  images: string[]; // media[].url (full storlek)
}

/** Ren parser: public-list-svaret → list-objekt + totalt antal sidor. */
export function parseList(json: string): { items: RetradeListItem[]; totalPages: number } {
  let o: { auctions?: unknown[]; pagination?: { totalPages?: number } };
  try {
    o = JSON.parse(json);
  } catch {
    return { items: [], totalPages: 1 };
  }
  const items = (o.auctions ?? []).map((a) => {
    const it = a as Record<string, unknown>;
    return {
      id: String(it.id),
      heading: String(it.heading ?? ""),
      highestBid: it.highestBid != null ? Number(it.highestBid) : null,
      currency: String(it.currency ?? "SEK"),
      image: it.image != null ? String(it.image) : null,
      place: it.place != null ? String(it.place) : null,
      auctionEnd: it.auctionEnd != null ? String(it.auctionEnd) : null,
    };
  });
  return { items, totalPages: o.pagination?.totalPages ?? 1 };
}

// product_information har ENGELSKA etikettnamn (API:t lokaliserar dem inte; sajten
// översätter klient-sidan). Vi översätter de vanliga till svenska, okända faller
// tillbaka på engelskan. Värdena är redan på svenska/korrekta.
const PI_GROUPS: Record<string, string> = {
  "Asset identification": "Identitet",
  "Model info": "Modell och märke",
  "Physical Description": "Fysisk beskrivning",
  Condition: "Skick",
  Payload: "Lastkapacitet",
  Certifications: "Certifieringar",
  Repairs: "Reparationer",
  "Wheel Configuration": "Hjulkonfiguration",
  "Equipment notes": "Utrustning",
  Engine: "Motor",
  Transmission: "Drivlina",
};
const PI_FIELDS: Record<string, string> = {
  VIN: "VIN",
  "Registration number": "Registreringsnummer",
  Brand: "Märke",
  Model: "Modell",
  "Year Model": "Årsmodell",
  "Production year": "Tillverkningsår",
  Width: "Bredd",
  Length: "Längd",
  Height: "Höjd",
  Weight: "Vikt",
  Color: "Färg",
  Notes: "Anteckningar",
  "Hours used": "Timmar",
  Mileage: "Mätarställning",
  "CE Label": "CE-märkning",
  "EU Inspection Date": "Besiktningsdatum",
  "EU Inspection Valid Until": "Besiktigad t.o.m.",
  "Number of axles": "Antal axlar",
  Fuel: "Drivmedel",
  Power: "Effekt",
  Engine: "Motor",
};

/** Plattar ut product_information-grupperna till läsbar svensk spec-text. */
export function productInfoText(pi: unknown): string {
  if (!Array.isArray(pi)) return "";
  const out: string[] = [];
  for (const grp of pi as Record<string, unknown>[]) {
    const items = Array.isArray(grp.items) ? (grp.items as Record<string, unknown>[]) : [];
    const lines = items
      .map((it) => {
        const v = String(it.info ?? "").trim();
        if (!v) return null;
        return `${PI_FIELDS[String(it.name)] ?? String(it.name)}: ${v}`;
      })
      .filter((x): x is string => x != null);
    if (lines.length) {
      out.push(`${PI_GROUPS[String(grp.name)] ?? String(grp.name)}\n${lines.join("\n")}`);
    }
  }
  return out.join("\n\n");
}

/** Ren parser: detalj-svaret → normaliserad detalj (galleri, status, beskrivning). */
export function parseDetail(json: string): RetradeDetail | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  if (d.id == null) return null;
  const media = Array.isArray(d.media) ? (d.media as Record<string, unknown>[]) : [];
  const images = media
    .filter((m) => m.type === "image" && m.url)
    .map((m) => String(m.url));
  const loc = d.location;
  // Beskrivning = säljarens fritext + product_information-specar (VIN, märke, mått,
  // skick, besiktning ...) så vi speglar hela "Produktinformation och tekniskt skick".
  const freeText = d.description != null ? String(d.description).trim() : "";
  const specs = productInfoText(d.product_information);
  const description = [freeText, specs].filter(Boolean).join("\n\n") || null;
  return {
    id: String(d.id),
    description,
    auctionEnd: d.auctionEnd != null ? String(d.auctionEnd) : null,
    effectiveEndAt: d.effectiveEndAt != null ? String(d.effectiveEndAt) : null,
    currency: String(d.currency ?? "SEK"),
    hasEnded: d.hasEnded === true,
    isSold: d.isSold === true,
    highestBid: d.highestBid != null ? Number(d.highestBid) : null,
    lowestValidBid: d.lowestValidBid != null ? Number(d.lowestValidBid) : null,
    bidCount: Array.isArray(d.anonymousBidList) ? d.anonymousBidList.length : 0,
    brand: d.brand != null ? String(d.brand) : null,
    model: d.model != null ? String(d.model) : null,
    location: typeof loc === "string" ? loc : (d.place != null ? String(d.place) : null),
    images,
  };
}

/** fetch med korta omförsök vid övergående nät-/rate-limit-fel (3 försök). */
async function fetchRetry(url: string, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "sv" },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class RetradeClient {
  async fetchListPage(page = 1): Promise<{ items: RetradeListItem[]; totalPages: number }> {
    const res = await fetchRetry(`${LIST}?locale=sv&page=${page}&pageSize=50`);
    if (!res.ok) throw new Error(`Retrade list HTTP ${res.status}`);
    return parseList(await res.text());
  }

  async fetchDetail(id: string | number): Promise<RetradeDetail | null> {
    try {
      const res = await fetchRetry(`${ORIGIN}/api/auctions/${id}?locale=sv`);
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return parseDetail(await res.text());
    } catch {
      return null;
    }
  }
}
