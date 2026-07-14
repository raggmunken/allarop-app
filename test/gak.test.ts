import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDetail, parseList, parseSwedishMonthDate, fullImage } from "../src/connectors/gak/client.ts";
import { mapItem } from "../src/connectors/gak/map.ts";
import { GAK_HOUSES } from "../src/connectors/gak/houses.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const GAK = GAK_HOUSES.find((h) => h.house === "gak")!;

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "gak", n), "utf8");
const NOW = new Date("2026-06-30T00:00:00Z");

describe("GAK client-parsers", () => {
  it("parseSwedishMonthDate (månadnamn, utan år) + fullImage", () => {
    // augusti → CEST (+2): 15:01 lokalt = 13:01 UTC
    expect(parseSwedishMonthDate("23 augusti 15:01", NOW)).toBe("2026-08-23T13:01:00.000Z");
    expect(parseSwedishMonthDate(null, NOW)).toBeNull();
    // fullImage ger RELATIV väg (husets baseUrl sätts i mappen).
    expect(fullImage("/images/custom/AuctionItem/tn/small74173.jpg")).toBe(
      "/images/custom/AuctionItem/74173.jpg",
    );
  });

  it("parseList → kort med id/slug/titel/sluttid/bud/bild", () => {
    const items = parseList(fx("list.html"), NOW);
    expect(items.length).toBe(3);
    const it = items[0]!;
    expect(it.id).toBe("19981");
    expect(it.title).not.toMatch(/^\d+\./); // lot-prefix strippat
    expect(it.title.length).toBeGreaterThan(3);
    expect(it.endsAt).toMatch(/^2026-\d{2}-\d{2}T/);
    expect(it.image).toContain("/images/custom/AuctionItem/");
    expect(it.image).not.toContain("/tn/small");
  });
});

describe("GAK normalisering (avgift ur priceInfo-attribut)", () => {
  it("mapItem: seller, composite-id; utan avgiftsattribut → external-fallback", () => {
    const it = parseList(fx("list.html"), NOW)[0]!;
    const n = mapItem(it, GAK, null, NOW);
    expect(n.house).toBe("gak");
    expect(n.seller).toBe("Göteborgs Auktionskammare");
    expect(n.media[0]?.url).toContain("goteborgsauktionskammare.se/images/custom/AuctionItem/");
    expect(n.externalId).toBe("19981");
    expect(n.status).toBe("active");
    expect(n.feeValue).toBeNull();
    const total = computeTotal({ bid: 5000 }, feeModelFor("gak"));
    expect(total.basis).toBe("external");
    expect(total.total).toBe(5000);
  });

  it("mapItem med avgiftsattribut: total = bud × (1 + fee% + moms) + slagavgift", () => {
    // Verifierat mot sidans "Totalt med avgift och moms" 2026-07-03 (8/8: t.ex.
    // bud 200 → 290, bud 5500 → 6650 med 20 % + 50 kr).
    const it = { ...parseList(fx("list.html"), NOW)[0]!, currentBid: 5500 };
    const detail = { description: null, fee: { purchaseFeePct: 20, auctionFeeKr: 50, itemVatRate: 0 } };
    const n = mapItem(it, GAK, detail, NOW);
    expect(n.feeValue).toBe(1150); // 5500×0,20 + 50
    expect(n.vatRate).toBe(0);
    const total = computeTotal(
      { bid: 5500, sourceFeeValue: n.feeValue, sourceVatRate: n.vatRate },
      feeModelFor("gak"),
    );
    expect(total.basis).toBe("source");
    expect(total.total).toBe(6650);
  });

  it("parseDetail: avgiftsattribut ur priceInfo-diven", () => {
    const html = '<div class="priceInfo info" data-item-id="18985" data-purchase-fee="20" data-auction-fee="50" data-auction-biddingVat="yes" data-bid-price="200" data-item-vat="0.00" data-customer-type="privatePerson">Totalt med avgift och moms: <span>290 kr</span></div>';
    const d = parseDetail(html);
    expect(d.fee).toEqual({ purchaseFeePct: 20, auctionFeeKr: 50, itemVatRate: 0 });
    expect(parseDetail("<html></html>").fee).toBeNull();
  });
});
