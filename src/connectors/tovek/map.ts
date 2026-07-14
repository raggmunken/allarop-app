/**
 * Normalisering: Toveks råfält → projektets sajt-agnostiska domäntyper.
 * Här strippas även persondata (budgivarnamn/id) bort.
 */

import {
  NormalizedAuction,
  NormalizedBid,
  NormalizedItem,
  NormalizedMedia,
  NormalizedPart,
  RawPayload,
} from "../types.ts";
import { TOVEK_ORIGIN } from "./actions.ts";
import { TovekBidRaw, TovekItemRaw, TovekMediaRaw, TovekPartRaw } from "./client.ts";

export const HOUSE = "tovek";

function mapMedia(media?: TovekMediaRaw[], images?: string[]): NormalizedMedia[] {
  if (media && media.length > 0) {
    return media.map((m) => ({ kind: m.type, url: m.url, sort: m.sort }));
  }
  // Fallback: bara bild-URL:er utan sortordning.
  return (images ?? []).map((url, i) => ({ kind: "image" as const, url, sort: i + 1 }));
}

/**
 * Slugify för Toveks rop-URL (`/auktion/rop/{slug}/{itemId}`). Tovek jämför
 * slug:en alfanumeriskt (struntar i exakt bindestreckning), så det räcker att
 * gemener + translitterera (å/ä/ö→a/a/o m.fl. via NFD) + icke-alfanumeriskt → "-".
 */
function slugify(s?: string | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "objekt";
}

/** "0000-00-00 00:00:00" och tomma strängar → null. */
function cleanDate(s?: string | null): string | null {
  if (!s) return null;
  if (s.startsWith("0000-00-00")) return null;
  return s;
}

export function mapAuction(p: TovekPartRaw): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: String(p.auctionId),
    title: p.auctionTitle ?? "",
    description: p.auctionDescription ?? null,
    lastPayDate: cleanDate(p.auctionLastPayDate),
    contact: p.auctionContactDescription ?? null,
    sourceUrl: `${TOVEK_ORIGIN}/auktioner/pagaende-auktioner`,
  };
}

export function mapPart(p: TovekPartRaw): NormalizedPart {
  return {
    house: HOUSE,
    externalId: String(p.partId),
    auctionExternalId: String(p.auctionId),
    title: p.partTitle || p.auctionTitle || "",
    description: p.partDescription ?? null,
    location: p.partLocation ?? null,
    category: p.partCategory || null,
    startsAt: cleanDate(p.partAuctionStart),
    endsAt: cleanDate(p.itemLastEndDate),
    status: p.partStatus ?? "unknown",
    media: mapMedia(p.media, p.images),
    sourceUrl: `${TOVEK_ORIGIN}/auktioner/pagaende-auktioner`,
    auctionTitle: p.auctionTitle ?? null,
    auctionDescription: p.auctionDescription ?? null,
    auctionLastPayDate: cleanDate(p.auctionLastPayDate),
    auctionContact: p.auctionContactDescription ?? null,
    raw: p as unknown as RawPayload,
  };
}

export function mapItem(it: TovekItemRaw): NormalizedItem {
  return {
    house: HOUSE,
    externalId: String(it.itemId),
    partExternalId: String(it.itemPartId ?? ""),
    auctionExternalId: String(it.itemAuctionId ?? ""),
    title: it.itemTitle ?? "",
    description: it.itemDescription ?? null,
    location: it.itemLocation?.[0] ?? null,
    status: it.itemStatus ?? "unknown",
    endsAt: cleanDate(it.itemEndTime),
    minBid: it.itemMinBid ?? null,
    currentBid: it.itemWinningBidValue ?? null,
    feeValue: it.itemFeeValue ?? null,
    vatRate: it.itemVatValue ?? null,
    currency: "SEK",
    seller: "Tovek",
    media: mapMedia(it.media, it.images),
    sourceUrl: `${TOVEK_ORIGIN}/auktion/rop/${slugify(it.itemTitle)}/${it.itemId}`,
    sortNo: it.itemSortNo ?? null,
    showingStarts: cleanDate(it.address?.addressShowingStart),
    showingEnds: cleanDate(it.address?.addressShowingEnd),
    showingAddress: it.itemShowingAddress || null,
    collectStarts: cleanDate(it.address?.addressCollectStart),
    collectEnds: cleanDate(it.address?.addressCollectEnd),
    collectAddress: it.itemCollectAddress || null,
    freightHelp: it.itemFreightHelp || null,
    forkliftHelp: it.itemForkliftHelp || null,
    youtubeLink: it.itemYoutubeLink || null,
    raw: it as unknown as RawPayload,
  };
}

/** Mappa bud inkl. budgivarens identitet (privat projekt). */
export function mapBid(b: TovekBidRaw): NormalizedBid {
  return {
    house: HOUSE,
    externalId: String(b.historyBidId),
    itemExternalId: String(b.historyBidItemId),
    value: b.historyBidValue,
    type: b.historyBidType ?? null,
    createdAt: b.historyBidCreated,
    bidderId: b.historyBidUserId != null ? String(b.historyBidUserId) : null,
    bidderName: b.historyBidUsername ?? null,
    raw: b as unknown as RawPayload,
  };
}
