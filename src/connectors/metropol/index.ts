/**
 * MetropolConnector - FlatSource. Hela aktiva katalogen hämtas i EN sida (unionen av
 * toppkategoriernas product-cards, dedupe på id, sorterad slutar-snart-först) - BNA-stil.
 * Plain HTTP, ingen detalj-berikning (korten bär allt). Historik via finalizePastDue.
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { MetropolClient } from "./client.ts";
import { mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

export class MetropolConnector implements FlatSource {
  readonly house = "metropol";
  readonly hasEndedArchive = false; // historik via finalizePastDue (staggrad stängning)
  readonly endingSortedFirst = true;
  private readonly client = new MetropolClient();

  async fetchPage(opts: { ended?: boolean } = {}): Promise<FlatSourcePage> {
    if (opts.ended) return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    const items = await this.client.fetchAll();
    items.sort((a, b) => (a.endsAt ?? "9").localeCompare(b.endsAt ?? "9")); // slutar snart först
    return {
      items: items.map((it) => ({ auction: mapAuction(it), item: mapItem(it), bids: [] })),
      currentPage: 1,
      totalPages: 1,
      totalEntries: items.length,
    };
  }
}
