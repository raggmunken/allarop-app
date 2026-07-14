/**
 * NetauktionConnector - FlatSource. Netauktion (~flera hundra aktiva, ~15 sidor à 20).
 * SNABBT: (1) paginerad kort-parse → katalog, (2) ETT lättviktigt batch-anrop
 * (update_auction_status) ger bud + EXAKT total + ledare + sluttid + HEL budhistorik
 * för ALLA objekt (inga tunga objektsidor för bud!), (3) objektsidan hämtas EN gång
 * per objekt för enbart beskrivning + galleri (gradvis, cap + loadEnriched-skip).
 * Hett-poll (fetchItem) = ett enda lätt status-anrop.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { NetauktionClient, NetauktionDetail, NetauktionItem } from "./client.ts";
import { HOUSE, mapAuction, mapBids, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

/** Objektsidor (beskrivning/galleri) att berika per svep (tung ~500 kB → håll lågt). */
const ENRICH_PER_SWEEP = Number(process.env.NETAUKTION_ENRICH_PER_SWEEP ?? 40);
const ENRICH_CONCURRENCY = Number(process.env.NETAUKTION_ENRICH_CONCURRENCY ?? 3);

export interface NetauktionConnectorOpts {
  /** Objekt-id som redan är berikade (beskrivning) i DB → hoppa över om-hämtning. */
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

export class NetauktionConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = false;
  private readonly client = new NetauktionClient();
  /** productId → list-kort (för fetchItem). */
  private readonly cache = new Map<string, NetauktionItem>();
  /** productId → detalj (beskrivning+galleri); berikas en gång. */
  private readonly detail = new Map<string, NetauktionDetail | null>();
  /** productId som redan är berikade i DB (seedas en gång) → hoppa över om-hämtning. */
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly opts: NetauktionConnectorOpts = {}) {}

  async fetchPage(opts: { ended?: boolean; page?: number } = {}): Promise<FlatSourcePage> {
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    const page = opts.page ?? 1;
    const { items, totalPages } = await this.client.fetchListPage(page);
    for (const it of items) this.cache.set(it.productId, it);

    // ETT lättviktigt batch-anrop: bud + total + ledare + sluttid + budhistorik för ALLA.
    const status = await this.client
      .fetchStatus(items.map((it) => it.productId))
      .catch(() => new Map());

    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }

    // Beskrivning + galleri ur objektsidan (tung) - bara en liten batch per svep.
    const fresh = items
      .filter((it) => !this.detail.has(it.productId) && !this.enrichedInDb?.has(it.productId))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      this.detail.set(it.productId, await this.client.fetchDetail(it.slug, it.productId));
    });

    return {
      items: items.map((it) => {
        const st = status.get(it.productId) ?? null;
        const det = this.detail.get(it.productId) ?? null;
        return {
          auction: mapAuction(it, det),
          item: mapItem(it, st, det),
          bids: mapBids(it, st),
        };
      }),
      currentPage: page,
      totalPages,
      totalEntries: 0,
    };
  }

  /** Färskt läge för ETT objekt (hett-poll): ett enda lätt status-anrop. */
  async fetchItem(
    externalId: string,
  ): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const it = this.cache.get(externalId);
    if (!it) return null;
    const st = (await this.client.fetchStatus([externalId])).get(externalId) ?? null;
    const det = this.detail.get(externalId) ?? null;
    return { item: mapItem(it, st, det), bids: mapBids(it, st) };
  }
}
