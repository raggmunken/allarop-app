/**
 * AuctionetConnector — implementerar FlatSource (objekt-centrerad källa).
 * Täcker Auctionet OCH dess medlemshus via company_id (t.ex. crafoord, sajab).
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { AuctionetClient } from "./client.ts";
import { HOUSE, mapAuction, mapBid, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

export class AuctionetConnector implements FlatSource {
  readonly house = HOUSE;
  // Auctionet har en avslutad-feed (items.json?is_ended=true) med slutpriser →
  // backfillas för historik (mer exakt än at-expiry-konvertering).
  readonly hasEndedArchive = true;
  // items.json är sorterad "slutar snart först" → vi kan tät-refresha sida 1 för
  // att hålla heta objekt färska trots avsaknad av per-objekt-endpoint.
  readonly endingSortedFirst = true;
  private readonly client = new AuctionetClient();

  /** Shardar via toppkategori → kan nå hela katalogen (kringgår 10k-taket). */
  async listShards(): Promise<{ key: string; label?: string }[]> {
    return this.client.topCategories();
  }

  async fetchPage(opts: {
    ended?: boolean;
    page?: number;
    perPage?: number;
    companyId?: number;
    shard?: string;
  } = {}): Promise<FlatSourcePage> {
    const ended = opts.ended ?? false;
    const page = await this.client.fetchItems({
      ended: opts.ended,
      page: opts.page,
      perPage: opts.perPage,
      companyId: opts.companyId,
      categoryId: opts.shard != null ? Number(opts.shard) : undefined,
    });
    return {
      items: page.items.map((it) => ({
        auction: mapAuction(it),
        item: mapItem(it, ended),
        bids: (it.bids ?? []).map((b) => mapBid(b, it.id)),
      })),
      currentPage: page.currentPage,
      totalPages: page.totalPages,
      totalEntries: page.totalEntries,
    };
  }
}
