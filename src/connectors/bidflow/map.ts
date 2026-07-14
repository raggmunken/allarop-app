/**
 * Normalisering: Bidflow (auktion + objekt) → projektets domäntyper. Config-driven
 * (samma kod för alla Bidflow-hus; house/seller/baseUrl per hus). AVGIFTER: köpar-
 * provisionen varierar per auktion → kalibrerad linjär modell (FeeLine, ur getProvisions)
 * → feeValue = a*bud + b (provision + slagavgift INKL moms; ev. budmoms fångad i a →
 * vatRate 0 när linjen finns). Utan kalibrering → external-fallback (ingen fejkad total).
 * Budgivare anonyma (numeriska id) → inga bud-rader. Moms härleds annars ur
 * auktionsnamnet (-Momsfri/-Moms) som metadata.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { BidflowAuction, BidflowLot, slugify } from "./client.ts";
import { BidflowHouseConfig } from "./houses.ts";

/** Kalibrerad avgiftslinje per auktion: avgift(bud) = a*bud + b (allt inkl moms). */
export interface FeeLine {
  a: number;
  b: number;
}

/** Moms ur auktionsnamnet: "-Momsfri" → 0, "-Moms"/"moms" → 25, annars null (okänt/buntat). */
export function vatFromAuctionName(name: string): number | null {
  if (/momsfri|moms\s*fri/i.test(name)) return 0;
  if (/\bmoms\b/i.test(name)) return 25;
  return null;
}

export function mapAuction(auc: BidflowAuction, cfg: BidflowHouseConfig): NormalizedAuction {
  return {
    house: cfg.house,
    externalId: auc.id,
    title: auc.name,
    description: null,
    sourceUrl: `${cfg.baseUrl}/catalogue/${auc.id}-${auc.slug}/EndingSoonest?p=1`,
  };
}

function mapMedia(lot: BidflowLot): NormalizedMedia[] {
  return lot.images.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(
  lot: BidflowLot,
  auc: BidflowAuction,
  cfg: BidflowHouseConfig,
  feeLine: FeeLine | null = null,
  description: string | null = null,
): NormalizedItem {
  // Aktiv bara om auktionen är aktiv OCH objektets budgivning inte avslutats.
  const active = auc.active && !lot.finished;
  const bid = lot.currentBid;
  // Avgift ur den kalibrerade linjen (provision + slagavgift, inkl moms) - bara med bud.
  const fee = feeLine != null && bid != null && bid > 0 ? Math.round(feeLine.a * bid + feeLine.b) : null;
  return {
    house: cfg.house,
    externalId: `${lot.auctionId}-${lot.lotId}`,
    partExternalId: auc.id,
    auctionExternalId: auc.id,
    title: lot.name,
    description, // lotInfo-berikning (beskrivning + skick); upsertens COALESCE bevarar
    location: lot.location,
    status: active ? "active" : "ended",
    endsAt: auc.date, // alla objekt avslutas på auktionens datum (staggrat live - olöst)
    minBid: null,
    currentBid: lot.currentBid,
    bidCount: null, // budhistorik finns i lotInfo (anonym) - ej i list
    // Reservpris: status + ev. VÄRDE (Bidflow exponerar det ibland, som Junora).
    reserveStatus: lot.reserveMet == null ? null : lot.reserveMet ? "met" : "not_met",
    reservePrice: lot.reservePrice != null && lot.reservePrice > 0 ? lot.reservePrice : null,
    // Kalibrerad avgift (inkl moms; ev. budmoms fångad i linjen) - annars external-fallback.
    feeValue: fee,
    // Med kalibrerad avgift är ALLT i feeValue → vatRate 0 (undvik dubbelräkning).
    // Utan → auktionsnamnets moms som metadata (external ignorerar den i totalen).
    vatRate: fee != null ? 0 : vatFromAuctionName(auc.name),
    currency: "SEK",
    seller: cfg.seller,
    listedAt: null,
    media: mapMedia(lot),
    sourceUrl: `${cfg.baseUrl}/lot/${auc.id}-${auc.slug}/${lot.lotId}-${slugify(lot.name)}`,
    raw: { lot, auction: auc } as unknown as RawPayload,
  };
}
