/**
 * BudiConnector - FlatSource. Budi Auktioner (konkurs/B2B, ~830 aktiva). Tre källor:
 *  - SSR-katalogen `?p=N&s=sho` (kumulativ, slutar-snart) → sida N:s 60 (id/titel/kategori/
 *    stad/bild/sluttid) via slice.
 *  - Batch-API:t bidinfo → auktoritativ live-data (bud exkl moms, moms%, antal bud,
 *    reservstatus, exakt sluttid, isEnded) för sidans objekt i ETT anrop.
 *  - Objektsidans meta → beskrivning + AVGIFTSPARAMETRAR (data-budi-servicefee-*), berikade
 *    EN gång per objekt (loadEnriched-skip; parametrarna är statiska per objekt).
 * endingSortedFirst → hot-pollen tät-refreshar sida 1 (bidinfo hålls färsk billigt; statisk
 * beskrivning hoppas över när den finns). Historik via finalizePastDue. AVGIFTER: fast
 * belopp ELLER procent-med-min (exkl moms, +25 % moms) → feeValue räknas ur parametrarna
 * vid varje svep (följer budet); parametrarna persisteras via raw → loadFeeParams-seed.
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { BudiClient, BudiDetail, BudiFeeParams, BudiItem, PER_PAGE, feeFor } from "./client.ts";
import { mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

/** Antal objektsidor (beskrivning) att berika per svep - mot rate-limit. */
const ENRICH_PER_SWEEP = Number(process.env.BUDI_ENRICH_PER_SWEEP ?? 20);
const ENRICH_CONCURRENCY = Number(process.env.BUDI_ENRICH_CONCURRENCY ?? 3);

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
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

export interface BudiConnectorOpts {
  /** Objekt-id som redan har beskrivning i DB → hoppa över om-hämtning efter omstart. */
  loadEnriched?: () => Promise<Set<string>>;
  /** id → avgiftsparametrar persisterade i DB (items.raw) → överlever omstart. */
  loadFeeParams?: () => Promise<Map<string, BudiFeeParams>>;
}

export class BudiConnector implements FlatSource {
  readonly house = "budi";
  readonly hasEndedArchive = false;
  readonly endingSortedFirst = true;
  private readonly client = new BudiClient();
  /** id → detalj (beskrivning + galleri + avgift; berikas en gång, behålls mellan svep). */
  private readonly details = new Map<string, BudiDetail>();
  private enrichedInDb: Set<string> | null = null;
  private feeSeed: Map<string, BudiFeeParams> | null = null;

  constructor(private readonly opts: BudiConnectorOpts = {}) {}

  async fetchPage(opts: { ended?: boolean; page?: number; perPage?: number } = {}): Promise<FlatSourcePage> {
    if (opts.ended) return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    const page = opts.page ?? 1;
    const { items: cumulative, total } = await this.client.fetchCumulative(page);
    const start = (page - 1) * PER_PAGE;
    const slice = cumulative.slice(start, start + PER_PAGE);

    // Auktoritativ live-data (bud/moms/reserv/antal/sluttid) via batch-API:t.
    const bidInfo = await this.client.fetchBidInfo(slice.map((it) => it.id));
    for (const it of slice) {
      const bi = bidInfo.get(it.id);
      if (!bi) continue;
      const cardPrice = it.currentBid ?? it.minBid; // startbud/visat pris från kortet
      it.bidCount = bi.bidCount;
      it.vatPercentage = bi.vatPercentage;
      it.reserveMet = bi.reserveMet;
      if (bi.endsAt) it.endsAt = bi.endsAt;
      it.ended = it.ended || bi.isEnded || !bi.isBiddingOpen;
      if (bi.bidCount > 0 && bi.currentBidExVat != null) {
        it.currentBid = bi.currentBidExVat; // vinnande bud exkl moms
        it.minBid = null;
      } else {
        // Inga bud → visa LÄGSTA GILTIGA BUD (bidNextAmount), aldrig 0.
        it.currentBid = null;
        it.minBid = bi.nextBidExVat ?? cardPrice ?? null;
      }
    }

    // Gradvis beskrivnings-berikning (statisk) med loadEnriched-skip (som Blinto). Steady-
    // state hoppas hela sida 1 över → hot-pollen hämtar 0 objektsidor.
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }
    if (this.feeSeed == null) {
      this.feeSeed = this.opts.loadFeeParams
        ? await this.opts.loadFeeParams().catch(() => new Map<string, BudiFeeParams>())
        : new Map<string, BudiFeeParams>();
    }
    // Re-berika även "gamla" objekt (beskrivning i DB) som saknar avgiftsparametrar -
    // utan dem går ingen total att räkna.
    const fresh = slice
      .filter((it) => {
        if (this.details.has(it.id)) return false;
        const enriched = this.enrichedInDb?.has(it.id) ?? false;
        return !enriched || !this.feeSeed!.has(it.id);
      })
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      // Kortets huvudbild ger objektets bildbas → galleriet filtreras till EGNA bilder.
      this.details.set(it.id, await this.client.fetchDetail(it.sourceUrl, it.image));
    });
    for (const it of slice) {
      const d = this.details.get(it.id);
      if (d) {
        if (d.description) it.description = d.description;
        if (d.images.length) it.images = d.images;
      }
      // Avgiftsparametrar: färsk detalj vinner; annars DB-seed. Skrivs in i raw via
      // mapItem → persisteras → loadFeeParams återställer efter omstart.
      it.feeParams = d?.feeParams ?? this.feeSeed.get(it.id) ?? null;
    }

    return {
      items: slice.map((it: BudiItem) => {
        const mapped = mapItem(it);
        // Redan berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
        // lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej).
        if (!this.details.get(it.id)?.images?.length && (this.enrichedInDb?.has(it.id) ?? false)) {
          mapped.media = [];
        }
        return { auction: mapAuction(it), item: mapped, bids: [] };
      }),
      currentPage: page,
      totalPages: Math.max(1, Math.ceil((total || cumulative.length) / PER_PAGE)),
      totalEntries: total,
    };
  }
}
