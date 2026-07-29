/**
 * BlintoConnector - implementerar FlatSource. Blinto (maskiner/fordon/verktyg)
 * renderar hela katalogen (~950) på startsidan → bulk kommer ur ren HTTP (ingen
 * browser). Slagavgift + objektsmoms + galleri ligger på objektsidan och berikas
 * EN gång per objekt (in-memory dedup → tungt bara första svepet, sedan gratis).
 * `fetchItem` hämtar objektsidan för exakt slutpris nära avslut.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { BlintoBidData, BlintoClient, BlintoDetail, BlintoItem } from "./client.ts";
import { HOUSE, mapAuction, mapItem, parseExactEnd } from "./map.ts";

export { HOUSE } from "./map.ts";

/** Antal objektsidor (slagavgift/galleri/brödtext) att berika per svep (mot rate-limit). */
const ENRICH_PER_SWEEP = Number(process.env.BLINTO_ENRICH_PER_SWEEP ?? 120);
/** Samtidiga browser-hämtningar vid berikning. Sätt högt för en EN-gångs full-ingest. */
const ENRICH_CONCURRENCY = Number(process.env.BLINTO_ENRICH_CONCURRENCY ?? 3);

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

export interface BlintoConnectorOpts {
  /** Returnerar objekt-id som redan är berikade i DB (skippas → ingen om-hämtning
   *  av objektsidan efter omstart då in-memory-cachen är tom). Injiceras av CLI. */
  loadEnriched?: () => Promise<Set<string>>;
}

