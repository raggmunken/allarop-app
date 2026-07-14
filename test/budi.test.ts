import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseCatalog, cleanImage, endIso, feeFor, parseBidInfo, parseDescription, parseFeeParams, parseGallery } from "../src/connectors/budi/client.ts";
import { mapItem, HOUSE } from "../src/connectors/budi/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "budi", n), "utf8");

describe("Budi client-parser", () => {
  it("endIso (ISO+tz → UTC)", () => {
    // +02:00 sommartid: 10:03 → 08:03 UTC
    expect(endIso("2026-07-08T10:03:00.000+02:00")).toBe("2026-07-08T08:03:00.000Z");
    // &#x2B; = + (avkodas)
    expect(endIso("2026-07-08T09:03:00.000&#x2B;02:00")).toBe("2026-07-08T07:03:00.000Z");
    expect(endIso(null)).toBeNull();
  });

  it("cleanImage bygger ren CDN-resize ur cdn-cgi/image-URL", () => {
    const raw =
      "https://media.budi.se/cdn-cgi/image/anim=false,width=466,height=350/auctionobjects/images/abc/56.jpg";
    expect(cleanImage(raw)).toBe(
      "https://media.budi.se/cdn-cgi/image/format=auto,quality=high,width=800/auctionobjects/images/abc/56.jpg",
    );
    expect(cleanImage(null)).toBeNull();
  });

  it("parseCatalog → total + objekt (med bud / utan bud)", () => {
    const { items, total } = parseCatalog(fx("catalog.html"));
    expect(total).toBe(830);
    expect(items.length).toBe(2);

    // Med bud: currentBid satt, minBid null, bidCount, kategori/stad.
    const withBid = items.find((i) => i.id === "140806")!;
    expect(withBid.title).toContain("BMW X1");
    expect(withBid.currentBid).toBe(201000);
    expect(withBid.minBid).toBeNull();
    expect(withBid.bidCount).toBe(12);
    expect(withBid.category).toBe("vehicle");
    expect(withBid.location).toBe("Haninge");
    expect(withBid.image).toContain("cdn-cgi/image/format=auto");
    expect(withBid.endsAt).toBe("2026-07-08T08:03:00.000Z");
    expect(withBid.sourceUrl).toBe("https://www.budi.se/objekt/140806/fordon/bmw-x1-xdrive25e-m-sport-2024-laddhybrid");

    // Utan bud: currentBid null, minBid = visat belopp (utrop), bidCount 0.
    const noBid = items.find((i) => i.id === "140435")!;
    expect(noBid.currentBid).toBeNull();
    expect(noBid.minBid).toBe(600000);
    expect(noBid.bidCount).toBe(0);
    expect(noBid.location).toBe("Stockholm");
  });
});

describe("Budi batch bidinfo + beskrivning", () => {
  it("parseBidInfo → bud exkl moms, moms%, antal, reservstatus, sluttid", () => {
    const json = JSON.stringify({
      items: [
        {
          auctionObjectId: 140981,
          bidCurrentAmount: { exVat: 8100, vatAmount: 2025, vatPercentage: 25, incVat: 10125 },
          bidCount: 74,
          isReservationPriceMet: true,
          isEnded: false,
          isBiddingOpen: true,
          endingDateTimeIso: "2026-07-08T10:03:00.000+02:00",
        },
        { auctionObjectId: 141033, bidCurrentAmount: { exVat: 0, vatPercentage: 25 }, bidCount: 0, isReservationPriceMet: true, isEnded: false, isBiddingOpen: true },
      ],
    });
    const m = parseBidInfo(json);
    const a = m.get("140981")!;
    expect(a.currentBidExVat).toBe(8100);
    expect(a.vatPercentage).toBe(25);
    expect(a.bidCount).toBe(74);
    expect(a.reserveMet).toBe(true);
    expect(a.endsAt).toBe("2026-07-08T08:03:00.000Z");
    // 0 bud → exVat 0 → currentBidExVat null (visas som startbud i connectorn)
    expect(m.get("141033")!.currentBidExVat).toBeNull();
    expect(m.get("141033")!.bidCount).toBe(0);
  });

  it("parseDescription → objektbeskrivning ur meta (avkodar entiteter)", () => {
    const html = '<meta name="description" content="Obs! Taksskena medf&#xF6;ljer ej. Takh&#xF6;jd ca 5 m." />';
    expect(parseDescription(html)).toBe("Obs! Taksskena medföljer ej. Takhöjd ca 5 m.");
    expect(parseDescription("<html></html>")).toBeNull();
  });

  it("parseGallery → EGNA galleriet (bas-filtrerat), huvudbild först, rena resize-URL:er", () => {
    const html = `
      <img src="https://media.budi.se/cdn-cgi/image/width=466/auctionobjects/images/centurlosore1/102-2.jpg">
      <img src="https://media.budi.se/auctionobjects/images/centurlosore1/102.jpg">
      <img src="https://media.budi.se/cdn-cgi/image/width=466/auctionobjects/images/centurlosore1/102.jpg">
      <img src="https://media.budi.se/auctionobjects/images/centurlosore1/45.jpg">
      <img src="https://media.budi.se/auctionobjects/images/annatkonto9/7.jpg">`;
    const main = "https://media.budi.se/cdn-cgi/image/format=auto,quality=high,width=800/auctionobjects/images/centurlosore1/102.jpg";
    const g = parseGallery(html, main);
    expect(g.length).toBe(2); // dedupe + FRÄMMANDE baser bort (45.jpg, annatkonto9 - "fler objekt"-läckan)
    expect(g[0]).toBe("https://media.budi.se/cdn-cgi/image/format=auto,quality=high,width=800/auctionobjects/images/centurlosore1/102.jpg"); // huvudbild först
    expect(g[1]).toContain("102-2.jpg");
    expect(parseGallery(html)).toEqual([]); // okänd bas → tomt (kortets thumbnail används)
  });
});

