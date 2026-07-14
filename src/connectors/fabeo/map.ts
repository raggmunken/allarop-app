/**
 * Normalisering: Fabeo (WooCommerce-produkt + objektsidans realtidsdata) →
 * projektets domäntyper. Fabeo är ETT hus (seller = "Fabeo"); varje auktion är
 * ETT objekt (ingen part/auktion-gruppering) → auktions-id = produkt-id.
 */

import {
  NormalizedAuction,
  NormalizedBid,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { FabeoBidRow, FabeoDetail, FabeoProduct } from "./client.ts";

export const HOUSE = "fabeo";
const ORIGIN = "https://fabeo.se";

const SV_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

/** Tolka årslös svensk tid ("24 jun 22:22") → ISO. År härleds (framtid → förra året). */
export function inferSwedishDate(text: string, now = new Date()): string {
  const m = /^(\d{1,2})\s+([a-zåäö]{3})\.?\s+(\d{1,2}):(\d{2})$/i.exec(text.trim());
  if (!m) return now.toISOString();
  const day = Number(m[1]);
  const month = SV_MONTHS[(m[2] ?? "").toLowerCase()];
  const hh = Number(m[3]);
  const mm = Number(m[4]);
  if (month == null) return now.toISOString();
  let year = now.getFullYear();
  let d = new Date(year, month, day, hh, mm);
  // Budet kan inte ligga i framtiden → om datumet hamnar efter "nu" tillhör det förra året.
  if (d.getTime() > now.getTime() + 86_400_000) {
    year -= 1;
    d = new Date(year, month, day, hh, mm);
  }
  return d.toISOString();
}

function mapImages(p: FabeoProduct): NormalizedMedia[] {
  const out: NormalizedMedia[] = [];
  const seen = new Set<string>();
  let sort = 1;
  for (const img of p.images ?? []) {
    const url = img.src;
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ kind: "image", url, sort: sort++ });
    }
  }
  return out;
}

export function mapAuction(p: FabeoProduct): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: String(p.id),
    title: p.name ?? `Fabeo ${p.id}`,
    description: null,
    sourceUrl: p.permalink ?? ORIGIN,
  };
}

export function mapItem(p: FabeoProduct, d: FabeoDetail | null): NormalizedItem {
  const endUnix = d?.endUnix ?? null;
  const endsAt = endUnix != null ? new Date(endUnix * 1000).toISOString() : null;
  const live =
    d?.status === "running" && (endUnix == null || endUnix * 1000 > Date.now());
  return {
    house: HOUSE,
    externalId: String(p.id),
    partExternalId: String(p.id),
    auctionExternalId: String(p.id),
    title: p.name ?? "",
    description: p.description ?? p.short_description ?? null,
    location: null,
    status: live ? "active" : "ended",
    endsAt,
    // Utropspris (Startbud) = "från"-pris → driver totalen för 0-budsobjekt.
    minBid: d?.startBid ?? null,
    currentBid: d?.currentBid ?? null,
    bidCount: d?.bidCount ?? 0,
    // Reservpris-status (Fabeo visar bara status, ej värdet): true→uppnått, false→ej.
    reserveStatus: d?.reserveMet == null ? null : d.reserveMet ? "met" : "not_met",
    // Slagavgift per objekt (kr) ur objektsidan → source-läget i avgiftsmotorn.
    feeValue: d?.feeValue ?? null,
    // Objektsmoms på budet (25 normalt, 0 momsbefriat). Slagavgiften får alltid
    // 25 % via feeModelFor("fabeo").feeVatRate.
    vatRate: d?.vatRate ?? 25,
    currency: p.prices?.currency_code ?? "SEK",
    seller: "Fabeo",
    listedAt: null,
    media: mapImages(p),
    sourceUrl: p.permalink ?? `${ORIGIN}/auktioner/${p.slug ?? p.id}/`,
    raw: { product: p, detail: d } as unknown as RawPayload,
  };
}

export function mapBid(b: FabeoBidRow, itemId: number, now = new Date()): NormalizedBid {
  return {
    house: HOUSE,
    externalId: b.logId,
    itemExternalId: String(itemId),
    value: b.value,
    type: "normal",
    createdAt: inferSwedishDate(b.dateText, now),
    bidderId: null,
    // Fabeo anonymiserar budgivare till ett löpnummer per auktion (t.ex. "2").
    bidderName: b.bidder,
    raw: b as unknown as RawPayload,
  };
}
