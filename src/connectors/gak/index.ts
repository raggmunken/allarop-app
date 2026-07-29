/**
 * GakConnector - FlatSource, config-driven för GAK-plattformen (ett objekt per hus ur
 * GAK_HOUSES). SSR-PHP, timad konstauktion (staggrad stängning). fetchPage({page}) →
 * objektöversiktens sida N (44 objekt, slutar-snart-först); beskrivning berikas gradvis.
 * fetchPage({ended:true,page}) → avslutade (showEnded=yes) → backfillFlatEnded. Plain HTTP.
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { GakClient, GakDetail, GakFee, GakItem } from "./client.ts";
import { GakHouseConfig } from "./houses.ts";
import { mapAuction, mapItem } from "./map.ts";

const PER_PAGE = 44;
const ENRICH_PER_SWEEP = Number(process.env.GAK_ENRICH_PER_SWEEP ?? 30);
const ENRICH_CONCURRENCY = Number(process.env.GAK_ENRICH_CONCURRENCY ?? 5);

export interface GakConnectorOpts {
  loadEnriched?: () => Promise<Set<string>>;
  /** id → avgiftsattribut persisterade i DB (items.raw) → överlever omstart. */
  loadFees?: () => Promise<Map<string, GakFee>>;
}

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

export class GakConnector implements FlatSource {
  readonly house: string;
  readonly hasEndedArchive = true;
  readonly endingSortedFirst = true; // sorting=byTime asc
  private readonly client: GakClient;
  private readonly detail = new Map<string, GakDetail | null>();
  private enrichedInDb: Set<string> | null = null;
  private feeSeed: Map<string, GakFee> | null = null;

  constructor(private readonly cfg: GakHouseConfig, private readonly opts: GakConnectorOpts = {}) {
    this.house = cfg.house;
    this.client = new GakClient(cfg.baseUrl);
  }

  async fetchPage(opts: { ended?: boolean; page?: number } = {}): Promise<FlatSourcePage> {
    const ended = opts.ended ?? false;
    const page = opts.page ?? 1;
    const items: GakItem[] = await this.client.fetchPage(page, ended);
    const totalPages = items.length >= PER_PAGE ? page + 1 : page;

    if (ended) {
      return {
        items: items.map((it) => ({ auction: mapAuction(it, this.cfg), item: mapItem(it, this.cfg), bids: [] })),
        currentPage: page,
        totalPages,
        totalEntries: items.length,
      };
    }

    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }
    if (this.feeSeed == null) {
      this.feeSeed = this.opts.loadFees
        ? await this.opts.loadFees().catch(() => new Map<string, GakFee>())
        : new Map<string, GakFee>();
    }
    // Re-berika även "gamla" objekt (beskrivning i DB) som saknar avgiftsattribut.
    const need = items
      .filter((it) => {
        if (this.detail.has(it.id)) return false;
        const enriched = this.enrichedInDb?.has(it.id) ?? false;
        return !enriched || !this.feeSeed!.has(it.id);
      })
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(need, ENRICH_CONCURRENCY, async (it) => {
      this.detail.set(it.id, await this.client.fetchDetail(it.slug, it.id));
    });

    return {
      items: items.map((it) => {
        const fetched = this.detail.get(it.id) ?? null;
        // Färsk detalj vinner; annars DB-seedad avgift. Skrivs in i raw via mapItem →
        // persisteras → loadFees återställer efter omstart.
        const d: GakDetail | null = fetched
          ? { ...fetched, fee: fetched.fee ?? this.feeSeed!.get(it.id) ?? null }
          : this.feeSeed!.has(it.id)
            ? { description: null, fee: this.feeSeed!.get(it.id)!, images: [] }
            : null;
        const mapped = mapItem(it, this.cfg, d);
        // Redan berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
        // lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej).
        if (!d?.images?.length && (this.enrichedInDb?.has(it.id) ?? false)) mapped.media = [];
        return { auction: mapAuction(it, this.cfg, d), item: mapped, bids: [] };
      }),
      currentPage: page,
      totalPages,
      totalEntries: items.length,
    };
  }
}
