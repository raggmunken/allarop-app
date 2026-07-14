/**
 * BnaConnector — implementerar FlatSource. BNA (konkurs-/dödsboauktioner) är
 * part-baserat (event → objekt) men litet (~tiotal objekt) → fetchPage hämtar
 * alla aktiva event, deras objekt och varje objekts detaljsida i en cykel.
 * `fetchItem` (via slug-cache) ger exakt slutpris nära avslut; historik annars
 * via finalizePastDue.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { BnaClient } from "./client.ts";
import { HOUSE, mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

export class BnaConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = false;
  private readonly client = new BnaClient();
  /** objekt-id → {detalj-URL, event-id} (för fetchItem mellan svep). */
  private readonly cache = new Map<string, { href: string; eventId: string }>();

  async fetchPage(opts: { ended?: boolean } = {}): Promise<FlatSourcePage> {
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    const events = await this.client.fetchAuctions();
    const rows: FlatSourcePage["items"] = [];
    for (const ev of events) {
      const objs = await this.client.fetchEventObjects(ev.href);
      const details = await mapWithConcurrency(objs, 5, (o) =>
        this.client.fetchDetail(o.href),
      );
      for (const d of details) {
        if (!d) continue;
        this.cache.set(d.itemId, { href: d.href, eventId: ev.id });
        rows.push({ auction: mapAuction(ev), item: mapItem(d, ev.id), bids: [] });
      }
    }
    return { items: rows, currentPage: 1, totalPages: 1, totalEntries: rows.length };
  }

  /** Färskt läge för ETT objekt (kräver känd detalj-URL ur senaste svep). */
  async fetchItem(
    externalId: string,
  ): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const hit = this.cache.get(externalId);
    if (!hit) return null; // cache kall (t.ex. efter omstart) → backstop finaliserar
    const d = await this.client.fetchDetail(hit.href);
    if (!d) return null;
    return { item: mapItem(d, hit.eventId), bids: [] };
  }
}
