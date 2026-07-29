/**
 * Normalisering: Pantbanken-kort → domäntyper. Avgift = percentage-läge (15 % köpar-
 * provision INKL moms → total = bud * 1,15, se fees/rules.ts). Ingen objektsmoms adderas
 * (panter/begagnat säljs VMB/marginalbeskattat, momsen ingår i provisionen). Priset som
 * kortet visar är vinnande bud (om bud finns) resp. utropspris (inga bud) - avgiftsmotorn
 * baserar då totalen på minBid. Budledarens alias bärs på objektet (leaderName).
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { PantItem } from "./client.ts";

export const HOUSE = "pantbanken";
const BASE = "https://www.pantbanken.se";

const sourceUrl = (it: PantItem) => `${BASE}/auktioner/visa-auktionsvara/?f_id=${it.id}`;

export function mapAuction(it: PantItem): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.id,
    title: it.title,
    description: null,
    sourceUrl: sourceUrl(it),
  };
}

export interface PantDetail {
  description: string | null;
  images: string[];
}

function mapMedia(it: PantItem, detail: PantDetail | null): NormalizedMedia[] {
  // Berikat galleri (objektsidans imagehandler-bilder) om det finns; annars kortets bild.
  const urls = detail?.images?.length ? detail.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(it: PantItem, detail: PantDetail | null = null, now = new Date()): NormalizedItem {
  const endedByTime = it.endsAt != null && new Date(it.endsAt).getTime() <= now.getTime();
  return {
    house: HOUSE,
    externalId: it.id,
    partExternalId: it.id,
    auctionExternalId: it.id,
    title: it.title,
    description: detail?.description ?? null, // Objektinformation-tabellen (berikas gradvis; upsertens COALESCE bevarar)
    location: null,
    status: endedByTime ? "ended" : "active",
    endsAt: it.endsAt,
    minBid: it.minBid, // utropspris (inga bud) / nästa krav (har bud)
    currentBid: it.currentBid, // null om inga bud
    bidCount: it.bidCount,
    leaderName: it.leaderName, // budledarens alias (null om inga bud)
    reserveStatus: null,
    feeValue: null, // percentage-läge (15 %)
    vatRate: null, // provision inkl moms, ingen objektsmoms adderas (VMB)
    currency: "SEK",
    seller: "Pantbanken Sverige",
    listedAt: null,
    media: mapMedia(it, detail),
    sourceUrl: sourceUrl(it),
    raw: { item: it } as unknown as RawPayload,
  };
}