describe("Budi serviceavgift", () => {
  it("parseFeeParams: fast avgift ur objektsidans data-attribut (verifierat 2026-07-03)", () => {
    const html = `<div data-budi-servicefee-type="1" data-budi-servicefee-exvat="8000"
      data-budi-servicefee-vatpercentage="25" data-budi-servicefee-dynpercentage-bps="0"
      data-budi-servicefee-dynpercentage-bps-configured="false"
      data-budi-servicefee-dynminexvat="0" data-budi-servicefee-dynminexvat-configured="false">`;
    const p = parseFeeParams(html)!;
    expect(p.fixedExVat).toBe(8000);
    expect(p.dynBps).toBe(0);
    expect(p.vatPct).toBe(25);
    expect(parseFeeParams("<html></html>")).toBeNull();
  });

  it("feeFor: fast resp. dynamisk (bps + min); null utan bud/parametrar", () => {
    const fixed = { fixedExVat: 8000, dynBps: 0, dynMinExVat: 0, vatPct: 25 };
    expect(feeFor(fixed, 646000)).toBe(8000);
    // FAQ-exemplet: 16 % med min 195 kr.
    const dyn = { fixedExVat: null, dynBps: 1600, dynMinExVat: 195, vatPct: 25 };
    expect(feeFor(dyn, 10000)).toBe(1600);
    expect(feeFor(dyn, 500)).toBe(195); // under min → min
    expect(feeFor(dyn, null)).toBeNull();
    expect(feeFor(null, 10000)).toBeNull();
  });

  it("mapItem: fast avgift + momsfri försäljning → total = bud + avgift*1,25", () => {
    // Mercedes AMG GT S (verifierat 2026-07-03): bud 646 000 (moms 0), fast avgift 8 000.
    const withBid = parseCatalog(fx("catalog.html")).items.find((i) => i.id === "140806")!;
    withBid.currentBid = 646000;
    withBid.vatPercentage = 0;
    withBid.feeParams = { fixedExVat: 8000, dynBps: 0, dynMinExVat: 0, vatPct: 25 };
    const n = mapItem(withBid, new Date("2020-01-01"));
    expect(n.feeValue).toBe(8000);
    expect(n.vatRate).toBe(0);
    const total = computeTotal(
      { bid: 646000, sourceFeeValue: n.feeValue, sourceVatRate: n.vatRate },
      feeModelFor("budi"),
    );
    expect(total.basis).toBe("source");
    expect(total.total).toBe(646000 + 8000 + 2000); // avgiften får alltid 25 % moms
  });
});

describe("Budi normalisering", () => {
  it("mapItem: seller, currentBid; utan avgiftsparametrar → external-fallback", () => {
    const withBid = parseCatalog(fx("catalog.html")).items.find((i) => i.id === "140806")!;
    const n = mapItem(withBid, new Date("2020-01-01"));
    expect(n.house).toBe(HOUSE);
    expect(n.seller).toBe("Budi Auktioner");
    expect(n.currentBid).toBe(201000);
    expect(n.status).toBe("active");
    expect(n.feeValue).toBeNull(); // inga parametrar berikade än
    const total = computeTotal({ bid: 201000 }, feeModelFor("budi"));
    expect(total.basis).toBe("external"); // ingen fejkad total
    expect(total.total).toBe(201000);
  });
});
