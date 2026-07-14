/**
 * VaxxaConnector - FlatSource. Vaxxa (konkurs/självservice, ~170 aktiva). Katalogen ur det
 * öppna Typesense-indexet (bud/reserv/sluttid/thumbnail), berikad per objekt ur objektsidan
 * (s=full-galleri + beskrivning + is_taxable) EN gång (loadEnriched-skip, som Budi). Ren
 * paginering (page/per_page ≤ 250), sorterat end_time:asc → endingSortedFirst. Historik via
 * finalizePastDue. AVGIFTER: serviceavgiften (exkl moms, +25 % moms) hämtas per (objekt,
 * aktuellt bud) via getProductFeeAction och cachas tills budet ändras (FEE_PER_SWEEP-tak).
 * Momsstatus (is_taxable) persisteras via raw → loadTaxable-seed över omstarter.
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { VaxxaClient, VaxxaDetail, PER_PAGE } from "./client.ts";
import { mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

const ENRICH_PER_SWEEP = Number(process.env.VAXXA_ENRICH_PER_SWEEP ?? 20);
const ENRICH_CONCURRENCY = Number(process.env.VAXXA_ENRICH_CONCURRENCY ?? 3);
/** Avgifts-anrop (getProductFeeAction) per svep - täcker hela beståndet på få svep. */
const FEE_PER_SWEEP = Number(process.env.VAXXA_FEE_PER_SWEEP ?? 60);

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

export interface VaxxaConnectorOpts {
  loadEnriched?: () => Promise<Set<string>>;
  /** id → is_taxable persisterat i DB (items.raw) → momsstatus överlever omstart. */
  loadTaxable?: () => Promise<Map<string, boolean>>;
}

export class VaxxaConnector implements FlatSource {
  readonly house = "vaxxa";
  readonly hasEndedArchive = false;
  readonly endingSortedFirst = true;
  private readonly client = new VaxxaClient();
  private readonly details = new Map<string, VaxxaDetail>();
  /** id → {amount, fee}: avgiften gäller ett budbelopp; om-hämtas när budet ändras. */
  private readonly fees = new Map<string, { amount: number; fee: number }>();
  private enrichedInDb: Set<string> | null = null;
  private taxableSeed: Map<string, boolean> | null = null;

  constructor(private readonly opts: VaxxaConnectorOpts = {}) {}

  async fetchPage(opts: { ended?: boolean; page?: number; perPage?: number } = {}): Promise<FlatSourcePage> {
    if (opts.ended) return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    const page = opts.page ?? 1;
    const perPage = Math.min(opts.perPage ?? PER_PAGE, PER_PAGE);
    const { items, found } = await this.client.search(page, perPage);

    // Gradvis berikning (galleri + beskrivning + is_taxable) med loadEnriched-skip.
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }
    if (this.taxableSeed == null) {
      this.taxableSeed = this.opts.loadTaxable
        ? await this.opts.loadTaxable().catch(() => new Map<string, boolean>())
        : new Map<string, boolean>();
    }
    // Re-berika även "gamla" objekt (beskrivning i DB) som saknar momsstatus - utan
    // is_taxable går ingen korrekt total att räkna.
    const fresh = items
      .filter((it) => {
        if (this.details.has(it.externalId)) return false;
        const enriched = this.enrichedInDb?.has(it.externalId) ?? false;
        return !enriched || !this.taxableSeed!.has(it.externalId);
      })
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      this.details.set(it.externalId, await this.client.fetchDetail(it.externalId));
    });
    for (const it of items) {
      const d = this.details.get(it.externalId);
      if (d) {
        if (d.description) it.description = d.description;
        if (d.images.length) it.images = d.images;
        if (d.taxable != null) it.isTaxable = d.taxable;
      }
      if (it.isTaxable == null) it.isTaxable = this.taxableSeed.get(it.externalId) ?? null;
    }

    // Serviceavgift för AKTUELLT belopp (cache tills beloppet ändras; FEE_PER_SWEEP-tak):
    // bud > köp nu-pris > 0 (budlösa auktioner - fee(0) = minimiavgiften som Vaxxa
    // själva visar på objektsidan, "Serviceavgift: 140 kr exkl moms").
    // Sidan är slutar-snart-sorterad → de mest brådskande får avgift först.
    const feeAmount = (it: (typeof items)[number]) => it.currentBid ?? it.buyNowPrice ?? 0;
    const needFee = items
      .filter((it) => this.fees.get(it.externalId)?.amount !== feeAmount(it))
      .slice(0, FEE_PER_SWEEP);
    await mapWithConcurrency(needFee, ENRICH_CONCURRENCY, async (it) => {
      const fee = await this.client.fetchFee(it.externalId, feeAmount(it));
      if (fee != null) this.fees.set(it.externalId, { amount: feeAmount(it), fee });
    });
    for (const it of items) {
      const f = this.fees.get(it.externalId);
      if (f && feeAmount(it) === f.amount) it.feeExVat = f.fee;
    }

    return {
      items: items.map((it) => ({ auction: mapAuction(it), item: mapItem(it), bids: [] })),
      currentPage: page,
      totalPages: Math.max(1, Math.ceil(found / perPage)),
      totalEntries: found,
    };
  }
}
