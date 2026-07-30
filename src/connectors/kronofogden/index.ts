/**
 * KronofogdenConnector - FlatSource. Kronofogden (Auction2000-plattformen, ~48 aktiva
 * webauktionsobjekt). Live-data (bud/startpris/nedräkning) syns BARA i en renderad
 * webbläsare → EN CloakBrowser-render av listsidan ger ALLA objekt färska (bud +
 * sluttid). Beskrivning + galleri ur objektsidan (statisk SSR, ren HTTP) berikas
 * gradvis. Hett-poll (fetchItems) återanvänder en färsk list-render (en render täcker
 * alla objekt) → billigt trots litet katalog. Inga avgifter → total = bud.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { KronofogdenClient, KronofogdenDetail, KronofogdenItem } from "./client.ts";
import { HOUSE, mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

/** Objektsidor (beskrivning/galleri, ren HTTP) att berika per svep. */
const ENRICH_PER_SWEEP = Number(process.env.KRONOFOGDEN_ENRICH_PER_SWEEP ?? 12);
const ENRICH_CONCURRENCY = Number(process.env.KRONOFOGDEN_ENRICH_CONCURRENCY ?? 4);
/** Hur länge en list-render återanvänds (hett-poll) innan vi renderar om. */
const LIST_CACHE_MS = Number(process.env.KRONOFOGDEN_LIST_CACHE_MS ?? 20_000);

export interface KronofogdenConnectorOpts {
  /** Objekt-id som redan är berikade i DB → hoppa över om-hämtning efter omstart. */
  loadEnriched?: () => Promise<Set<string>>;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export class KronofogdenConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = false;
  private readonly client = new KronofogdenClient();
  /** objekt-id → list-objekt (för fetchItems). */
  private readonly cache = new Map<string, KronofogdenItem>();
  /** objekt-id → detalj (beskrivning+galleri); berikas en gång. */
  private readonly detail = new Map<string, KronofogdenDetail | null>();
  /** Delad list-render (en render täcker alla objekt) → återanvänds kort stund. */
  private listCache: { items: KronofogdenItem[]; at: number } | null = null;
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly opts: KronofogdenConnectorOpts = {}) {}

  /** HELA katalogen (alla ~7 sidor) → uppdaterar cachen. För full refresh. */
  private async renderFull(): Promise<KronofogdenItem[]> {
    const items = await this.client.fetchList();
    for (const it of items) this.cache.set(it.objId, it);
    // Sida 1 (slutar-snart-först, 48 obj) som hett-poll-cache.
    this.listCache = { items: items.slice(0, 48), at: Date.now() };
    return items;
  }

  /** Sida 1 (slutar-snart-först) → hett-poll; återanvänd om < maxAgeMs gammal. */
  private async renderHot(maxAgeMs: number): Promise<void> {
    if (this.listCache && Date.now() - this.listCache.at < maxAgeMs) return;
    const { items } = await this.client.fetchListPage(1);
    for (const it of items) this.cache.set(it.objId, it);
    this.listCache = { items, at: Date.now() };
  }

  async fetchPage(opts: { ended?: boolean } = {}): Promise<FlatSourcePage> {
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    const items = await this.renderFull(); // full refresh → alla sidor, färsk render

    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }

    // Beskrivning + galleri ur objektsidan (ren HTTP, billigt) - gradvis.
    const fresh = items
      .filter((it) => !this.detail.has(it.objId) && !this.enrichedInDb?.has(it.objId))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      const det = await this.client.fetchDetail(it.inA, it.inO, it.objId);
      // Cacha bara lyckade berikningar; misslyckade försök försöker igen nästa svep.
      if (det && (det.images.length > 0 || det.description)) {
        this.detail.set(it.objId, det);
      }
    });

    return {
      items: items.map((it) => {
        const det = this.detail.get(it.objId) ?? null;
        const mapped = mapItem(it, det);
        // Redan berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
        // lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej).
        if (!det?.images?.length && (this.enrichedInDb?.has(it.objId) ?? false)) mapped.media = [];
        return {
          auction: mapAuction(it, det),
          item: mapped,
          bids: [], // budgivare anonyma → inga bud-rader
        };
      }),
      currentPage: 1,
      totalPages: 1,
      totalEntries: items.length,
    };
  }

  /**
   * Hett-poll: en list-render ger färskt bud + sluttid för ALLA objekt → återanvänd
   * en nyligen renderad lista (LIST_CACHE_MS) och returnera de efterfrågade objekten.
   */
  async fetchItems(
    externalIds: string[],
  ): Promise<Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>> {
    const out = new Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>();
    await this.renderHot(LIST_CACHE_MS); // sida 1 (slutar snart) → färsk live-data
    for (const id of externalIds) {
      const it = this.cache.get(id);
      if (!it) continue; // ej i listan längre → backstop finaliserar
      const det = this.detail.get(id) ?? null;
      const mapped = mapItem(it, det);
      // Se fetchPage: redan berikat i DB → rör inte sparat galleri efter omstart.
      if (!det?.images?.length && (this.enrichedInDb?.has(it.objId) ?? false)) mapped.media = [];
      out.set(id, { item: mapped, bids: [] });
    }
    return out;
  }
}
