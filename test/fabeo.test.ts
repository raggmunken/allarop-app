import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDetail, parseKr } from "../src/connectors/fabeo/client.ts";
import { inferSwedishDate, mapBid, mapItem } from "../src/connectors/fabeo/map.ts";
import type { FabeoProduct } from "../src/connectors/fabeo/client.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  readFileSync(join(here, "fixtures", "fabeo", name), "utf8");

describe("Fabeo objektsido-parser", () => {
  it("objekt MED bud (128488): bud, slagavgift, moms, budhistorik", () => {
    const d = parseDetail(fx("detail-with-bids.html"), 128488);
    expect(d.currentBid).toBe(152000);
    expect(d.status).toBe("running");
    expect(d.feeValue).toBe(10500); // slagavgift per objekt
    expect(d.vatRate).toBe(25);
    expect(d.bidIncrement).toBe(2000);
    expect(d.reserveMet).toBe(false); // reservation_no
    expect(d.bidCount).toBe(2);
    expect(d.endUnix).toBe(1782807240);
    expect(d.bids).toHaveLength(2);
    expect(d.bids[0]).toMatchObject({ logId: "94939", value: 152000, bidder: "2" });
    expect(d.bids[1]).toMatchObject({ logId: "94374", value: 150000, bidder: "1" });
  });

  it("objekt UTAN bud (134744): utropspris, ingen current bid, egen slagavgift", () => {
    const d = parseDetail(fx("detail-no-bids.html"), 134744);
    expect(d.currentBid).toBeNull(); // data-bid=0
    expect(d.startBid).toBe(25000); // Startbud
    expect(d.feeValue).toBe(25000); // slagavgift varierar per objekt
    expect(d.bidIncrement).toBe(5000);
    expect(d.vatRate).toBe(25);
    expect(d.bidCount).toBe(0);
    expect(d.bids).toHaveLength(0);
  });

  it("parseKr tolererar mellanslag/&nbsp;/kr", () => {
    expect(parseKr("152 000&nbsp;kr")).toBe(152000);
    expect(parseKr("10 500")).toBe(10500);
    expect(parseKr("")).toBeNull();
  });
});

describe("Fabeo avgift = source-läge (slagavgift + 25 % på båda)", () => {
  it("bud 152 000 (25 %) + slagavgift 10 500 → total 203 125", () => {
    const b = computeTotal(
      { bid: 152000, sourceFeeValue: 10500, sourceVatRate: 25 },
      feeModelFor("fabeo"),
    );
    expect(b.basis).toBe("source");
    expect(b.fee).toBe(10500);
    expect(b.vat).toBe(40625); // 25 % av 152 000 + 25 % av 10 500
    expect(b.total).toBe(203125);
  });

  it("momsbefriat objekt: 0 % på budet men slagavgift får ändå 25 %", () => {
    const b = computeTotal(
      { bid: 100000, sourceFeeValue: 8000, sourceVatRate: 0 },
      feeModelFor("fabeo"),
    );
    expect(b.vat).toBe(2000); // bara 25 % av slagavgiften (8 000)
    expect(b.total).toBe(110000);
  });
});

describe("Fabeo normalisering", () => {
  const product: FabeoProduct = {
    id: 128488,
    name: "Amazone EDX 6000-T",
    slug: "amazone-edx-6000-t",
    permalink: "https://fabeo.se/auktioner/amazone-edx-6000-t/",
    images: [{ id: 1, src: "https://cdn.fabeo.se/a.jpg" }],
    prices: { currency_code: "SEK" },
  };

  it("mapItem speglar bud/utrop/avgift/valuta/säljare", () => {
    const d = parseDetail(fx("detail-with-bids.html"), 128488);
    const it = mapItem(product, d);
    expect(it.house).toBe("fabeo");
    expect(it.externalId).toBe("128488");
    expect(it.currentBid).toBe(152000);
    expect(it.feeValue).toBe(10500);
    expect(it.vatRate).toBe(25);
    expect(it.currency).toBe("SEK");
    expect(it.seller).toBe("Fabeo");
    expect(it.media).toHaveLength(1);
    expect(it.sourceUrl).toBe(product.permalink);
    expect(it.endsAt).toBe(new Date(1782807240 * 1000).toISOString());
  });

  it("inferSwedishDate härleder år (framtid → förra året)", () => {
    const now = new Date("2026-06-25T12:00:00Z");
    // 24 jun ligger före 'nu' i år → samma år.
    expect(inferSwedishDate("24 jun 22:22", now).startsWith("2026-06-24")).toBe(true);
    // 20 dec ligger efter 'nu' → förra året.
    expect(inferSwedishDate("20 dec 09:00", now).startsWith("2025-12-20")).toBe(true);
  });

  it("mapBid använder logid som stabilt bud-id + alias som namn", () => {
    const b = mapBid({ logId: "94939", value: 152000, dateText: "24 jun 22:22", bidder: "2" }, 128488);
    expect(b.externalId).toBe("94939");
    expect(b.itemExternalId).toBe("128488");
    expect(b.value).toBe(152000);
    expect(b.bidderName).toBe("2");
  });
});
