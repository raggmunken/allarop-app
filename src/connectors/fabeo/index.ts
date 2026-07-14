/**
 * FabeoConnector — implementerar FlatSource (objekt-centrerad källa).
 * Fabeo (fabeo.se) kör industri-/maskinauktioner på WooCommerce. Katalogen kommer
 * ur Store-API:t och realtidsdatan (bud/sluttid/slagavgift/budhistorik) ur varje
 * objektsida. Fabeo är litet (~75 aktiva) → vi berikar alla objekt per cykel.
 *
 * Inget avslutad-arkiv (Store-API:t listar bara aktiva) → historik fås genom att
 * konvertera aktiva → avslutade vid sluttid (finalizePastDue) + exakt slutpris via
 * fetchItem precis innan finalisering.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { FabeoClient, FabeoProduct } from "./client.ts";
import { HOUSE, mapAuction, mapBid, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

/** Kör `fn` över `items` med högst `limit` samtidiga anrop (artig mot källan). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

export class FabeoConnector implements FlatSource {
  readonly house = HOUSE;
  // Store-API:t listar bara aktiva auktioner → inget separat avslutad-arkiv.
  readonly hasEndedArchive = false;
  private readonly client = new FabeoClient();

  async fetchPage(
    opts: { ended?: boolean; page?: number; perPage?: number } = {},
  ): Promise<FlatSourcePage> {
    // Inget avslutad-flöde hos Fabeo.
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    const products = await this.client.fetchActiveProducts(
      Math.min(opts.perPage ?? 100, 100),
    );
    const rows = await mapWithConcurrency(products, 6, async (p) => this.buildRow(p));
    const items = rows.filter((r): r is NonNullable<typeof r> => r != null);
    return { items, currentPage: 1, totalPages: 1, totalEntries: products.length };
  }

  /** Färskt läge för ETT objekt (exakt slutpris + ev. förlängd sluttid). */
  async fetchItem(
    externalId: string,
  ): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const product = await this.client.fetchProduct(externalId);
    if (!product?.permalink) return null;
    const row = await this.buildRow(product);
    if (!row) return null;
    return { item: row.item, bids: row.bids };
  }

  /** Bygg auktion + objekt + bud för en katalogprodukt (hämtar objektsidan). */
  private async buildRow(p: FabeoProduct): Promise<{
    auction: ReturnType<typeof mapAuction>;
    item: NormalizedItem;
    bids: NormalizedBid[];
  } | null> {
    const permalink = p.permalink ?? `https://fabeo.se/auktioner/${p.slug ?? p.id}/`;
    const detail = await this.client.fetchDetail(permalink, p.id);
    return {
      auction: mapAuction(p),
      item: mapItem(p, detail),
      bids: (detail?.bids ?? []).map((b) => mapBid(b, p.id)),
    };
  }
}