export class BlintoConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = false;
  private readonly client = new BlintoClient();
  /** objekt-id → list-kort (för fetchItem). */
  private readonly cache = new Map<string, BlintoItem>();
  /** objekt-id → detalj (slagavgift+moms+galleri); berikas en gång. */
  private readonly detail = new Map<string, BlintoDetail | null>();
  /** objekt-id som redan är berikade i DB (seedas en gång) → hoppa över om-hämtning. */
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly opts: BlintoConnectorOpts = {}) {}

  /** Objekt berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
   * lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej). */
  private preserveGallery(mapped: NormalizedItem, objId: string, det: BlintoDetail | null): NormalizedItem {
    if (!det?.images?.length && (this.enrichedInDb?.has(objId) ?? false)) mapped.media = [];
    return mapped;
  }

  async fetchPage(opts: { ended?: boolean } = {}): Promise<FlatSourcePage> {
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    const list = await this.client.fetchList();
    const aucIds = [...new Set(list.map((it) => it.aucId))];

    // 1) Aktuellt bud + antal bud för ALLA objekt via BATCHAT getAuctionData (~10
    //    anrop, maxbid=bud). Ersätter ~950 enskilda 4MaxBid-XHR per svep. (SSR-listans
    //    bud fylls av JS efter laddning → opålitligt, därför hämtar vi det här.)
    let bidData = new Map<string, BlintoBidData>();
    try {
      bidData = await this.client.fetchBidData(aucIds);
    } catch (e) {
      console.error("Blinto bud-data fel:", (e as Error).message);
    }

    // 2) Exakt sluttid (+ nästa minbud) via 4MaxBid BARA där den behövs: objekt utan
    //    känd sluttid (nya/efter omstart) eller som snart avslutas (soft-close kan
    //    förlänga). Sluttiden är stabil däremellan → vi slipper ~950 4MaxBid/svep;
    //    heta objekt får dessutom färsk sluttid via fetchItem/fetchItems.
    const SOFT_CLOSE_WINDOW_MS = 90 * 60_000;
    const nowMs = Date.now();
    const needEnd = new Set<string>();
    for (const it of list) {
      const prevEnd = this.cache.get(it.objId)?.endsAtRaw;
      const prevMs = prevEnd ? Date.parse(parseExactEnd(prevEnd) ?? "") : NaN;
      if (Number.isNaN(prevMs) || prevMs - nowMs < SOFT_CLOSE_WINDOW_MS) needEnd.add(it.aucId);
    }
    let ends = new Map<string, Awaited<ReturnType<BlintoClient["fetchLiveOne"]>>>();
    if (needEnd.size) {
      try {
        ends = await this.client.fetchLive([...needEnd]);
      } catch (e) {
        console.error("Blinto sluttid-data fel:", (e as Error).message);
      }
    }

    // 3) Slå ihop på list-objekten. Behåll känd sluttid mellan svep; bud/antal ur
    //    batch-datan; färsk sluttid/nästa-minbud där vi hämtade den.
    for (const it of list) {
      const prev = this.cache.get(it.objId);
      if (prev?.endsAtRaw) {
        it.endsAtRaw = prev.endsAtRaw;
        it.nextMinBid = prev.nextMinBid;
      }
      const bd = bidData.get(it.aucId);
      if (bd) {
        if (bd.currentBid != null) it.currentBid = bd.currentBid;
        if (bd.bidCount != null) it.bidCount = bd.bidCount;
      }
      const en = ends.get(it.aucId);
      if (en) {
        if (en.endsAtRaw) it.endsAtRaw = en.endsAtRaw;
        if (en.nextMinBid != null) it.nextMinBid = en.nextMinBid;
        if (en.currentBid != null) it.currentBid = en.currentBid;
        if (en.bidCount != null) it.bidCount = en.bidCount;
      }
      this.cache.set(it.objId, it);
    }

    // Seed (en gång): objekt som redan är berikade i DB → hoppa över om-hämtning av
    // objektsidan. Annars hämtas alla ~950 objektsidor om vid varje OMSTART (in-memory-
    // cachen är tom då) fastän DB redan har slagavgift/galleri/beskrivning. Live-datan
    // ovan (bud/sluttid) uppdateras ändå för ALLA varje svep — bara den DYRA statiska
    // detalj-hämtningen hoppas över. DB-värden bevaras via COALESCE/GREATEST/additiv media.
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }

    // Berika slagavgift/moms/galleri ur objektsidan. Blinto rate-limitar vid burst
    // → berika bara en LITEN batch per svep (ENRICH_PER_SWEEP), låg samtidighet,
    // omförsök i klienten. In-memory dedup ackumulerar i den långkörande
    // schemaläggaren (heta objekt berikas dessutom direkt via fetchItem). Hela
    // katalogen fylls gradvis över ett antal svep utan att trigga blockering.
    const fresh = list
      .filter((it) => !this.detail.has(it.objId) && !this.enrichedInDb?.has(it.objId))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      this.detail.set(it.objId, await this.client.fetchDetail(it.href, it.objId));
    });

    return {
      items: list.map((it) => {
        const det = this.detail.get(it.objId) ?? null;
        return {
          auction: mapAuction(it, det),
          item: this.preserveGallery(mapItem(it, det), it.objId, det),
          bids: [], // budgivare visas inte med identitet → inga bud-rader
        };
      }),
      currentPage: 1,
      totalPages: 1,
      totalEntries: list.length,
    };
  }

  /** Färskt läge för ETT objekt (hot-poll): exakt bud + sluttid ur 4MaxBid (live,
   *  fångar soft-close-förlängning) + berikad detalj. Null om okänt. */
  async fetchItem(
    externalId: string,
  ): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const it = this.cache.get(externalId);
    if (!it) return null;
    // Live bud + exakt sluttid (billig XHR).
    try {
      const lv = await this.client.fetchLiveOne(it.aucId);
      if (lv) this.applyLive(it, lv);
    } catch {
      /* behåll senast kända fält */
    }
    const det = await this.ensureDetail(it);
    return { item: mapItem(it, det), bids: [] };
  }

  /**
   * BATCHAD hot-poll: hämta live-data (bud + exakt sluttid) för MÅNGA objekt i ETT
   * browser-anrop (en session, N snabba XHR) i stället för en navigering per objekt
   * → blockerar inte hot-poll-loopen när många Blinto-objekt avslutas samtidigt.
   * Detaljberikning hoppas över här (redan cachad/gradvis); endast live-fälten.
   */
  async fetchItems(
    externalIds: string[],
  ): Promise<Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>> {
    const out = new Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>();
    const items = externalIds.map((id) => this.cache.get(id)).filter((x): x is BlintoItem => !!x);
    if (items.length === 0) return out;
    let live = new Map<string, Awaited<ReturnType<BlintoClient["fetchLiveOne"]>>>();
    try {
      live = await this.client.fetchLive([...new Set(items.map((it) => it.aucId))]);
    } catch {
      /* behåll senast kända fält */
    }
    for (const it of items) {
      const lv = live.get(it.aucId);
      if (lv) this.applyLive(it, lv);
      const det = this.detail.get(it.objId) ?? null;
      out.set(it.objId, { item: this.preserveGallery(mapItem(it, det), it.objId, det), bids: [] });
    }
    return out;
  }

  private applyLive(it: BlintoItem, lv: NonNullable<Awaited<ReturnType<BlintoClient["fetchLiveOne"]>>>): void {
    if (lv.currentBid != null) it.currentBid = lv.currentBid;
    if (lv.bidCount != null) it.bidCount = lv.bidCount;
    it.endsAtRaw = lv.endsAtRaw;
    it.nextMinBid = lv.nextMinBid;
  }

  private async ensureDetail(it: BlintoItem): Promise<BlintoDetail | null> {
    if (!this.detail.has(it.objId)) {
      this.detail.set(it.objId, await this.client.fetchDetail(it.href, it.objId));
    }
    return this.detail.get(it.objId) ?? null;
  }
}
