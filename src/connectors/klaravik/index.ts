/**
 * KlaravikConnector - implementerar FlatSource (objekt-centrerad källa).
 * Klaravik (maskiner/fordon/lantbruk) har ett rent JSON-list-API (~3 000 aktiva,
 * 60/sida). Bulk-svepet kommer helt ur list-API:t (snabbt, ingen detalj-hämtning).
 * `fetchItem` hämtar objektsidan för exakt bud + EXAKT moms + sluttid nära avslut;
 * historik annars via finalizePastDue.
 */

import { FlatSource, FlatSourcePage, NormalizedBid, NormalizedItem, NormalizedMedia } from "../types.ts";
import { KlaravikClient, KlaravikContent, KlaravikItem } from "./client.ts";
import { HOUSE, mapAuction, mapItem } from "./map.ts";

export { HOUSE } from "./map.ts";

/** Kör `fn` över `items` med högst `limit` samtidiga anrop. */
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

export interface KlaravikConnectorOpts {
  /** Returnerar objekt-id som redan har galleri i DB → hoppa över om-hämtning av
   *  objektsidan efter omstart (in-memory-cachen är tom då). Injiceras av CLI. */
  loadEnriched?: () => Promise<Set<string>>;
  /**
   * Återskapa cachen (id→KlaravikItem, inkl url/slug) från DB:s `raw` för alla aktiva
   * objekt. Klaravik har ~50 sidor men bara 40 sveps/cykel → utan seed kan fetchItem
   * bara polla objekt vars sida svepts den här sessionen, så objekt på osvepta sidor
   * (och ALLA efter omstart) fryser i "inaktuell" status även nära avslut.
   */
  loadCache?: () => Promise<unknown[]>;
}

export class KlaravikConnector implements FlatSource {
  readonly house = HOUSE;
  readonly hasEndedArchive = false;
  private readonly client = new KlaravikClient();
  /** objekt-id → list-objekt (för fetchItem: slå ihop färsk detalj med katalogdata). */
  private readonly cache = new Map<string, KlaravikItem>();
  /**
   * objekt-id → berikning (galleri + brödtext). List-API:t ger bara 1 bild och
   * ingen beskrivning; bådadera finns på objektsidan. Hämtas EN gång per objekt
   * (in-memory dedup) → tungt bara första svepet, sedan gratis.
   */
  private readonly content = new Map<string, KlaravikContent>();
  /** objekt-id som redan är berikade i DB (seedas en gång) → hoppa över om-hämtning. */
  private enrichedInDb: Set<string> | null = null;
  /** Har cachen seedats från DB (id→url) den här sessionen? */
  private cacheSeeded = false;

  constructor(private readonly opts: KlaravikConnectorOpts = {}) {}

  /**
   * Seed cachen (id→KlaravikItem) från DB EN gång så hett-pollen når objekt vars
   * listsida inte svepts den här sessionen. Befintliga (färska) cache-poster vinner.
   */
  private async seedCache(): Promise<void> {
    if (this.cacheSeeded) return;
    this.cacheSeeded = true;
    if (!this.opts.loadCache) return;
    try {
      for (const raw of await this.opts.loadCache()) {
        const it = raw as Partial<KlaravikItem>;
        if (it?.id != null && it?.url && !this.cache.has(String(it.id))) {
          this.cache.set(String(it.id), it as KlaravikItem);
        }
      }
    } catch {
      /* DB-seed misslyckades → faller tillbaka på svep-fylld cache */
    }
  }

  async fetchPage(
    opts: { ended?: boolean; page?: number } = {},
  ): Promise<FlatSourcePage> {
    if (opts.ended) {
      return { items: [], currentPage: 1, totalPages: 1, totalEntries: 0 };
    }
    await this.seedCache();
    const page = await this.client.fetchPage(opts.page ?? 1);
    for (const it of page.items) this.cache.set(String(it.id), it);

    // Seed (en gång): objekt som redan är berikade i DB → hoppa över om-hämtning av
    // objektsidan efter omstart. DB:s galleri/beskrivning bevaras (additiv media +
    // description=COALESCE); list-API:ts bud/sluttid uppdateras ändå för ALLA varje
    // svep — bara den dyra objektsido-hämtningen skippas.
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }

    // Berika galleri + brödtext ur objektsidan för objekt vi inte sett förut.
    const fresh = page.items.filter(
      (it) => it.url && !this.content.has(String(it.id)) && !this.enrichedInDb?.has(String(it.id)),
    );
    await mapWithConcurrency(fresh, 4, async (it) => {
      this.content.set(String(it.id), await this.client.fetchContent(it.url!, it.id));
    });

    return {
      items: page.items.map((it) => {
        const c = this.content.get(String(it.id));
        const item = mapItem(it, undefined, c?.description ?? null);
        if (c?.images.length) {
          item.media = c.images.map((url, i): NormalizedMedia => ({ kind: "image", url, sort: i + 1 }));
        } else if (this.enrichedInDb?.has(String(it.id))) {
          // Redan berikat i DB men ej om-hämtat detta körvarv (t.ex. efter omstart):
          // lämna media tom så upsertMedia inte raderar det sparade galleriet (tom = rör ej).
          item.media = [];
        }
        return {
          auction: mapAuction(it),
          item,
          bids: [], // budgivare visas anonymt (numeriskt id) → inga bud-rader
        };
      }),
      currentPage: page.currentPage,
      totalPages: page.totalPages,
      totalEntries: page.totalEntries,
    };
  }

  /** Färskt läge för ETT objekt: exakt bud, moms och sluttid ur objektsidan. */
  async fetchItem(
    externalId: string,
  ): Promise<{ item: NormalizedItem; bids: NormalizedBid[] } | null> {
    await this.seedCache();
    const cached = this.cache.get(externalId);
    if (!cached?.url) return null; // okänd URL (t.ex. efter omstart) → backstop finaliserar
    const d = await this.client.fetchDetail(cached.url);
    if (!d) return null;
    // Slå ihop färska realtidsvärden med katalogdatan, behåll exakt moms.
    const merged: KlaravikItem = {
      ...cached,
      currentBid: d.currentBid ?? cached.currentBid,
      auctionFee: d.auctionFee ?? cached.auctionFee,
      endDate: d.endUnix != null ? new Date(d.endUnix * 1000).toISOString() : cached.endDate,
      ended: d.ended,
    };
    const item = mapItem(merged, d.vat);
    // Galleri: återanvänd berikat innehåll om vi har det; annars rör inte DB-galleriet
    // för redan berikade objekt (annars skulle hot-pollen skriva över med huvudbilden).
    const c = this.content.get(String(cached.id));
    if (c?.images.length) {
      item.media = c.images.map((url, i): NormalizedMedia => ({ kind: "image", url, sort: i + 1 }));
    } else if (this.enrichedInDb?.has(String(cached.id))) {
      item.media = [];
    }
    return { item, bids: [] };
  }
}
