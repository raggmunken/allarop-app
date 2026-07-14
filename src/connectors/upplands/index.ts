/**
 * UpplandsConnector - FlatSource. Periodiskt event-hus (bbys/Next.js). fetchPage({ended:
 * false}) → AKTIVA/kommande auktioners objekt (en sida). fetchPage({ended:true, page:N}) →
 * AVSLUTADE objekt paginerade (alla auktioners lotter plattade till en lista, så enstaka
 * tomma/404-auktioner inte avbryter) → backfillFlatEnded till prishistorik. Plain HTTP.
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { UpplandsAuction, UpplandsClient, UpplandsLot } from "./client.ts";
import { mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

export class UpplandsConnector implements FlatSource {
  readonly house = "upplands";
  readonly hasEndedArchive = true;
  private readonly client = new UpplandsClient();
  private auctionsCache: UpplandsAuction[] | null = null;
  /** Avslutade objekt plattade (lot + auktion), hämtas en gång för stabil paginering. */
  private endedCache: { lot: UpplandsLot; auc: UpplandsAuction }[] | null = null;

  private async auctions(): Promise<UpplandsAuction[]> {
    if (this.auctionsCache == null) this.auctionsCache = await this.client.listAuctions();
    return this.auctionsCache;
  }

  private async endedLots(): Promise<{ lot: UpplandsLot; auc: UpplandsAuction }[]> {
    if (this.endedCache) return this.endedCache;
    const history = (await this.auctions()).filter((a) => a.ended);
    const out: { lot: UpplandsLot; auc: UpplandsAuction }[] = [];
    for (const auc of history) {
      const lots = await this.client.fetchLots(auc.id); // [] vid 404/tom
      for (const lot of lots) out.push({ lot, auc });
    }
    this.endedCache = out;
    return out;
  }

  async fetchPage(opts: { ended?: boolean; page?: number; perPage?: number } = {}): Promise<FlatSourcePage> {
    const ended = opts.ended ?? false;

    if (ended) {
      const all = await this.endedLots();
      const perPage = opts.perPage ?? 100;
      const page = opts.page ?? 1;
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return {
        items: slice.map(({ lot, auc }) => ({ auction: mapAuction(lot, auc), item: mapItem(lot, auc), bids: [] })),
        currentPage: page,
        totalPages,
        totalEntries: all.length,
      };
    }

    // Aktiva/kommande auktioner: sluttid i framtiden (utesluter gamla draft-auktioner
    // utan publik sida) och ej avslutade.
    const now = Date.now();
    const live = (await this.auctions()).filter(
      (a) => !a.ended && a.endDate != null && new Date(a.endDate).getTime() >= now,
    );
    const rows: FlatSourcePage["items"] = [];
    for (const auc of live) {
      const lots = await this.client.fetchLots(auc.id);
      for (const l of lots) rows.push({ auction: mapAuction(l, auc), item: mapItem(l, auc), bids: [] });
    }
    return { items: rows, currentPage: 1, totalPages: 1, totalEntries: rows.length };
  }
}
