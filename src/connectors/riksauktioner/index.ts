/**
 * RiksauktionerConnector — implementerar FlatSource (objekt-centrerad källa).
 * Riksauktioner kör egna auktioner (Kronofogden-avyttringar, konkurser, fordon …).
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { RiksauktionerClient } from "./client.ts";
import { HOUSE, mapAuction, mapBid, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

export class RiksauktionerConnector implements FlatSource {
  readonly house = HOUSE;
  // Riksauktioner saknar avslutad-arkiv (objects listar bara aktiva) → vi får
  // historik genom att konvertera aktiva → avslutade vid sluttid.
  readonly hasEndedArchive = false;
  private readonly client = new RiksauktionerClient();

  async fetchPage(opts: {
    ended?: boolean;
    page?: number;
    perPage?: number;
    companyId?: number;
    shard?: string;
  } = {}): Promise<FlatSourcePage> {
    const [page, steps] = await Promise.all([
      this.client.fetchPage({ ended: opts.ended, page: opts.page, perPage: opts.perPage }),
      this.client.categories(),
    ]);
    return {
      items: page.items.map((it) => ({
        auction: mapAuction(it),
        item: mapItem(it, steps.get(it.category ?? -1) ?? 50),
        bids: (it.bids ?? []).map((b) => mapBid(b, it.id)),
      })),
      currentPage: page.currentPage,
      totalPages: page.totalPages,
      totalEntries: page.totalEntries,
    };
  }

  /** Färskt läge för ETT objekt (för exakt slutpris precis innan finalisering). */
  async fetchItem(
    externalId: string,
  ): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const [o, steps] = await Promise.all([
      this.client.fetchObject(externalId),
      this.client.categories(),
    ]);
    if (!o) return null;
    return {
      item: mapItem(o, steps.get(o.category ?? -1) ?? 50),
      bids: (o.bids ?? []).map((b) => mapBid(b, o.id)),
    };
  }
}
