/**
 * FrivioConnector - FlatSource. Frivio (fritidsfordon, ~36 aktiva + ~500 avslutade).
 * fetchPage({ended:false}) → aktiva fordon, vart och ett berikat med detalj (beskrivning
 * + säljartyp för objektsmoms), sorterat slutar-snart-först. fetchPage({ended:true}) →
 * avslutade fordon (slutpriser) i en sida → backfillFlatEnded till prishistorik.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { FrivioClient, FrivioVehicle } from "./client.ts";
import { HOUSE, mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

const ENRICH_CONCURRENCY = Number(process.env.FRIVIO_ENRICH_CONCURRENCY ?? 6);

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export class FrivioConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = true; // ~500 avslutade fordon → backfill till prishistorik
  readonly endingSortedFirst = true; // listan sorterad auction_end asc
  private readonly client = new FrivioClient();
  /** id → fordon (för fetchItem mellan svep). */
  private readonly cache = new Map<string, FrivioVehicle>();

  async fetchPage(opts: { ended?: boolean } = {}): Promise<FlatSourcePage> {
    const ended = opts.ended ?? false;
    const vehicles = await this.client.listAuctions(ended);

    if (ended) {
      // Backfill: lista räcker (slutbud + titel + bild); ingen detalj-berikning (~500 st).
      return {
        items: vehicles.map((v) => ({ auction: mapAuction(v), item: mapItem(v), bids: [] })),
        currentPage: 1,
        totalPages: 1,
        totalEntries: vehicles.length,
      };
    }

    // Aktiva: berika varje fordon med detalj (beskrivning + säljartyp för objektsmoms).
    for (const v of vehicles) this.cache.set(String(v.id), v);
    const rows = await mapWithConcurrency(vehicles, ENRICH_CONCURRENCY, async (v) => {
      const detail = await this.client.fetchDetail(v.id);
      return { auction: mapAuction(v, detail), item: mapItem(v, detail), bids: [] };
    });
    return { items: rows, currentPage: 1, totalPages: 1, totalEntries: rows.length };
  }

  /** Färskt läge för ETT fordon (hett-poll): bud + sluttid + säljartyp ur detaljen. */
  async fetchItem(externalId: string): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const id = Number(externalId);
    if (!Number.isFinite(id)) return null;
    // Färsk lista (slutar-snart-först, liten) ger färskt bud; detaljen ger säljartyp.
    const vehicles = await this.client.listAuctions(false);
    const v = vehicles.find((x) => x.id === id) ?? this.cache.get(externalId);
    if (!v) return null;
    const detail = await this.client.fetchDetail(id);
    return { item: mapItem(v, detail), bids: [] };
  }
}
