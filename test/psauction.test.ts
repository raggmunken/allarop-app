import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseList,
  parseLive,
  parseDetail,
  parseTotalPages,
} from "../src/connectors/psauction/client.ts";
import { mapItem, mapBids, parseExactEnd } from "../src/connectors/psauction/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "psauction", n), "utf8");

describe("PS Auction listparser (/search SSR)", () => {
  const html = fx("search.html");
  const list = parseList(html);

  it("plockar 20 kort/sida med id, titel, sluttid, plats, bud, bild", () => {
    expect(list.length).toBe(20);
    expect(list.every((i) => i.itemId && i.liveId)).toBe(true);
    expect(list.filter((i) => i.endText != null).length).toBe(20);
    expect(list.filter((i) => i.title.length > 0).length).toBe(20);
  });

  it("läser första objektet (itemId/liveId, åäö-titel, plats, bud)", () => {
    const v = list[0]!;
    expect(v.itemId).toBe("1407574");
    expect(v.liveId).toBe("1840151");
    expect(v.title).toContain("Arbetskläder");
    expect(v.endText).toBe("2026-06-28 14:00");
    expect(v.location).toBe("25467 Helsingborg");
    expect(v.currentBid).toBe(100);
    expect(v.href).toBe("/item/view/1407574/arbetsklader-5-st-trojor-sweatshirt-m-m-stl-xs");
    expect(v.image).toMatch(/cloudfront\.net.*item_image_normal\.(jpg|png)$/);
  });

  it("totalt antal sidor ur pagineringen", () => {
    expect(parseTotalPages(html)).toBeGreaterThan(100);
  });
});

describe("PS Auction live-data (/item/json)", () => {
  const live = parseLive(fx("item.json"))!;

  it("läser bud, exakt sluttid, objektsmoms och budhistorik", () => {
    expect(live.liveId).toBe("1840151");
    expect(live.currentBid).toBe(100);
    expect(live.nextMinBid).toBe(200);
    expect(live.endText).toBe("2026-06-28 14:00");
    expect(live.vatRate).toBe(25);
    expect(live.active).toBe(true);
    expect(live.bids.length).toBe(1);
  });

  it("budhistorik bär riktiga användarnamn + id (PS anonymiserar ej)", () => {
    const b = live.bids[0]!;
    expect(b.bidderName).toBe("charlieay");
    expect(b.bidderId).toBe("194754");
    expect(b.value).toBe(100);
  });
});

describe("PS Auction objektsida (beskrivning + galleri)", () => {
  const d = parseDetail(fx("detail.html"), 1407574);

  it("extraherar specar + brödtext, utan juridik-boilerplate", () => {
    expect(d.description).toContain("Skick på objekt");
    expect(d.description).toContain("Paket med blandade arbetskläder");
    expect(d.description).not.toContain("Buden är bindande");
    expect(d.description).not.toContain("SERVICEAVGIFT");
  });

  it("plockar galleriet i full storlek (_normal), utan dubbletter", () => {
    expect(d.images.length).toBeGreaterThan(1);
    expect(new Set(d.images).size).toBe(d.images.length);
    for (const u of d.images) expect(u).toMatch(/item_image_normal\.(jpg|jpeg|png)$/);
  });
});

describe("PS Auction sluttid (svensk lokaltid → UTC)", () => {
  it("'2026-06-28 14:00' (CEST) → 12:00 UTC", () => {
    expect(parseExactEnd("2026-06-28 14:00")).toBe("2026-06-28T12:00:00.000Z");
  });
});

describe("PS Auction avgift (serviceavgift 16 % + 25 % moms på avgiften)", () => {
  it("bud 100 (25 % moms) → 100 + 25 + 16 + 4 = 145", () => {
    const b = computeTotal(
      { bid: 100, sourceFeeValue: null, sourceVatRate: 25 },
      feeModelFor("psauction"),
    );
    expect(b.fee).toBe(16);
    expect(b.vat).toBe(29); // 25 (objektsmoms) + 4 (25 % på serviceavgiften)
    expect(b.total).toBe(145);
  });

  it("marginalbeskattat (0 % objektsmoms): bud 1000 → 1000 + 160 + 40 = 1200", () => {
    const b = computeTotal(
      { bid: 1000, sourceFeeValue: null, sourceVatRate: 0 },
      feeModelFor("psauction"),
    );
    expect(b.total).toBe(1200);
  });
});

describe("PS Auction normalisering (kort + live + detalj)", () => {
  const v = parseList(fx("search.html"))[0]!;
  const live = parseLive(fx("item.json"));
  const det = parseDetail(fx("detail.html"), v.itemId);
  const now = new Date("2026-06-28T00:00:00Z");

  it("mapItem speglar bud/sluttid/moms/galleri/säljare", () => {
    const it = mapItem(v, det, live, now);
    expect(it.house).toBe("psauction");
    expect(it.externalId).toBe("1407574");
    expect(it.currentBid).toBe(100);
    expect(it.vatRate).toBe(25);
    expect(it.endsAt).toBe("2026-06-28T12:00:00.000Z");
    expect(it.status).toBe("active");
    expect(it.seller).toBe("PS Auction");
    expect(it.media.length).toBeGreaterThan(1);
    expect(it.description).toContain("Skick");
  });

  it("mapBids ger bud-rader med budgivaridentitet", () => {
    const bids = mapBids(v, live);
    expect(bids.length).toBe(1);
    expect(bids[0]!.bidderName).toBe("charlieay");
    expect(bids[0]!.itemExternalId).toBe("1407574");
  });
});
