/**
 * BidflowConnector - FlatSource för Bidflow-plattformen, config-driven (ett objekt per
 * hus ur BIDFLOW_HOUSES). Periodiska event-hus. fetchPage({ended:false}) → alla AKTIVA
 * auktioners objekt (en sida, BNA-stil). fetchPage({ended:true, page:N}) → N:te HISTORISKA
 * auktionens objekt → backfillFlatEnded betar av dem till prishistorik (riktiga slutpriser).
 *
 * AVGIFTER: köparvillkoren är per AUKTION och exponeras av LotsApi/getProvisions
 * (total för ett bud). Vi KALIBRERAR en linjär modell per auktion (2 prober → avgift(bud)
 * = a*bud + b, verifierad exakt mot båda proberna; provision + slagavgift anges inkl moms
 * och ev. budmoms fångas i a) → feeValue räknas lokalt för alla objekt, 2 anrop/auktion.
 * Trapptabeller (BuyerIntervals) eller olinjärt → ingen modell → external-fallback.
 */

import { FlatSource, FlatSourcePage } from "../types.ts";
import { NormalizedBid, NormalizedItem } from "../types.ts";
import { BidflowAuction, BidflowClient, BidflowLot } from "./client.ts";
import { BidflowHouseConfig } from "./houses.ts";
import { FeeLine, mapAuction, mapItem } from "./map.ts";

/** Prob-belopp för kalibreringen (två punkter → linje + exakt verifiering). */
const PROBE_LOW = 1000;
const PROBE_HIGH = 100000;
/** lotInfo-berikningar (beskrivning + skick) per svep - browser-routade tenants är dyra. */
const ENRICH_PER_SWEEP = Number(process.env.BIDFLOW_ENRICH_PER_SWEEP ?? 15);

export interface BidflowConnectorOpts {
  /** Objekt-id (aucId-lotId) som redan har beskrivning i DB → hoppa över om-hämtning. */
  loadEnriched?: () => Promise<Set<string>>;
}

export class BidflowConnector implements FlatSource {
  readonly house: string;
  // Historiska auktioner backfillas till prishistorik (riktiga slutpriser).
  readonly hasEndedArchive = true;
  private readonly client: BidflowClient;
  /** Historik-listan cachas så backfill-pagineringen är stabil mellan sidor. */
  private historyCache: BidflowAuction[] | null = null;
  /** auktion-id → kalibrerad avgiftslinje (null = okalibrerbar → external). */
  private readonly feeLines = new Map<string, FeeLine | null>();
  /** Auktionslistan cachad för hot-pollen (byts sällan; 5 min TTL). */
  private hotAuctions: BidflowAuction[] = [];
  private hotAuctionsAt = 0;
  /** Throttle per auktion i hot-pollen - fetchLots ger HELA auktionen i ett svep.
   * Stämplas EFTER hämtning (browser-anropet kan ta ~15 s - annars läcker fönstret)
   * + in-flight-vakt mot överlapp. */
  private readonly hotLotsAt = new Map<string, number>();
  private readonly hotInFlight = new Set<string>();
  /** id (aucId-lotId) → beskrivning+skick ur lotInfo (berikas gradvis, behålls i minnet). */
  private readonly descriptions = new Map<string, string | null>();
  private enrichedInDb: Set<string> | null = null;

  constructor(private readonly cfg: BidflowHouseConfig, private readonly opts: BidflowConnectorOpts = {}) {
    this.house = cfg.house;
    this.client = new BidflowClient(cfg.baseUrl, cfg.useBrowser);
  }

  /** Kalibrera auktionens avgiftslinje EN gång (cachas för processens livstid). */
  private async calibrate(auctionId: string, lots: BidflowLot[]): Promise<FeeLine | null> {
    const cached = this.feeLines.get(auctionId);
    if (cached !== undefined) return cached;
    let line: FeeLine | null = null;
    const probe = lots.find((l) => !l.finished) ?? lots[0];
    if (probe) {
      const [p1, p2] = await Promise.all([
        this.client.getProvisions(auctionId, probe.lotId, PROBE_LOW),
        this.client.getProvisions(auctionId, probe.lotId, PROBE_HIGH),
      ]);
      if (p1 && p2 && !p1.stepped && !p2.stepped) {
        const f1 = p1.total - PROBE_LOW;
        const f2 = p2.total - PROBE_HIGH;
        const a = (f2 - f1) / (PROBE_HIGH - PROBE_LOW);
        const b = f1 - a * PROBE_LOW;
        // Exakt verifiering mot båda proberna (skyddar mot dold olinjäritet).
        const ok =
          Number.isFinite(a) && a >= 0 && b >= -0.01 &&
          Math.abs(a * PROBE_LOW + b - f1) < 1 &&
          Math.abs(a * PROBE_HIGH + b - f2) < 1;
        if (ok) line = { a, b: Math.max(b, 0) };
      }
    }
    this.feeLines.set(auctionId, line);
    return line;
  }

