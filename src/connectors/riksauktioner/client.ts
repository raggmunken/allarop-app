/**
 * Riksauktioner-klient. Öppet JSON-API (Next.js-frontend mot separat backend):
 *   GET https://se01.riksauktioner.se/objects?page={0-baserad}&limit={n}&embed=true&includeEnded={bool}
 * Svar: { limit, page, total_items, pages, data: [ ...objekt... ] }
 *
 * Objekt-centrerat (likt Auctionet): varje objekt bär auktion, inbäddade bud
 * (bids[]) och bilder (embed.thumbnail + embed.gallery). Ren HTTP, ingen auth.
 */

const ORIGIN = "https://se01.riksauktioner.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface RiksImage {
  id?: number;
  url?: string;
  sizes?: Record<string, string>; // "1920" | "1024x1024" | "500x500" | "150x150"
}

export interface RiksBid {
  id: string; // "objId/userId/amount"
  amount: number;
  user?: number;
  username?: string;
  time?: string; // "2026-04-27 08:37:56"
  time_placed?: number; // ms epoch
  auto?: number;
}

export interface RiksMeta {
  key?: string;
  value?: string;
}

export interface RiksItem {
  id: number;
  title?: string;
  description?: string;
  auction?: number;
  auction_name?: string;
  auction_status?: string;
  seller?: number;
  category?: number;
  status?: string; // "available" = aktiv
  added?: string; // ISO — när objektet lades upp
  ending?: string; // ISO sluttid
  no_tax?: string; // "YES" = momsbefriat, "NO" = 25 % moms
  leading_bid?: number | null;
  num_bids_placed?: number;
  leading_user?: number;
  leading_username?: string;
  has_minimum_price?: boolean;
  has_passed_minimum_price?: boolean;
  auction_meta?: RiksMeta[];
  embed?: { thumbnail?: RiksImage; gallery?: RiksImage[] };
  bids?: RiksBid[];
}

export interface RiksPage {
  items: RiksItem[];
  currentPage: number; // 1-baserad (för pipeline)
  totalPages: number;
  totalEntries: number;
}

export class RiksauktionerClient {
  private readonly minDelayMs: number;
  private lastCallAt = 0;
  private catCache: Map<number, number> | null = null;

  constructor(opts: { minDelayMs?: number } = {}) {
    this.minDelayMs = opts.minDelayMs ?? 300;
  }

  /**
   * Kategorikarta id → bid_step (minsta bud). Vanligt = 50 kr; fordon/entreprenad
   * (Fordon, Bilar, Båtar, Släp, Truckar … id 22–33) = 500 kr. Cachas per process.
   */
  async categories(): Promise<Map<number, number>> {
    if (this.catCache) return this.catCache;
    await this.throttle();
    const m = new Map<number, number>();
    try {
      const res = await fetch(`${ORIGIN}/categories`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (res.ok) {
        const arr = (await res.json()) as { id?: number; bid_step?: number }[];
        for (const c of arr) {
          if (c.id != null) m.set(c.id, c.bid_step ?? 50);
        }
      }
    } catch {
      /* nätfel → tom karta, faller tillbaka på default 50 i map.ts */
    }
    this.catCache = m;
    return m;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + this.minDelayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  /** page är 1-baserad (pipeline-konvention); API:t är 0-baserat → page-1. */
  async fetchPage(opts: {
    ended?: boolean;
    page?: number;
    perPage?: number;
  } = {}): Promise<RiksPage> {
    await this.throttle();
    const limit = opts.perPage ?? 48;
    const apiPage = Math.max(0, (opts.page ?? 1) - 1);
    const params = new URLSearchParams({
      page: String(apiPage),
      limit: String(limit),
      orderBy: "position",
      order: "asc",
      embed: "true",
      includeEnded: String(opts.ended ?? false),
    });
    const res = await fetch(`${ORIGIN}/objects?${params}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Riksauktioner objects HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: RiksItem[];
      total_items?: number;
      pages?: number;
    };
    return {
      items: data.data ?? [],
      currentPage: apiPage + 1,
      totalPages: data.pages ?? 1,
      totalEntries: data.total_items ?? 0,
    };
  }

  /** Hämta ett enskilt objekts färska läge (bud + sluttid). Null om borta. */
  async fetchObject(externalId: string): Promise<RiksItem | null> {
    await this.throttle();
    const res = await fetch(`${ORIGIN}/objects/${externalId}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { data?: RiksItem } & RiksItem;
    return (d.data ?? d) as RiksItem;
  }
}
