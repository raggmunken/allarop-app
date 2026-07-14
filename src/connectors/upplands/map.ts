/**
 * Normalisering: Upplands Auktionsverk (auktion + inventoryItems) → domäntyper. AVGIFTER:
 * per auktion ur /api/auctions - provision buyersPremiumPct (% EXKL moms → ×1,25) +
 * slagavgift hammerFeeTotalKr (inkl moms) → feeValue inkl allt (feeVatRate 0). Klubbat
 * belopp bär ingen egen moms (VMB) → vatRate 0. Utan bud/villkor → external-fallback.
 * Reservpris-status ur hasReserve/reserveMet. Budgivare anonyma → inga bud-rader.
 * Startbud = minBid; aktuellt/slutbud = highBid (null = inga bud/preview).
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { UpplandsAuction, UpplandsLot } from "./client.ts";

export const HOUSE = "upplands";
const BASE = "https://www.upplandsauktionsverk.se";

// Upplands har ingen per-lot-URL (lotterna visas i auktionskatalogens klient-vy) → länka
// till auktionssidan (verifierat 200; lot-route-varianter ger alla 404).
const sourceUrl = (lot: UpplandsLot) => `${BASE}/sv-SE/auctions/${lot.auctionId}`;

export function mapAuction(lot: UpplandsLot, auc: UpplandsAuction | null = null): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: String(lot.auctionId),
    title: auc?.name ?? `Upplands ${lot.auctionId}`,
    description: null,
    sourceUrl: `${BASE}/sv-SE/auctions/${lot.auctionId}`,
  };
}

function mapMedia(lot: UpplandsLot): NormalizedMedia[] {
  return lot.images.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(lot: UpplandsLot, auc: UpplandsAuction | null = null, now = new Date()): NormalizedItem {
  const endsAt = lot.endDate ?? auc?.endDate ?? null;
  const endedByTime = endsAt != null && new Date(endsAt).getTime() <= now.getTime();
  const active = !(auc?.ended ?? false) && !endedByTime;
  // Avgift ur auktionens köparvillkor: provision (exkl moms → ×1,25) + slagavgift (inkl).
  const bid = lot.highBid;
  const fee =
    bid != null && bid > 0 && auc?.buyersPremiumPct != null
      ? Math.round((bid * auc.buyersPremiumPct * 1.25) / 100 + (auc.hammerFeeTotalKr ?? 0))
      : null;
  return {
    house: HOUSE,
    externalId: String(lot.id),
    partExternalId: String(lot.auctionId),
    auctionExternalId: String(lot.auctionId),
    title: lot.name,
    description: lot.description,
    location: null,
    status: active ? "active" : "ended",
    endsAt,
    minBid: lot.minBid, // startbud (utrop)
    currentBid: lot.highBid,
    bidCount: null, // budgivning anonym, ej i listan
    // Reservpris: hasReserve=false → inget reservpris; annars met/not_met ur reserveMet.
    reserveStatus: !lot.hasReserve ? "none" : lot.reserveMet ? "met" : "not_met",
    // Avgift inkl moms ur auktionsvillkoren; utan bud/villkor → external-fallback.
    feeValue: fee,
    vatRate: fee != null ? 0 : null, // klubbat belopp utan egen moms (VMB)
    currency: "SEK",
    seller: "Upplands Auktionsverk",
    listedAt: null,
    media: mapMedia(lot),
    sourceUrl: sourceUrl(lot),
    raw: { lot, auction: auc } as unknown as RawPayload,
  };
}
