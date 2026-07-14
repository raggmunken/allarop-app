/**
 * SikoConnector - FlatSource. Sikö (timad konst-/kvalitetsauktion, lotter stänger staggrat).
 * Inget list-API → fetchPage upptäcker ALLA aktiva objekt via ID-enumerering mot live-
 * endpointen (bud + sluttid, billigt) och paginerar dem slutar-snart-först; titel/utrop/
 * bild/beskrivning berikas gradvis ur SSR-detaljsidan. Historik via finalizePastDue.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem } from "../types.ts";
import { SikoClient, SikoDetail, SikoLive, probe } from "./client.ts";
import { HOUSE, mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

const PAGE_SIZE = 100;
const ENRICH_PER_SWEEP = Number(process.env.SIKO_ENRICH_PER_SWEEP ?? 40);
const ENRICH_CONCURRENCY = Number(process.env.SIKO_ENRICH_CONCURRENCY ?? 6);
const DISCOVER_TTL_MS = Number(process.env.SIKO_DISCOVER_TTL_MS ?? 30_000);

export interface SikoConnectorOpts {
  /** Seed:a detaljcachen ur DB (hela raw = {live, detail}) efter omstart → titel/bild överlever. */
  loadCache?: () => Promise<unknown[]>;
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

export class SikoConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = false; // staggrad stängning → historik via finalizePastDue
  readonly endingSortedFirst = true;
  private readonly client = new SikoClient();
  private liveCache: SikoLive[] = [];
  private liveCachedAt = 0;
  /** id → detalj (titel/utrop/bild/beskrivning); berikas en gång + seedas ur DB. */
  private readonly detail = new Map<string, SikoDetail | null>();
  private seeded = false;

  constructor(private readonly opts: SikoConnectorOpts = {}) {}

  /** Aktiva objekt (bud + sluttid) med kort TTL-cache (probe = ~20 anrop). */
  private async live(): Promise<SikoLive[]> {
    const now = Date.now();
    if (this.liveCache.length && now - this.liveCachedAt < DISCOVER_TTL_MS) return this.liveCache;
    const active = await this.client.discoverActive();
    active.sort((a, b) => a.secondsRemaining - b.secondsRemaining); // slutar snart först
    this.liveCache = active;
    this.liveCachedAt = now;
    return active;
  }

  async fetchPage(opts: { ended?: boolean; page?: number } = {}): Promise<FlatSourcePage> {
    if (opts.ended) return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    const page = opts.page ?? 1;

    if (!this.seeded && this.opts.loadCache) {
      this.seeded = true;
      const cached = await this.opts.loadCache().catch(() => [] as unknown[]);
      for (const raw of cached) {
        const r = raw as { live?: { id?: number }; detail?: SikoDetail | null };
        if (r?.live?.id != null) this.detail.set(String(r.live.id), r.detail ?? null);
      }
    }

    const all = await this.live();
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    // Berika detalj (titel/bild) för objekt som saknas i cachen (gradvis).
    const need = slice.filter((l) => !this.detail.has(String(l.id))).slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(need, ENRICH_CONCURRENCY, async (l) => {
      this.detail.set(String(l.id), await this.client.fetchDetail(l.id));
    });

    return {
      items: slice.map((l) => {
        const d = this.detail.get(String(l.id)) ?? null;
        return { auction: mapAuction(l, d), item: mapItem(l, d), bids: [] };
      }),
      currentPage: page,
      totalPages,
      totalEntries: all.length,
    };
  }

  /** Färskt läge för ETT objekt (hett-poll): bud + sluttid via live-probe. */
  async fetchItem(externalId: string): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    const id = Number(externalId);
    if (!Number.isFinite(id)) return null;
    const [live] = await probe([id]);
    if (!live) return null;
    const detail = this.detail.get(externalId) ?? (await this.client.fetchDetail(id));
    return { item: mapItem(live, detail), bids: [] };
  }
}
