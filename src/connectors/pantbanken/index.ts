/**
 * PantbankenConnector - FlatSource. Pantbanken Sverige (pantauktioner, ~4700 aktiva objekt).
 * fetchPage paginerar aktiva listan (offset/length, ≤ 500/sida → ~10 sidor). Listan är
 * sorterad slutar-snart-först (endingSortedFirst) → hot-pollen tät-refreshar sida 1.
 * Korten bär bud + budledare + antal bud + exakt sluttid; BESKRIVNING (objektsidans
 * Objektinformation-tabell: Varukategori/Kontor/Frakt m.m.) berikas gradvis EN gång
 * per objekt (loadEnriched-skip). Historik via finalizePastDue (arkivet är >1 M objekt).
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { PantbankenClient } from "./client.ts";
import { mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

const ENRICH_PER_SWEEP = Number(process.env.PANTBANKEN_ENRICH_PER_SWEEP ?? 30);
const ENRICH_CONCURRENCY = Number(process.env.PANTBANKEN_ENRICH_CONCURRENCY ?? 5);

export interface PantbankenConnectorOpts {
  loadEnriched?: () => Promise<Set<string>>;
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

export class PantbankenConnector implements FlatSource {
  readonly house = "pantbanken";
  readonly hasEndedArchive = false; // historik via finalizePastDue (arkivet är enormt)
  readonly endingSortedFirst = true; // listan sorterad slutar-snart-först
  private readonly client = new PantbankenClient();
  private readonly details = new Map<string, { description: string | null; images: string[] } | null>();
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly opts: PantbankenConnectorOpts = {}) {}

  async fetchPage(opts: { ended?: boolean; page?: number; perPage?: number } = {}): Promise<FlatSourcePage> {
    if (opts.ended) return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    const page = opts.page ?? 1;
    const perPage = Math.min(opts.perPage ?? 200, 500);
    const { items, total } = await this.client.fetchListing(page, perPage);

    // Gradvis beskrivnings-berikning (statisk spec-tabell) med loadEnriched-skip.
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }
    const fresh = items
      .filter((it) => !this.details.has(it.id) && !this.enrichedInDb?.has(it.id))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      this.details.set(it.id, await this.client.fetchDetail(it.id));
    });

    return {
      items: items.map((it) => {
        const det = this.details.get(it.id) ?? null;
        const mapped = mapItem(it, det);
        // Redan berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
        // lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej).
        if (!det?.images?.length && (this.enrichedInDb?.has(it.id) ?? false)) mapped.media = [];
        return {
          auction: mapAuction(it),
          item: mapped,
          bids: [],
        };
      }),
      currentPage: page,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      totalEntries: total,
    };
  }
}
