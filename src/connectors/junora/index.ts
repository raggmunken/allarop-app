/**
 * JunoraConnector - FlatSource. Junora (~362 aktiva + ~296 avslutade, .NET-auktionsmotor
 * bakom Shopify). RENT öppet JSON-API → bulk ur /api/auctions (snabbt, ingen browser).
 * Galleri + rik beskrivning + startbud berikas EN gång/objekt ur Shopify product.json +
 * auktionsdetaljen (gradvis). Avslutade objekt (statusFilter=Closed) backfillas till
 * historik. Hett-poll (fetchItem) = ett lätt /api/auction/{slug}-anrop. Avgift = external.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { JunoraClient, JunoraDetail, JunoraListItem } from "./client.ts";
import { HOUSE, mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

const PAGE_SIZE = 50;
/** Objektsidor (galleri+beskrivning, ren HTTP) att berika per LISTSIDA. */
const ENRICH_PER_SWEEP = Number(process.env.JUNORA_ENRICH_PER_SWEEP ?? 25);
const ENRICH_CONCURRENCY = Number(process.env.JUNORA_ENRICH_CONCURRENCY ?? 5);

export interface JunoraConnectorOpts {
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

export class JunoraConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = true; // statusFilter=Closed → backfill till historik
  private readonly client = new JunoraClient();
  /** remoteId → list-objekt (för fetchItem; har slug). */
  private readonly cache = new Map<string, JunoraListItem>();
  /** remoteId → detalj (galleri+beskrivning+startbud); berikas en gång. */
  private readonly detail = new Map<string, JunoraDetail | null>();
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly opts: JunoraConnectorOpts = {}) {}

  async fetchPage(opts: { ended?: boolean; page?: number } = {}): Promise<FlatSourcePage> {
    const page = opts.page ?? 1;
    const ended = opts.ended ?? false;
    const { items, total } = await this.client.fetchListPage(page, ended);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Avslutade objekt: ingen berikning (de finaliseras till historik) - mappa rakt.
    if (ended) {
      return {
        items: items.map((it) => ({ auction: mapAuction(it), item: mapItem(it), bids: [] })),
        currentPage: page,
        totalPages,
        totalEntries: total,
      };
    }

    for (const it of items) this.cache.set(it.remoteId, it);
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }

    // Berika galleri + beskrivning + startbud ur Shopify/auktionsdetalj (gradvis).
    const fresh = items
      .filter((it) => !this.detail.has(it.remoteId) && !this.enrichedInDb?.has(it.remoteId))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      this.detail.set(it.remoteId, await this.client.fetchDetail(it.slug));
    });

    return {
      items: items.map((it) => {
        const det = this.detail.get(it.remoteId) ?? null;
        const mapped = mapItem(it, det);
        // Redan berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
        // lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej).
        if (!det?.images?.length && (this.enrichedInDb?.has(it.remoteId) ?? false)) mapped.media = [];
        return { auction: mapAuction(it, det), item: mapped, bids: [] };
      }),
      currentPage: page,
      totalPages,
      totalEntries: total,
    };
  }

  /** Färskt läge för ETT objekt (hett-poll): bud + sluttid ur /api/auction/{slug}. */
  async fetchItem(
    externalId: string,
  ): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const it = this.cache.get(externalId);
    if (!it) return null; // okänt (t.ex. efter omstart) → backstop finaliserar
    const live = await this.client.fetchLive(it.slug);
    if (live) {
      if (live.currentPrice != null) it.currentPrice = live.currentPrice;
      if (live.endTimeUtc != null) it.endTimeUtc = live.endTimeUtc;
      it.numBids = live.numBids;
    }
    return { item: mapItem(it, this.detail.get(externalId) ?? null), bids: [] };
  }
}
