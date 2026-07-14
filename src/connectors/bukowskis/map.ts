/**
 * Normalisering: Bukowskis-lot (ur listsidan) → projektets domäntyper.
 * Bukowskis är ETT hus (seller = "Bukowskis"); auktionskoden (t.ex. "E1345")
 * grupperar lotter i en auktion. Internationellt → valuta per lot (SEK/EUR).
 * Budgivare visas anonymt → vi lagrar inga bud-rader.
 */

import {
  NormalizedAuction,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { BukowskisLot } from "./client.ts";

export const HOUSE = "bukowskis";
const ORIGIN = "https://www.bukowskis.com";

function mapImages(lot: BukowskisLot): NormalizedMedia[] {
  const out: NormalizedMedia[] = [];
  let sort = 1;
  for (const url of lot.images) out.push({ kind: "image", url, sort: sort++ });
  return out;
}

/** Auktionskod, eller "online" för fristående online-lotter utan kod. */
function auctionKey(lot: BukowskisLot): string {
  return lot.auctionCode || "online";
}

export function mapAuction(lot: BukowskisLot): NormalizedAuction {
  const code = auctionKey(lot);
  return {
    house: HOUSE,
    externalId: code,
    title: code === "online" ? "Bukowskis Online" : `Bukowskis ${code}`,
    description: null,
    sourceUrl:
      code === "online" ? `${ORIGIN}/sv/lots` : `${ORIGIN}/sv/auctions/${code}/lots`,
  };
}

export function mapItem(lot: BukowskisLot, description: string | null = null): NormalizedItem {
  const endsAt =
    lot.endUnix != null ? new Date(lot.endUnix * 1000).toISOString() : null;
  const live = lot.endUnix == null || lot.endUnix * 1000 > Date.now();
  return {
    house: HOUSE,
    externalId: lot.lotId,
    partExternalId: auctionKey(lot),
    auctionExternalId: auctionKey(lot),
    title: lot.title,
    description, // lot-description-diven (berikas gradvis; upsertens COALESCE bevarar)
    location: null,
    status: live ? "active" : "ended",
    endsAt,
    // Utropspris (lågt estimat) som "från"-pris → driver totalen för 0-budslotter.
    minBid: lot.estimate,
    currentBid: lot.currentBid,
    bidCount: null, // listsidan visar inte antal bud
    feeValue: null, // procentmodell (25 % + fast avgift) i fees/rules.ts
    // Provision anges inkl moms och de flesta lotter är marginalbeskattade →
    // ingen extra objektsmoms på budet.
    vatRate: 0,
    currency: lot.currency,
    seller: "Bukowskis",
    listedAt: null,
    media: mapImages(lot),
    sourceUrl: `${ORIGIN}${lot.href}`,
    raw: lot as unknown as RawPayload,
  };
}
