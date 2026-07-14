/**
 * RetradeConnector - FlatSource. Retrade (~579 aktiva, 12 sidor à 50). Rent öppet
 * JSON-API → bulk ur public-list (snabbt, ingen browser). Beskrivning + fullt galleri
 * + status + antal bud + nästa minbud + soft-close ur /api/auctions/{id} (en hämtning
 * ger allt) - berikas EN gång/objekt (gradvis) och används för hett-poll (fetchItem).
 * Köparavgift = external-läge (glidande skala, ej i API:t) → UI markerar "tillkommer".
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { RetradeClient, RetradeDetail, RetradeListItem } from "./client.ts";
import { HOUSE, mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

/**
 * Objektsidor att berika per LISTSIDA (snabb HTTP). För Retrade är detaljen ESSENTIELL
 * (startbud=lowestValidBid + beskrivning finns BARA där, ej i listan) → berika hela
 * sidan (50) varje svep. Bara ~579 objekt över snabb plain HTTP → täcks på en cykel.
 */
const ENRICH_PER_SWEEP = Number(process.env.RETRADE_ENRICH_PER_SWEEP ?? 50);
const ENRICH_CONCURRENCY = Number(process.env.RETRADE_ENRICH_CONCURRENCY ?? 5);

export interface RetradeConnectorOpts {
  /** Objekt-id som redan är berikade i DB → hoppa över om-hämtning efter omstart. */
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

export class RetradeConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = false;
  private readonly client = new RetradeClient();
  /** objekt-id → list-objekt (för fetchItem). */
  private readonly cache = new Map<string, RetradeListItem>();
  /** objekt-id → detalj (beskrivning+galleri); berikas en gång. */
  private readonly detail = new Map<string, RetradeDetail | null>();
  /** objekt-id som redan är berikade i DB (seedas en gång) → hoppa över om-hämtning. */
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly opts: RetradeConnectorOpts = {}) {}

  async fetchPage(opts: { ended?: boolean; page?: number } = {}): Promise<FlatSourcePage> {
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    const page = opts.page ?? 1;
    const { items, totalPages } = await this.client.fetchListPage(page);
    for (const it of items) this.cache.set(it.id, it);

    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }

    // Berika beskrivning + galleri ur objektsidan (gradvis, in-memory dedup).
    const fresh = items
      .filter((it) => !this.detail.has(it.id) && !this.enrichedInDb?.has(it.id))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      this.detail.set(it.id, await this.client.fetchDetail(it.id));
    });

    return {
      items: items.map((it) => {
        const det = this.detail.get(it.id) ?? null;
        return {
          auction: mapAuction(it, det),
          item: mapItem(it, det),
          bids: [], // budgivare anonymiserade (löpnummer) → inga bud-rader
        };
      }),
      currentPage: page,
      totalPages,
      totalEntries: 0,
    };
  }

  /** Färskt läge för ETT objekt (hett-poll): exakt bud/status/sluttid + galleri. */
  async fetchItem(
    externalId: string,
  ): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const it = this.cache.get(externalId);
    if (!it) return null; // okänt (t.ex. efter omstart) → backstop finaliserar
    const det = await this.client.fetchDetail(externalId);
    if (det) {
      this.detail.set(externalId, det);
      // Låt färska detalj-värden flöda via list-objektet (mapItem läser live-fält
      // därifrån): färskt bud + soft-close-förlängd sluttid.
      if (det.highestBid != null) it.highestBid = det.highestBid;
      it.auctionEnd = det.effectiveEndAt ?? det.auctionEnd ?? it.auctionEnd;
    }
    return { item: mapItem(it, det ?? this.detail.get(externalId) ?? null), bids: [] };
  }
}
