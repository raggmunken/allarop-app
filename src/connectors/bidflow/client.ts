/**
 * Bidflow - DELAD auktionsplattform ("powered by bidflow.com") som driver flera
 * svenska hus (Sajab, Auktionsbyrån Effecta, Effecta Maskin, Haraldssons ...). RENT
 * JSON-RPC-API, ingen browser: POST/GET {baseUrl}/api/{Controller}/{method}. Periodiska
 * event-hus (auktion → objekt). Svar array-wrappade ([obj]); IDs "+"-prefixade → strippas.
 * Klienten parametriseras på baseUrl (per hus). Bild-konto ligger i bildens Version-fält.
 */

import { browserApi } from "../../browser/cloak.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * Bidflow-bild → imageboss-CDN. KONTOT är bildens egna Version-fält (t.ex.
 * "byraneffecta") - INTE tenantens logo-version (sajab har "byraneffecta-dev" på loggan
 * men "byraneffecta" på objektbilder; -dev ger 422). width valbar (kort ~600, full ~1600).
 */
export function imageUrl(id: string, version: string, width = 1600): string {
  const account = version || "byraneffecta";
  return `https://img.imageboss.me/${account}/width/${width}/withoutEnlargement:true/${id}`;
}

/** "+221" → "221". Bidflow prefixar numeriska id med "+". */
export function stripPlus(v: unknown): string {
  return String(v ?? "").replace(/^\+/, "");
}

/** "Gårdsauktion Brännudden-Momsfri" → "gardsauktion-brannudden-momsfri" (Bidflow-slug). */
export function slugify(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[åä]/g, "a").replace(/ö/g, "o").replace(/é/g, "e").replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface BidflowAuction {
  id: string;
  name: string;
  slug: string;
  date: string | null; // auktionens datum (start/avslut samma dag)
  status: string; // "Finished" = avslutad, annars aktiv/kommande
  active: boolean;
}

/** getProvisions-svar (förenklat): totalkostnad för ett bud + trappstegs-flagga. */
export interface BidflowProvision {
  price: number;
  total: number;
  stepped: boolean;
}

