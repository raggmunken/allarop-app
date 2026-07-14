import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseList, parseLotDescription, parseTotalEntries } from "../src/connectors/bukowskis/client.ts";
import { mapItem } from "../src/connectors/bukowskis/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelForItem } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "fixtures", "bukowskis", "lots.html"), "utf8");

describe("Bukowskis listparser", () => {
  const lots = parseList(html);

  it("plockar alla 100 lotter + totalantal", () => {
    expect(lots).toHaveLength(100);
    expect(parseTotalEntries(html)).toBe(1588);
  });

  it("kopplar lot-id, objekt-id, auktionskod och sluttid rätt (ingen off-by-one)", () => {
    const first = lots[0]!;
    expect(first.lotId).toBe("2439519");
    expect(first.objectId).toBe("1723460");
    expect(first.auctionCode).toBe("E1345");
    expect(first.endUnix).toBe(1782569640);
    expect(first.title).toContain("Taklampa");
    expect(first.href).toContain("/sv/auctions/E1345/lots/1723460-");
  });

  it("läser bud + valuta per lot (EUR och SEK)", () => {
    const eur = lots[0]!;
    expect(eur.currentBid).toBe(120);
    expect(eur.currency).toBe("EUR");
    expect(eur.estimate).toBe(250);
    const sek = lots.find((l) => l.currency === "SEK" && l.hasBids)!;
    expect(sek.currentBid).toBeGreaterThan(0);
  });

  it("hanterar 'Inga bud' (currentBid null, utrop kvar)", () => {
    const nob = lots.find((l) => !l.hasBids)!;
    expect(nob.currentBid).toBeNull();
    expect(nob.estimate).toBeGreaterThan(0);
  });

  it("extraherar separata bild-URL:er (inte hela JSON-arrayen)", () => {
    const imgs = lots[0]!.images;
    expect(imgs.length).toBeGreaterThan(1);
    for (const u of imgs) {
      expect(u).toMatch(/^https:\/\/[a-z0-9]+\.cloudfront\.net\//);
      expect(u).not.toContain("&quot;");
      expect(u).not.toContain(",");
    }
  });

  it("inga saknade titlar/sluttider/objekt-id", () => {
    expect(lots.filter((l) => !l.title)).toHaveLength(0);
    expect(lots.filter((l) => l.endUnix == null)).toHaveLength(0);
    expect(lots.filter((l) => !l.objectId)).toHaveLength(0);
  });
});

describe("Bukowskis avgift (25 % inkl moms + fast avgift per valuta)", () => {
  it("SEK: bud 4 200 → 4 200×1,25 + 50 = 5 300", () => {
    const b = computeTotal({ bid: 4200 }, feeModelForItem("bukowskis", "SEK"));
    expect(b.fee).toBe(1100); // 25 % av 4 200 + 50 = 1 050 + 50
    expect(b.vat).toBe(0); // provision inkl moms
    expect(b.total).toBe(5300);
  });

  it("EUR: bud 120 → 120×1,25 + 5,06 = 155,06 → 155", () => {
    const b = computeTotal({ bid: 120 }, feeModelForItem("bukowskis", "EUR"));
    expect(b.total).toBe(155); // 150 + 5,06 avrundat
  });
});

describe("Bukowskis normalisering", () => {
  it("mapItem speglar bud/utrop/valuta/säljare/bild/sluttid", () => {
    const lot = parseList(html)[0]!;
    const it = mapItem(lot);
    expect(it.house).toBe("bukowskis");
    expect(it.externalId).toBe("2439519");
    expect(it.currentBid).toBe(120);
    expect(it.minBid).toBe(250); // utrop
    expect(it.currency).toBe("EUR");
    expect(it.seller).toBe("Bukowskis");
    expect(it.vatRate).toBe(0);
    expect(it.media.length).toBeGreaterThan(1);
    expect(it.sourceUrl).toContain("/sv/auctions/E1345/lots/1723460-");
    expect(it.endsAt).toBe(new Date(1782569640 * 1000).toISOString());
  });
});

describe("Bukowskis detaljbeskrivning", () => {
  it("parseLotDescription: c-lot-description (online-lot) → stycken radbrutna", () => {
    const detail =
      '<div class="c-market-lot-show-lot__description"><div class="c-lot-description">' +
      '<p>Carl Johan De Geer, &quot;Fantomen&quot;</p><p>F&auml;rglitografi, 190/290.</p> </div>' +
      '<div class="c-lot-placement">Placering</div></div>';
    expect(parseLotDescription(detail)).toBe('Carl Johan De Geer, "Fantomen"\nFärglitografi, 190/290.');
  });

  it("parseLotDescription: lot-description (auktionslot) och null utan div", () => {
    expect(parseLotDescription('<div class="lot-description"><p>Oramad.</p></div>')).toBe("Oramad.");
    expect(parseLotDescription("<div><p>inget</p></div>")).toBeNull();
  });
});
