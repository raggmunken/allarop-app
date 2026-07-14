/**
 * Normalisering: GAK-plattformens SSR-kort + detalj → domäntyper. Config-driven (samma
 * kod för alla hus på plattformen; house/seller/baseUrl per hus). AVGIFTER: detaljsidans
 * priceInfo-attribut per objekt (GakFee: provision % + slagavgift kr, INKL moms, + ev.
 * objektsmoms) → feeValue = bud × fee% + slagavgift; vatRate = itemVat × 100. Verifierat
 * mot sidans "Totalt med avgift och moms" (8/8 exakt). Utan attribut → external-fallback.
 * Budgivare anonyma → inga bud-rader. Bild + länk får husets baseUrl här.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { GakDetail, GakItem } from "./client.ts";
import { GakHouseConfig } from "./houses.ts";

const sourceUrl = (it: GakItem, cfg: GakHouseConfig) => `${cfg.baseUrl}/auktion/objekt/${it.slug}/${it.id}`;

export function mapAuction(
  it: GakItem,
  cfg: GakHouseConfig,
  detail: GakDetail | null = null,
): NormalizedAuction {
  return {
    house: cfg.house,
    externalId: it.id,
    title: it.title || `${cfg.name} ${it.id}`,
    description: detail?.description ?? null,
    sourceUrl: sourceUrl(it, cfg),
  };
}

function mapMedia(it: GakItem, cfg: GakHouseConfig): NormalizedMedia[] {
  return it.image ? [{ kind: "image", url: `${cfg.baseUrl}${it.image}`, sort: 1 }] : [];
}

export function mapItem(
  it: GakItem,
  cfg: GakHouseConfig,
  detail: GakDetail | null = null,
  now = new Date(),
): NormalizedItem {
  const endedByTime = it.endsAt != null && new Date(it.endsAt).getTime() <= now.getTime();
  // Avgift ur detaljens priceInfo (inkl moms): bud × fee% + slagavgift. Bara med bud.
  const f = detail?.fee ?? null;
  const bid = it.currentBid;
  const fee =
    f != null && bid != null && bid > 0
      ? Math.round((bid * f.purchaseFeePct) / 100 + f.auctionFeeKr)
      : null;
  return {
    house: cfg.house,
    externalId: it.id,
    partExternalId: it.id,
    auctionExternalId: it.id,
    title: it.title,
    description: detail?.description ?? null,
    location: null,
    status: endedByTime ? "ended" : "active",
    endsAt: it.endsAt,
    minBid: null,
    currentBid: it.currentBid,
    bidCount: null,
    reserveStatus: null,
    // Avgift inkl moms ur detaljens attribut; utan → external-fallback.
    feeValue: fee,
    // Objektsmoms (data-item-vat, oftast 0 = VMB) läggs på budet av motorn.
    vatRate: fee != null ? (f!.itemVatRate ?? 0) * 100 : null,
    currency: "SEK",
    seller: cfg.seller,
    listedAt: null,
    media: mapMedia(it, cfg),
    sourceUrl: sourceUrl(it, cfg),
    raw: { item: it, detail } as unknown as RawPayload,
  };
}
