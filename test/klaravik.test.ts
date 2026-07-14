import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { fullImage, parseDescription, parseDetail, parseGallery, type KlaravikItem } from "../src/connectors/klaravik/client.ts";
import { mapItem, vatForCategory } from "../src/connectors/klaravik/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "klaravik", n), "utf8");
const items = (): KlaravikItem[] => JSON.parse(fx("list.json")).data.items;

describe("Klaravik list-API", () => {
  it("har 60 objekt med bud, avgift, kategori, bild", () => {
    const list = items();
    expect(list.length).toBe(60);
    const first = list[0]!;
    expect(first.currentBid).toBeGreaterThan(0);
    expect(first.auctionFee).toBeGreaterThan(0);
    expect(first.categoryNameLevel1).toBeTruthy();
    expect(first.mainImage?.imageUrlThumb).toContain("klaravik.com");
  });
});

describe("Klaravik moms-heuristik per kategori", () => {
  it("Fordon = 0 % (VMB), maskinkategorier = 25 %", () => {
    expect(vatForCategory("Fordon")).toBe(0);
    expect(vatForCategory("Entreprenad")).toBe(25);
    expect(vatForCategory("Lantbruk")).toBe(25);
    expect(vatForCategory(null)).toBe(25);
  });
});

describe("Klaravik fullstor bild", () => {
  it("byter _thumblarge mot _large och strippar ?v=-cachebustern", () => {
    expect(fullImage("https://x/abc_thumblarge.jpg?v=1")).toBe("https://x/abc_large.jpg");
    expect(fullImage("https://x/abc_thumblarge.jpg")).toBe("https://x/abc_large.jpg");
    expect(fullImage(null)).toBeNull();
  });
});

describe("Klaravik galleri ur objektsidan", () => {
  it("plockar objektets EGNA bilder (ej relaterade objekt), fullstora", () => {
    const imgs = parseGallery(fx("detail-fordon.html"), 3239425);
    expect(imgs.length).toBeGreaterThan(10); // Audin har 40+ foton
    for (const u of imgs) {
      expect(u).toContain("/3239425/"); // bara detta objekts sökväg
      expect(u).toContain("_large");
      expect(u).not.toContain("_thumblarge");
    }
  });

  it("returnerar inga bilder för ett okänt objekt-id", () => {
    expect(parseGallery(fx("detail-fordon.html"), 99999999)).toHaveLength(0);
  });
});

describe("Klaravik brödtext (div.product-grid__content)", () => {
  const d = parseDescription(fx("detail-fordon.html"));

  it("extraherar specar + utrustning + skick", () => {
    expect(d).toBeTruthy();
    expect(d).toContain("Märke");
    expect(d).toContain("Mätarställning");
    expect(d).toContain("Utrustning");
    expect(d).toContain("Skick");
  });

  it("klipper bort Klaravik-standardtext (videovisning/villkor/CO₂)", () => {
    expect(d).not.toContain("Viktig information");
    expect(d).not.toContain("auktionsmäklare");
    expect(d).not.toContain("Hur har vi räknat");
  });

  it("mapItem speglar beskrivningen", () => {
    const it = mapItem({ id: 3239425, name: "Audi RSQ8" } as KlaravikItem, undefined, d);
    expect(it.description).toContain("Mätarställning");
  });
});

describe("Klaravik objektsido-parser (inbäddad JSON)", () => {
  it("läser bud, moms (0 för fordon), sluttid, status", () => {
    const d = parseDetail(fx("detail-fordon.html"));
    expect(d).toBeTruthy();
    expect(d!.currentBid).toBe(803000);
    expect(d!.vat).toBe(0); // Audi = VMB
    expect(d!.endUnix).toBe(1782893880);
    expect(d!.ended).toBe(false);
  });
});

describe("Klaravik avgift = source-läge (exakt auctionFee + objektsmoms)", () => {
  it("maskin 25 %: bud 3 000 000 + avgift 50 000 → 3 800 000", () => {
    const b = computeTotal(
      { bid: 3000000, sourceFeeValue: 50000, sourceVatRate: 25 },
      feeModelFor("klaravik"),
    );
    expect(b.fee).toBe(50000);
    expect(b.vat).toBe(750000); // 25 % av budet; avgiften inkl moms (feeVatRate 0)
    expect(b.total).toBe(3800000);
  });

  it("fordon 0 % (VMB): bud 803 000 + avgift 17 500 → 820 500", () => {
    const b = computeTotal(
      { bid: 803000, sourceFeeValue: 17500, sourceVatRate: 0 },
      feeModelFor("klaravik"),
    );
    expect(b.total).toBe(820500);
  });
});

describe("Klaravik normalisering", () => {
  it("mapItem speglar bud/avgift/moms/plats/bild/säljare", () => {
    const it = items().find((x) => x.categoryNameLevel1 === "Entreprenad")!;
    const n = mapItem(it);
    expect(n.house).toBe("klaravik");
    expect(n.externalId).toBe(String(it.id));
    expect(n.currentBid).toBe(it.currentBid);
    expect(n.feeValue).toBe(it.auctionFee);
    expect(n.vatRate).toBe(25); // Entreprenad
    expect(n.currency).toBe("SEK");
    expect(n.seller).toBe("Klaravik");
    expect(n.media[0]!.url).toContain("_large");
    expect(n.sourceUrl).toContain("klaravik.se");
  });

  it("mapItem med vatOverride (exakt moms ur fetchItem)", () => {
    const it = items()[0]!;
    expect(mapItem(it, 0).vatRate).toBe(0);
  });
});
