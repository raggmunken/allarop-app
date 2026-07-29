/**
 * PSAuctionConnector - FlatSource. PS Auction (~3 900 aktiva objekt, ~197 sidor).
 * Bulk: paginerad SSR-lista /search/sida=N (kortet bär bud + EXAKT sluttid +
 * plats + bild). Live-bud + budhistorik (riktiga användarnamn) + objektsmoms ur
 * /item/json/{liveId} via in-page XHR - används för hett-poll (fetchItems) nära
 * avslut. Beskrivning + galleri ur objektsidan, berikas EN gång/objekt (gradvis).
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { PSAuctionClient, PSDetail, PSItem } from "./client.ts";
import { HOUSE, mapAuction, mapBids, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

/**
 * Objektsidor (beskrivning/galleri) att berika per LISTSIDA. Kärndatan (bud/sluttid/
 * titel/bild/totalpris) kommer ur kortet → berikning är "nice to have" och får gå
 * gradvis. Schemaläggaren sveper ~40 sidor/cykel, så håll detta lågt per sida
 * (4×40 = 160 detaljhämtningar/cykel). enrichedInDb hindrar om-hämtning efter omstart.
 */
const ENRICH_PER_SWEEP = Number(process.env.PSAUCTION_ENRICH_PER_SWEEP ?? 4);
const ENRICH_CONCURRENCY = Number(process.env.PSAUCTION_ENRICH_CONCURRENCY ?? 3);

export interface PSAuctionConnectorOpts {
  /** Objekt-id som redan är berikade i DB → hoppa över om-hämtning efter omstart. */
  loadEnriched?: () => Promise<Set<string>>;
  /**
   * Återskapa cachen (itemId→PSItem, inkl liveId) från DB:s raw->'item' för alla
   * aktiva objekt. KRITISKT för hett-pollen: PS Auction har ~197 sidor men bara 40
   * sveps/cykel → utan seed kan fetchItems bara polla objekt vars sida råkat svepas
   * den här sessionen, så objekt på osvepta sidor (och ALLA efter omstart) fryser i
   * "inaktuell" status även med 1 min kvar. Seeden gör att alla kända objekt kan pollas.
   */
  loadCache?: () => Promise<unknown[]>;
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

export class PSAuctionConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = false;
  private readonly client = new PSAuctionClient();
  /** itemId → list-kort (för fetchItems: slå ihop live-data med katalogdatan). */
  private readonly cache = new Map<string, PSItem>();
  /** itemId → detalj (beskrivning+galleri); berikas en gång. */
  private readonly detail = new Map<string, PSDetail | null>();
  /** itemId som redan är berikade i DB (seedas en gång) → hoppa över om-hämtning. */
  private enrichedInDb: Set<string> | null = null;
  /** Har cachen seedats från DB (itemId→liveId) den här sessionen? */
  private cacheSeeded = false;

  constructor(private readonly opts: PSAuctionConnectorOpts = {}) {}

  /**
   * Seed cachen (itemId→PSItem) från DB EN gång så hett-pollen når objekt vars
   * listsida inte svepts den här sessionen. Befintliga (färska) cache-poster vinner.
   */
  private async seedCache(): Promise<void> {
    if (this.cacheSeeded) return;
    this.cacheSeeded = true;
    if (!this.opts.loadCache) return;
    try {
      for (const raw of await this.opts.loadCache()) {
        const it = raw as Partial<PSItem>;
        if (it?.itemId && it?.liveId && !this.cache.has(it.itemId)) {
          this.cache.set(it.itemId, it as PSItem);
        }
      }
    } catch {
      /* DB-seed misslyckades → faller tillbaka på svep-fylld cache */
    }
  }

  async fetchPage(opts: { ended?: boolean; page?: number } = {}): Promise<FlatSourcePage> {
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    const page = opts.page ?? 1;
    await this.seedCache();
    const { items, totalPages } = await this.client.fetchListPage(page);
    for (const it of items) this.cache.set(it.itemId, it);

    // Seed (en gång): redan berikade objekt i DB → hoppa över om-hämtning av
    // objektsidan efter omstart. Bud/sluttid kommer ur kortet/live-data ändå.
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }

    // Berika beskrivning/galleri ur objektsidan (gradvis, in-memory dedup).
    const fresh = items
      .filter((it) => !this.detail.has(it.itemId) && !this.enrichedInDb?.has(it.itemId))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      this.detail.set(it.itemId, await this.client.fetchDetail(it.href, it.itemId));
    });

    return {
      items: items.map((it) => {
        const det = this.detail.get(it.itemId) ?? null;
        const mapped = mapItem(it, det);
        // Redan berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
        // lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej).
        if (!det?.images?.length && (this.enrichedInDb?.has(it.itemId) ?? false)) mapped.media = [];
        return {
          auction: mapAuction(it, det),
          item: mapped,
          bids: [], // budhistorik hämtas i hett-poll (fetchItems) ur /item/json
        };
      }),
      currentPage: page,
      totalPages,
      totalEntries: 0,
    };
  }

  /**
   * Batchad hett-poll: live-bud + exakt sluttid + budhistorik (användarnamn+id) +
   * objektsmoms ur /item/json för MÅNGA objekt i ETT browser-anrop.
   */
  async fetchItems(
    externalIds: string[],
  ): Promise<Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>> {
    const out = new Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>();
    await this.seedCache();
    const items = externalIds
      .map((id) => this.cache.get(id))
      .filter((x): x is PSItem => !!x);
    if (items.length === 0) return out;
    const live = await this.client
      .fetchLive([...new Set(items.map((it) => it.liveId))])
      .catch(() => new Map());
    for (const it of items) {
      const lv = live.get(it.liveId) ?? null;
      const det = this.detail.get(it.itemId) ?? null;
      const mapped = mapItem(it, det, lv);
      // Se fetchPage: redan berikat i DB → rör inte sparat galleri efter omstart.
      if (!det?.images?.length && (this.enrichedInDb?.has(it.itemId) ?? false)) mapped.media = [];
      out.set(it.itemId, {
        item: mapped,
        bids: mapBids(it, lv),
      });
    }
    return out;
  }
}
