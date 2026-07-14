/**
 * BukowskisConnector — implementerar FlatSource (objekt-centrerad källa).
 * Bukowskis (konst/design/smycken/ur) online-auktioner. Listsidan är server-
 * renderad och sorterad "slutar snart först" → fungerar precis som Auctionet:
 * paginerad katalog, inget per-objekt-endpoint, men `endingSortedFirst` låter
 * schemaläggaren tät-refresha sida 1 för heta lotter. BESKRIVNING (detaljsidans
 * lot-description-div: teknik, mått, skick) berikas gradvis EN gång per objekt
 * (loadEnriched-skip). Historik via finalizePastDue (inget avslutad-arkiv kopplat).
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { BukowskisClient } from "./client.ts";
import { HOUSE, mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

const ENRICH_PER_SWEEP = Number(process.env.BUKOWSKIS_ENRICH_PER_SWEEP ?? 20);
const ENRICH_CONCURRENCY = Number(process.env.BUKOWSKIS_ENRICH_CONCURRENCY ?? 4);

export interface BukowskisConnectorOpts {
  loadEnriched?: () => Promise<Set<string>>;
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
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

export class BukowskisConnector implements FlatSource {
  readonly house = HOUSE;
  // Listsidan är sorterad "slutar snart först" → sida 1 = hetast.
  readonly endingSortedFirst = true;
  // Inget avslutad-arkiv kopplat (online-lotter försvinner ur listan vid avslut).
  readonly hasEndedArchive = false;
  private readonly client = new BukowskisClient();
  private readonly details = new Map<string, string | null>();
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly opts: BukowskisConnectorOpts = {}) {}

  async fetchPage(
    opts: { ended?: boolean; page?: number } = {},
  ): Promise<FlatSourcePage> {
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    const page = await this.client.fetchListPage(opts.page ?? 1);

    // Gradvis beskrivnings-berikning (lot-description är statisk) med loadEnriched-skip.
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }
    const fresh = page.lots
      .filter((lot) => !this.details.has(lot.lotId) && !this.enrichedInDb?.has(lot.lotId))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (lot) => {
      this.details.set(lot.lotId, await this.client.fetchDetail(lot.href));
    });

    return {
      items: page.lots.map((lot) => ({
        auction: mapAuction(lot),
        item: mapItem(lot, this.details.get(lot.lotId) ?? null),
        bids: [], // Bukowskis visar budgivare anonymt → inga bud-rader
      })),
      currentPage: page.currentPage,
      totalPages: page.totalPages,
      totalEntries: page.totalEntries,
    };
  }
}
