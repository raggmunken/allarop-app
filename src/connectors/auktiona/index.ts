/**
 * AuktionaConnector - FlatSource. Auktiona (gobid, konkurs/likvidation, ~20 aktiva lotter).
 * Hela aktiva katalogen i EN Firestore-runQuery (status=published) + batchGet av parent-
 * auktionerna för ärvd sluttid/ort → returneras som en sida, sorterad slutar-snart-först.
 * Historik via finalizePastDue. External-läge (avgift ej publik).
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { AuktionaClient } from "./client.ts";
import { mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

export class AuktionaConnector implements FlatSource {
  readonly house = "auktiona";
  readonly hasEndedArchive = false; // historik via finalizePastDue
  readonly endingSortedFirst = true; // vi sorterar slutar-snart själva
  private readonly client = new AuktionaClient();

  async fetchPage(opts: { ended?: boolean } = {}): Promise<FlatSourcePage> {
    if (opts.ended) return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    const items = await this.client.fetchActive();
    items.sort((a, b) => (a.endsAt ?? "9").localeCompare(b.endsAt ?? "9")); // slutar snart först
    return {
      items: items.map((it) => ({ auction: mapAuction(it), item: mapItem(it), bids: [] })),
      currentPage: 1,
      totalPages: 1,
      totalEntries: items.length,
    };
  }
}
