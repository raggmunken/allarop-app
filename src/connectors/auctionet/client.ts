/**
 * Auctionet-klient. Rent publikt REST/JSON-API:
 *   GET https://auctionet.com/api/v2/items.json?is_ended=&per_page=&page=&company_id=
 * Svar: { items: [...], pagination: { current_page, total_pages, total_entries } }
 *
 * Auctionet är objekt-centrerat (items direkt, ej grupperat i "parts"). Varje
 * item bär auction_id + house (husnamn) + company_id + inbäddade bud + bilder.
 */

const ORIGIN = "https://auctionet.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface AuctionetImage {
  thumb?: string;
  mini?: string;
  w640?: string;
  hd?: string;
}

export interface AuctionetBid {
  id: number;
  bidder: number; // anonymiserat heltal (ingen riktig identitet)
  amount: number;
  your_bid?: boolean;
  reserve_met?: boolean;
  auto?: boolean;
  timestamp: number; // unix-sekunder
}

export interface AuctionetItem {
  id: number;
  auction_id: number;
  company_id: number;
  house?: string;
  location?: string;
  title?: string;
  description?: string;
  condition?: string;
  currency?: string;
  estimate?: number;
  upper_estimate?: number;
  starting_bid_amount?: number;
  next_bid_amount?: number;
  reserve_met?: boolean;
  reserve_amount?: number;
  state?: string;
  hammered?: boolean;
  category_id?: number;
  ends_at?: number; // unix-sekunder
  published_at?: number;
  type?: string;
  url?: string;
  images?: AuctionetImage[];
  bids?: AuctionetBid[];
}

export interface AuctionetPage {
  items: AuctionetItem[];
  currentPage: number;
  totalPages: number;
  totalEntries: number;
}

export interface FetchOpts {
  ended?: boolean;
  page?: number;
  perPage?: number;
  /** Filtrera på ett specifikt hus (Auctionet company_id), t.ex. crafoord/sajab. */
  companyId?: number;
  /** Filtrera på toppkategori (category_id) — shardar katalogen under 10k-taket. */
  categoryId?: number;
  /** Sortering, t.ex. "recent" (senast tillagda först) för snabb upptäckt. */
  order?: string;
}

export class AuctionetClient {
  private readonly minDelayMs: number;
  private lastCallAt = 0;
  private topCats: { key: string; label: string }[] | null = null;

  constructor(opts: { minDelayMs?: number } = {}) {
    this.minDelayMs = opts.minDelayMs ?? 300;
  }

  /**
   * Toppkategoriernas id (25 st). Varje kategori har < 10 000 objekt → kan
   * pagineras helt, och tillsammans täcker de hela katalogen. Cachas per process.
   */
  async topCategories(): Promise<{ key: string; label: string }[]> {
    if (this.topCats) return this.topCats;
    await this.throttle();
    const res = await fetch(`${ORIGIN}/api/v2/categories.json`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Auctionet categories.json HTTP ${res.status}`);
    const data = (await res.json()) as
      | { id: number; name?: string; parent_id?: number | null }[]
      | { categories?: { id: number; name?: string; parent_id?: number | null }[] };
    const cats = Array.isArray(data) ? data : data.categories ?? [];
    this.topCats = cats
      .filter((c) => c.parent_id == null)
      .map((c) => ({ key: String(c.id), label: c.name ?? String(c.id) }));
    return this.topCats;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + this.minDelayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  async fetchItems(opts: FetchOpts = {}): Promise<AuctionetPage> {
    await this.throttle();
    const params = new URLSearchParams({
      is_ended: String(opts.ended ?? false),
      per_page: String(opts.perPage ?? 100),
      page: String(opts.page ?? 1),
    });
    if (opts.companyId != null) params.set("company_id", String(opts.companyId));
    if (opts.categoryId != null) params.set("category_id", String(opts.categoryId));
    if (opts.order != null) params.set("order", opts.order);

    const res = await fetch(`${ORIGIN}/api/v2/items.json?${params}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Auctionet items.json HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      items?: AuctionetItem[];
      pagination?: { current_page?: number; total_pages?: number; total_entries?: number };
    };
    return {
      items: data.items ?? [],
      currentPage: data.pagination?.current_page ?? opts.page ?? 1,
      totalPages: data.pagination?.total_pages ?? 1,
      totalEntries: data.pagination?.total_entries ?? 0,
    };
  }
}
