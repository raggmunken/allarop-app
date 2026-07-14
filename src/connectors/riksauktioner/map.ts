/**
 * Normalisering: Riksauktioner-objekt → projektets domäntyper.
 * Riksauktioner är ETT hus (seller = "Riksauktioner"); fält-`seller` i API:t är
 * ett numeriskt uppdragsgivar-id, inte ett husnamn.
 */

import {
  NormalizedAuction,
  NormalizedBid,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { RiksBid, RiksImage, RiksItem } from "./client.ts";

export const HOUSE = "riksauktioner";
const ORIGIN = "https://riksauktioner.se";

/** Bästa display-URL för en bild: 1024 → 1920 → original. */
function imageUrl(img?: RiksImage): string | null {
  if (!img) return null;
  return img.sizes?.["1024x1024"] || img.sizes?.["1920"] || img.url || null;
}

function mapImages(it: RiksItem): NormalizedMedia[] {
  const imgs: (RiksImage | undefined)[] = [
    it.embed?.thumbnail,
    ...(it.embed?.gallery ?? []),
  ];
  const out: NormalizedMedia[] = [];
  const seen = new Set<string>();
  let sort = 1;
  for (const img of imgs) {
    const url = imageUrl(img);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ kind: "image", url, sort: sort++ });
    }
  }
  return out;
}

function metaValue(it: RiksItem, key: string): string | null {
  return (it.auction_meta ?? []).find((m) => m.key === key)?.value ?? null;
}

export function mapAuction(it: RiksItem): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: String(it.auction ?? it.id),
    title: it.auction_name ?? `Riksauktioner ${it.auction ?? ""}`.trim(),
    description: null,
    contact: metaValue(it, "Kontaktperson"),
    sourceUrl: ORIGIN,
  };
}

export function mapItem(it: RiksItem, minStartBid = 50): NormalizedItem {
  const active = it.status === "available" && it.auction_status !== "ended";
  return {
    house: HOUSE,
    externalId: String(it.id),
    partExternalId: String(it.auction ?? ""),
    auctionExternalId: String(it.auction ?? ""),
    title: it.title ?? "",
    description: it.description ?? null,
    location: metaValue(it, "Adress"),
    status: active ? "active" : "ended",
    endsAt: it.ending ?? null,
    // Minsta första bud = kategorins bid_step (50 kr vanligt; 500 kr för fordon/
    // entreprenad). Verifierat inloggad 2026-06-27: 50 kr → total 188 matchar
    // sajten, och fordon visar 500 kr. Ger objekt utan bud en korrekt "från"-total.
    minBid: minStartBid,
    currentBid: it.leading_bid ?? null,
    bidCount: it.num_bids_placed ?? 0,
    feeValue: null, // klubbavgift = procentmodell (se fees/rules.ts)
    // Objektsmoms per objekt: momsbefriat (vissa fordon) = 0, annars 25 %.
    vatRate: it.no_tax === "YES" ? 0 : 25,
    currency: "SEK",
    seller: "Riksauktioner",
    listedAt: it.added ?? null,
    media: mapImages(it),
    sourceUrl: `${ORIGIN}/objekt/${it.id}`,
    raw: it as unknown as RawPayload,
  };
}

export function mapBid(b: RiksBid, itemId: number): NormalizedBid {
  const created =
    b.time ??
    (b.time_placed ? new Date(b.time_placed).toISOString() : new Date().toISOString());
  return {
    house: HOUSE,
    externalId: String(b.id),
    itemExternalId: String(itemId),
    value: b.amount,
    type: b.auto ? "auto" : "normal",
    createdAt: created,
    bidderId: b.user != null ? String(b.user) : null,
    bidderName: b.username ?? null,
    raw: b as unknown as RawPayload,
  };
}
