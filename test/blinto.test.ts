import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseList, parseDetail, parseMaxBid, parseAuctionData } from "../src/connectors/blinto/client.ts";
import { mapItem, parseSwedishEnd, parseExactEnd } from "../src/connectors/blinto/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "blinto", n), "utf8");

describe("Blinto listparser (startsidans SSR)", () => {
  const list = parseList(fx("list.html"));

  it("plockar hela katalogen med bud/ort/sluttid/bild", () => {
    expect(list.length).toBeGreaterThan(900);
    expect(list.filter((i) => i.currentBid != null).length).toBe(list.length);
    expect(list.filter((i) => i.endText != null).length).toBe(list.length); // entity-å fix
    expect(list.filter((i) => i.location != null).length).toBeGreaterThan(list.length - 5);
  });

  it("läser första objektet korrekt", () => {
    const v = list.find((i) => i.objId === "267984")!;
    expect(v.title).toContain("Volvo L90F");
    expect(v.type).toBe("Hjullastare");
    expect(v.location).toBe("Hindås");
    expect(v.currentBid).toBe(249000);
    expect(v.bidCount).toBe(34);
    expect(v.endText).toBe("29 jun 09:59");
    expect(v.image).toContain("cdn.blinto.se/object/267984/");
  });
});

describe("Blinto objektsida (slagavgift + moms + galleri + brödtext)", () => {
  const d = parseDetail(fx("detail.html"), 267984);

  it("läser slagavgift, 25 % moms och bilder", () => {
    expect(d.feeValue).toBe(8400);
    expect(d.vatRate).toBe(25);
    expect(d.images.length).toBeGreaterThan(1);
    for (const u of d.images) expect(u).toContain("/object/267984/");
  });

  it("plockar HELA galleriet (96 bilder), normaliserat + utan dubbletter", () => {
    expect(d.images.length).toBeGreaterThan(50); // objektet har 96 bilder
    expect(new Set(d.images).size).toBe(d.images.length); // inga dubbletter
    for (const u of d.images) expect(u).toMatch(/\/object\/267984\/[^/]+\.(?:jpg|jpeg|webp)\/1200x900f$/);
  });

  it("extraherar brödtexten (specifikation + säljartext) utan juridik-boilerplate", () => {
    expect(d.description).toBeTruthy();
    expect(d.description).toContain("Fabrikat: Volvo");
    expect(d.description).toContain("Modell: L90F");
    expect(d.description).toContain("Lasthjälp utan lyft finns."); // säljartext
    expect(d.description).not.toContain("auktionsmäklare"); // boilerplate bortklippt
    expect(d.description).not.toContain("Har du också"); // boilerplate bortklippt
  });
});

describe("Blinto live-data (4MaxBid + getAuctionData)", () => {
  const RAW = "195048|52000|297776|2026-06-30 10:10:00|0|Tisdag 30/06 10:10|219060|Tisdag 30/06 10:10||0|54000";

  it("parseMaxBid plockar bud, exakt sluttid och nästa minbud", () => {
    const m = parseMaxBid(RAW)!;
    expect(m.aucId).toBe("195048");
    expect(m.currentBid).toBe(52000);
    expect(m.endsAtRaw).toBe("2026-06-30 10:10:00");
    expect(m.nextMinBid).toBe(54000);
  });

  it("parseMaxBid avvisar fel/HTML-svar", () => {
    expect(parseMaxBid("")).toBeNull();
    expect(parseMaxBid("<h4>Budhistorik</h4>")).toBeNull();
  });

  it("parseExactEnd: '2026-06-30 10:10:00' (CEST) → 08:10 UTC", () => {
    expect(parseExactEnd("2026-06-30 10:10:00")).toBe("2026-06-30T08:10:00.000Z");
  });

  it("parseAuctionData läser aktuellt bud (maxbid) + antal bud per auktion ur JSON", () => {
    const json = '{"195048":{"maxbid":"52 000 SEK","numbid":"10 bud"},"194829":{"maxbid":"2 022 000 SEK","numbid":"12 bud"}}';
    const data = parseAuctionData(json);
    expect(data.get("195048")).toEqual({ currentBid: 52000, bidCount: 10 });
    expect(data.get("194829")).toEqual({ currentBid: 2022000, bidCount: 12 }); // tusentalsmellanslag strippas
  });

  it("mapItem föredrar exakt live-sluttid framför SSR-textens relativa tid", () => {
    const v = parseList(fx("list.html")).find((i) => i.objId === "267984")!;
    v.endsAtRaw = "2026-06-30 10:10:00"; // live-overlay
    const it = mapItem(v, null, new Date("2026-06-27T12:00:00Z"));
    expect(it.endsAt).toBe("2026-06-30T08:10:00.000Z"); // ej SSR-textens 29 jun
  });
});

describe("Blinto sluttid (svensk lokaltid → UTC)", () => {
  it("'29 jun 09:59' (CEST) → 07:59 UTC, år härlett", () => {
    const now = new Date("2026-06-27T12:00:00Z");
    expect(parseSwedishEnd("29 jun 09:59", now)).toBe("2026-06-29T07:59:00.000Z");
  });
  it("månad som redan passerat → nästa år", () => {
    const now = new Date("2026-06-27T12:00:00Z");
    expect(parseSwedishEnd("3 feb 10:00", now)!.startsWith("2027-02-03")).toBe(true);
  });
});

describe("Blinto avgift = source-läge (slagavgift + 25 % på båda)", () => {
  it("bud 249 000 + slagavgift 8 400 → 321 750", () => {
    const b = computeTotal(
      { bid: 249000, sourceFeeValue: 8400, sourceVatRate: 25 },
      feeModelFor("blinto"),
    );
    expect(b.fee).toBe(8400);
    expect(b.vat).toBe(64350); // 25 % av 249 000 + 25 % av 8 400
    expect(b.total).toBe(321750);
  });
});

describe("Blinto normalisering", () => {
  it("mapItem speglar bud/avgift/moms/säljare/bild", () => {
    const v = parseList(fx("list.html")).find((i) => i.objId === "267984")!;
    const d = parseDetail(fx("detail.html"), 267984);
    const now = new Date("2026-06-27T12:00:00Z");
    const it = mapItem(v, d, now);
    expect(it.house).toBe("blinto");
    expect(it.externalId).toBe("267984");
    expect(it.currentBid).toBe(249000);
    expect(it.feeValue).toBe(8400);
    expect(it.vatRate).toBe(25);
    expect(it.seller).toBe("Blinto");
    expect(it.media.length).toBeGreaterThan(50); // hela galleriet, inte bara omslaget
    expect(it.description).toContain("Modell: L90F"); // brödtext speglad
    expect(it.endsAt).toBe("2026-06-29T07:59:00.000Z");
  });
});
