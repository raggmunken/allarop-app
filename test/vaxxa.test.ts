import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseSearch, unixToIso, parseDetail } from "../src/connectors/vaxxa/client.ts";
import { mapItem, HOUSE } from "../src/connectors/vaxxa/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "vaxxa", n), "utf8");

describe("Vaxxa client-parser", () => {
  it("unixToIso (unix-sekunder → UTC)", () => {
    expect(unixToIso(1700000000)).toBe("2023-11-14T22:13:20.000Z");
    expect(unixToIso(null)).toBeNull();
  });

  it("parseSearch → found + objekt (bud / utan bud)", () => {
    const { items, found } = parseSearch(fx("search.json"));
    expect(found).toBe(167);
    expect(items.length).toBe(3);

    const withBid = items.find((i) => i.externalId === "215911")!;
    expect(withBid.currentBid).toBe(100);
    expect(withBid.bidCount).toBe(1);
    expect(withBid.reserveMet).toBe(true);
    expect(withBid.image).toContain("images.vaxxa.se");
    expect(withBid.endsAt).toBe(unixToIso(1782925380));

    const noBid = items.find((i) => i.externalId === "214777")!;
    expect(noBid.currentBid).toBeNull(); // price 0 + 0 bud
    expect(noBid.bidCount).toBe(0);
    expect(noBid.reserveMet).toBe(false);
  });
});

describe("Vaxxa parseDetail (galleri + beskrivning ur objektsidan)", () => {
  it("plockar bara detta objekts s=full-bilder + meta-beskrivning", () => {
    const html = `
      <meta name="description" content="Original batteriladdare fr&#xE5;n STIGA." />
      <img src="https://images.vaxxa.se/214777/s=full/447206.jpg">
      <img src="https://images.vaxxa.se/214777/s=full/447207.jpg">
      <img src="https://images.vaxxa.se/214777/s=list/447206.jpg">
      <img src="https://images.vaxxa.se/999999/s=full/111.jpg">`;
    const d = parseDetail("214777", html);
    expect(d.images.length).toBe(2); // bara s=full för 214777 (ej s=list, ej annat objekt)
    expect(d.images[0]).toContain("214777/s=full/447206");
    expect(d.description).toBe("Original batteriladdare från STIGA.");
  });
});

describe("Vaxxa normalisering (reservstatus + avgifter)", () => {
  it("mapItem: reservstatus met/not_met, sourceUrl med old_id; utan avgift → external", () => {
    const items = parseSearch(fx("search.json")).items;
    const withBid = mapItem(items.find((i) => i.externalId === "215911")!, new Date("2020-01-01"));
    expect(withBid.house).toBe(HOUSE);
    expect(withBid.seller).toBe("Vaxxa");
    expect(withBid.reserveStatus).toBe("met");
    expect(withBid.sourceUrl).toBe("https://app.vaxxa.se/auctions/215911");
    expect(withBid.feeValue).toBeNull(); // ingen avgift hämtad än

    const noBid = mapItem(items.find((i) => i.externalId === "214777")!, new Date("2020-01-01"));
    expect(noBid.reserveStatus).toBe("not_met");

    const total = computeTotal({ bid: 100 }, feeModelFor("vaxxa"));
    expect(total.basis).toBe("external"); // serviceavgift ej hämtad → ingen fejkad total
    expect(total.total).toBe(100);
  });

  it("mapItem: hämtad avgift + momsstatus → verklig total; okänd moms → external", () => {
    // Verifierat mot getProductFeeAction 2026-07-03: objekt 216343, bud 47 000 → fee 3 400.
    const items = parseSearch(fx("search.json")).items;
    const it0 = items.find((i) => i.externalId === "215911")!;
    it0.currentBid = 47000;
    it0.feeExVat = 3400;
    it0.isTaxable = false; // momsfri försäljning
    const n = mapItem(it0, new Date("2020-01-01"));
    expect(n.feeValue).toBe(3400);
    expect(n.vatRate).toBe(0);
    const total = computeTotal(
      { bid: 47000, sourceFeeValue: n.feeValue, sourceVatRate: n.vatRate },
      feeModelFor("vaxxa"),
    );
    expect(total.basis).toBe("source");
    expect(total.total).toBe(47000 + 3400 + 850); // avgiften alltid +25 % moms

    // Momspliktigt objekt (is_taxable 1): +25 % även på budet.
    it0.isTaxable = true;
    const n2 = mapItem(it0, new Date("2020-01-01"));
    expect(n2.vatRate).toBe(25);
    const total2 = computeTotal(
      { bid: 47000, sourceFeeValue: n2.feeValue, sourceVatRate: n2.vatRate },
      feeModelFor("vaxxa"),
    );
    expect(total2.total).toBe(47000 + 11750 + 3400 + 850);

    // Okänd momsstatus → avgift undanhålls (annars saknas budmoms i totalen) → external.
    it0.isTaxable = null;
    expect(mapItem(it0, new Date("2020-01-01")).feeValue).toBeNull();
  });

  it("parseDetail: is_taxable ur inbäddad payload", () => {
    expect(parseDetail("1", '<html>\\"is_taxable\\":0,</html>').taxable).toBe(false);
    expect(parseDetail("1", '<html>\\"is_taxable\\":1,</html>').taxable).toBe(true);
    expect(parseDetail("1", "<html></html>").taxable).toBeNull();
  });
});

describe("Vaxxa köp nu-pris + minimiavgift (fixade 2026-07-06)", () => {
  it("BUY_NOW utan bud: price → buyNowPrice → minBid + exakt total på priset", () => {
    const items = parseSearch(fx("search.json")).items;
    const buyNow = items.find((i) => i.listingType === "BUY_NOW");
    expect(buyNow).toBeDefined();
    expect(buyNow!.currentBid).toBeNull(); // 0 bud
    expect(buyNow!.buyNowPrice).toBeGreaterThan(0);
    buyNow!.isTaxable = false;
    buyNow!.feeExVat = 3400;
    const n = mapItem(buyNow!, new Date("2020-01-01"));
    expect(n.minBid).toBe(buyNow!.buyNowPrice); // priset syns
    const total = computeTotal(
      { bid: n.minBid!, sourceFeeValue: n.feeValue, sourceVatRate: n.vatRate },
      feeModelFor("vaxxa"),
    );
    expect(total.basis).toBe("source");
    expect(total.total).toBe(n.minBid! + 3400 + 850); // pris + avgift + avgiftsmoms
  });

  it("AUCTION utan bud: inget utrop (minBid null) men minimiavgiften fee(0) exponeras", () => {
    const items = parseSearch(fx("search.json")).items;
    const noBid = items.find((i) => i.listingType === "AUCTION" && i.bidCount === 0);
    expect(noBid).toBeDefined();
    expect(noBid!.buyNowPrice).toBeNull();
    noBid!.isTaxable = false;
    noBid!.feeExVat = 140; // fee(0) = minimiavgift, som Vaxxas objektsida visar
    const n = mapItem(noBid!, new Date("2020-01-01"));
    expect(n.minBid).toBeNull(); // budgivning startar fritt - inget fejkat utrop
    expect(n.feeValue).toBe(140); // men avgiften syns
  });
});