export interface BidflowLot {
  auctionId: string;
  lotId: string;
  itemId: string;
  name: string;
  currentBid: number | null;
  sold: boolean | null; // BidStatus.BiddingFinished: Sold/Unsold (null = ej avslutad)
  finished: boolean;
  reserveMet: boolean | null;
  reservePrice: number | null; // exponeras ibland (oftast null/dolt) - som Junora
  estimate: number | null;
  images: string[];
  location: string | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Lokaliserad sträng {se,en} → svensk text. */
function loc(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  const o = v as Record<string, unknown>;
  const s = (o.se ?? o.en) as string | undefined;
  return s != null ? String(s).trim() || null : null;
}

/** Ren parser: getActiveAndHistoryAuctionsCatalog-svaret → auktioner. */
export function parseAuctions(json: string): { active: BidflowAuction[]; history: BidflowAuction[] } {
  let root: { ActiveAuctions?: unknown[]; HistoryAuctions?: unknown[] };
  try {
    const j = JSON.parse(json);
    root = Array.isArray(j) ? j[0] : j;
  } catch {
    return { active: [], history: [] };
  }
  const map = (a: unknown): BidflowAuction => {
    const o = a as Record<string, unknown>;
    const id = stripPlus(o.Id);
    const name = loc((o.HeadInfo as Record<string, unknown> | undefined)?.Head) ?? `Bidflow ${id}`;
    const status = String(o.Status ?? "");
    return {
      id, name, slug: slugify(name),
      date: o.Date != null ? String(o.Date) : null,
      status, active: status !== "Finished",
    };
  };
  return {
    active: (root.ActiveAuctions ?? []).map(map),
    history: (root.HistoryAuctions ?? []).map(map),
  };
}

/** Ren parser: LotsApi/lots-svaret → objekt + totalt antal. */
export function parseLots(json: string): { lots: BidflowLot[]; total: number } {
  let root: { Total?: number; Result?: unknown[] };
  try {
    const j = JSON.parse(json);
    root = Array.isArray(j) ? j[0] : j;
  } catch {
    return { lots: [], total: 0 };
  }
  const lots = (root.Result ?? []).map((l) => {
    const o = l as Record<string, unknown>;
    const lotId = o.LotId as Record<string, unknown> | undefined;
    const bidStatus = (o.BidStatus ?? {}) as Record<string, unknown>;
    const finishedVal = bidStatus.BiddingFinished as string | undefined;
    const images = ((o.Images ?? []) as Record<string, unknown>[])
      .map((im) => imageUrl(String(im.Id ?? ""), String(im.Version ?? "")))
      .filter((u) => !u.endsWith("/"));
    const locAddr = ((o.LotLocation as Record<string, unknown> | undefined)?.Address ??
      {}) as Record<string, unknown>;
    return {
      auctionId: stripPlus(lotId?.AuctionId ?? o.AuctionId),
      lotId: stripPlus(lotId?.LotId),
      itemId: stripPlus(o.ItemId),
      name: loc(o.Name) ?? "",
      currentBid: num(o.CurrentBid),
      sold: finishedVal == null ? null : finishedVal === "Sold",
      finished: finishedVal != null,
      reserveMet: typeof o.ReservedPriceMet === "boolean" ? o.ReservedPriceMet : null,
      reservePrice: num(o.ReservedPrice),
      estimate: num(o.Estimate),
      images,
      location: loc(locAddr.Address),
    };
  });
  return { lots, total: Number(root.Total ?? lots.length) };
}

/** Ren parser: LotsApi/lotInfo-svaret → "beskrivning\n\nSkick: ..." (HTML-strippat). */
export function parseLotInfo(txt: string): string | null {
  const j = JSON.parse(txt);
  const o = (Array.isArray(j) ? j[0] : j) as Record<string, unknown>;
  const clean = (v: unknown): string =>
    String((v as { se?: string; en?: string } | null)?.se ?? (v as { en?: string } | null)?.en ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const desc = clean(o?.Description);
  const cond = clean(o?.Condition);
  const parts = [desc, cond ? `Skick: ${cond}` : ""].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

export class BidflowClient {
  /**
   * useBrowser: vissa tenants (Effecta, Haraldssons) ligger bakom bot-skydd som
   * fingeravtryckar HTTP-klienten (TLS/transport) → 401 från ren fetch trots korrekta
   * headers. Då routas anropen via CloakBrowser (browserApi: navigera en gång → in-page
   * fetch). Sajab + Effecta Maskin är oskyddade → ren fetch (snabbare).
   */
  constructor(private readonly baseUrl: string, private readonly useBrowser = false) {}

  private async post(method: string, body: unknown): Promise<string> {
    return this.call(method, "POST", JSON.stringify(body));
  }

  private async get(method: string): Promise<string> {
    return this.call(method, "GET");
  }

  private async call(method: string, httpMethod: "GET" | "POST", body?: string): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json",
      "x-remoting-proxy": "true",
    };
    if (this.useBrowser) {
      // CloakBrowser: navigera till origin (session/TLS) → in-page fetch (samma origin).
      const [text] = await browserApi(
        this.baseUrl,
        [{ path: `/api/${method}`, method: httpMethod, headers, body }],
        { sessionPath: "/", concurrency: 1 },
      );
      if (text == null) throw new Error(`Bidflow ${method} (browser) tomt svar`);
      return text;
    }
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: httpMethod,
      headers: { ...headers, "User-Agent": UA, Referer: `${this.baseUrl}/` },
      body,
    });
    if (!res.ok) throw new Error(`Bidflow ${method} HTTP ${res.status}`);
    return res.text();
  }

  /** Alla auktioner (aktiva + ~10 senaste historiska). */
  async listAuctions(): Promise<{ active: BidflowAuction[]; history: BidflowAuction[] }> {
    return parseAuctions(await this.get("IHomeInfoApi/getActiveAndHistoryAuctionsCatalog"));
  }

  /**
   * Objektets beskrivning + skick ur LotsApi/lotInfo (Description.se + Condition.se) -
   * finns INTE i lots-listan. Null vid fel/tomt.
   */
  async fetchLotInfo(auctionId: string, lotId: string): Promise<string | null> {
    try {
      return parseLotInfo(await this.post("LotsApi/lotInfo", [[{ AuctionId: auctionId, LotId: lotId }, null]]));
    } catch {
      return null;
    }
  }

  /**
   * Köparens totalkostnad för ett bud på ett objekt: LotsApi/getProvisions →
   * {Price, BuyerCommission (inkl moms), HammerFee (inkl moms), Vat (upplysning),
   * Total, BuyerIntervals/HammerFeeIntervals (trapptabeller, oftast tomma)}.
   * Villkoren är per AUKTION → används för att kalibrera en linjär avgiftsmodell.
   */
  async getProvisions(auctionId: string, lotId: string, amount: number): Promise<BidflowProvision | null> {
    try {
      const txt = await this.post("LotsApi/getProvisions", [
        [{ AuctionId: auctionId, LotId: lotId }, amount],
      ]);
      const j = JSON.parse(txt);
      const o = (Array.isArray(j) ? j[0] : j) as Record<string, unknown>;
      if (o == null || o.Total == null) return null;
      return {
        price: Number(o.Price ?? amount),
        total: Number(o.Total),
        stepped:
          ((o.BuyerIntervals as unknown[] | undefined)?.length ?? 0) > 0 ||
          ((o.HammerFeeIntervals as unknown[] | undefined)?.length ?? 0) > 0,
      };
    } catch {
      return null;
    }
  }

  /** Alla objekt i en auktion (paginerat, PageSize 100). */
  async fetchLots(auctionId: string): Promise<BidflowLot[]> {
    const out: BidflowLot[] = [];
    for (let page = 1; page <= 50; page++) {
      const body = [
        {
          Payload: { AuctionId: auctionId, Language: "se", BidAndEstimateSorting: "EndingSoonest", Criteria: [] },
          Page: page,
          PageSize: 100,
          SortBy: null,
        },
      ];
      const { lots, total } = parseLots(await this.post("LotsApi/lots", body));
      out.push(...lots);
      if (out.length >= total || lots.length === 0) break;
    }
    return out;
  }
}
