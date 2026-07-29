/**
 * MetropolConnector - FlatSource. Hela aktiva katalogen hämtas i EN sida (unionen av
 * toppkategoriernas product-cards, dedupe på id, sorterad slutar-snart-först) - BNA-stil.
 * Plain HTTP. Korten bär det mesta (titel, beskrivning, bud, sluttid, huvudbild) men bara
 * EN bild → objektsidans imagebank-galleri berikas gradvis EN gång per objekt
 * (loadEnriched-skip). Historik via finalizePastDue.
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { MetropolClient } from "./client.ts";
import { mapAuction, mapItem, type MetropolDetail } from "./map.ts";

export { HOUSE } from "./map.ts";

/** Antal objektsidor (galleri) att berika per svep - mot rate-limit. */
const ENRICH_PER_SWEEP = Number(process.env.METROPOL_ENRICH_PER_SWEEP ?? 40);
const ENRICH_CONCURRENCY = Number(process.env.METROPOL_ENRICH_CONCURRENCY ?? 4);

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

export interface MetropolConnectorOpts {
  /** Objekt-id som redan har beskrivning i DB → hoppa över om-hämtning efter omstart. */
  loadEnriched?: () => Promise<Set<string>>;
}

export class MetropolConnector implements FlatSource {
  readonly house = "metropol";
  readonly hasEndedArchive = false; // historik via finalizePastDue (staggrad stängning)
  readonly endingSortedFirst = true;
  private readonly client = new MetropolClient();
  /** objekt-id → galleri (berikas en gång, behålls mellan svep). */
  private readonly details = new Map<string, MetropolDetail | null>();
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly opts: MetropolConnectorOpts = {}) {}

  async fetchPage(opts: { ended?: boolean } = {}): Promise<FlatSourcePage> {
    if (opts.ended) return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    const items = await this.client.fetchAll();
    items.sort((a, b) => (a.endsAt ?? "9").localeCompare(b.endsAt ?? "9")); // slutar snart först

    // Gradvis galleri-berikning (objektsidan) med loadEnriched-skip.
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }
    const fresh = items
      .filter((it) => !this.details.has(it.id) && !this.enrichedInDb?.has(it.id))
      .slice(0, ENRICH_PER_SWEEP);
    await mapWithConcurrency(fresh, ENRICH_CONCURRENCY, async (it) => {
      this.details.set(it.id, await this.client.fetchDetail(it.goPath));
    });

    return {
      items: items.map((it) => {
        const det = this.details.get(it.id) ?? null;
        const mapped = mapItem(it, det);
        // Redan berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
        // lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej).
        if (!det?.images?.length && (this.enrichedInDb?.has(it.id) ?? false)) mapped.media = [];
        return { auction: mapAuction(it), item: mapped, bids: [] };
      }),
      currentPage: 1,
      totalPages: 1,
      totalEntries: items.length,
    };
  }
}