  /**
   * HOT-POLL (batchad): Bidflow-lotter stänger staggrat live vid auktionsslutet -
   * utan denna frös buden mellan 30-min-svepen även i slutsekunderna (Haraldssons-
   * fyndet 2026-07-05). externalId = "{auktionId}-{lotId}" → gruppera per auktion,
   * ETT fetchLots-anrop ger HELA auktionens färska läge (bud + Sold-status → exakt
   * slutpris vid finalisering). Throttlas per auktion (8 s) - tätare är meningslöst.
   */
  async fetchItems(externalIds: string[]): Promise<Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>> {
    const out = new Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>();
    const aucIds = [...new Set(externalIds.map((id) => id.split("-")[0]).filter((s): s is string => !!s))];
    if (aucIds.length === 0) return out;
    if (Date.now() - this.hotAuctionsAt > 300_000) {
      const { active, history } = await this.client.listAuctions();
      this.hotAuctions = [...active, ...history];
      this.hotAuctionsAt = Date.now();
    }
    for (const aucId of aucIds) {
      const auc = this.hotAuctions.find((a) => a.id === aucId);
      if (!auc) continue;
      if (this.hotInFlight.has(aucId)) continue;
      if (Date.now() - (this.hotLotsAt.get(aucId) ?? 0) < 20_000) continue;
      this.hotInFlight.add(aucId);
      try {
        const lots = await this.client.fetchLots(aucId);
        const line = await this.calibrate(aucId, lots);
        // Returnera ALLA auktionens lotter - de är hämtade ändå och pollHotFlat
        // upsertar/finaliserar varje post (gratis färskhet för hela auktionen).
        for (const l of lots) {
          const item = mapItem(l, auc, this.cfg, line);
          out.set(item.externalId, { item, bids: [] });
        }
      } finally {
        this.hotLotsAt.set(aucId, Date.now());
        this.hotInFlight.delete(aucId);
      }
    }
    return out;
  }

  async fetchPage(opts: { ended?: boolean; page?: number } = {}): Promise<FlatSourcePage> {
    const ended = opts.ended ?? false;

    if (ended) {
      if (this.historyCache == null) {
        this.historyCache = (await this.client.listAuctions()).history;
      }
      const history = this.historyCache;
      const total = Math.max(1, history.length);
      const page = opts.page ?? 1;
      const auc = history[page - 1];
      if (!auc) {
        return { items: [], currentPage: page, totalPages: total, totalEntries: history.length };
      }
      const lots = await this.client.fetchLots(auc.id);
      const line = await this.calibrate(auc.id, lots);
      return {
        items: lots.map((l) => ({
          auction: mapAuction(auc, this.cfg),
          item: mapItem(l, auc, this.cfg, line),
          bids: [],
        })),
        currentPage: page,
        totalPages: total,
        totalEntries: history.length,
      };
    }

    // Aktiva auktioner: hämta alla deras objekt i EN sida (event-hus, sällan många aktiva).
    const { active } = await this.client.listAuctions();
    if (this.enrichedInDb == null && this.opts.loadEnriched) {
      this.enrichedInDb = await this.opts.loadEnriched().catch(() => new Set<string>());
    }
    const rows: FlatSourcePage["items"] = [];
    let enrichBudget = ENRICH_PER_SWEEP;
    for (const auc of active) {
      const lots = await this.client.fetchLots(auc.id);
      const line = await this.calibrate(auc.id, lots);
      for (const l of lots) {
        const id = `${l.auctionId}-${l.lotId}`;
        // Gradvis lotInfo-berikning (beskrivning + skick) med loadEnriched-skip.
        if (enrichBudget > 0 && !this.descriptions.has(id) && !this.enrichedInDb?.has(id)) {
          enrichBudget--;
          this.descriptions.set(id, await this.client.fetchLotInfo(l.auctionId, l.lotId));
        }
        rows.push({
          auction: mapAuction(auc, this.cfg),
          item: mapItem(l, auc, this.cfg, line, this.descriptions.get(id) ?? null),
          bids: [],
        });
      }
    }
    return { items: rows, currentPage: 1, totalPages: 1, totalEntries: rows.length };
  }
}
