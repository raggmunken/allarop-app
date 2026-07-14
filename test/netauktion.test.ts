import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseList,
  parseDetail,
  parseStatusArray,
  parseBidBox,
  parseTotalPages,
} from "../src/connectors/netauktion/client.ts";
import { mapItem, mapBids, deriveVatRate, parseSwedishEnd } from "../src/connectors/netauktion/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "netauktion", n), "utf8");

describe("Netauktion listparser (object-card)", () => {
  const list = parseList(fx("list.html"));

  it("plockar kort med id/slug/titel/plats/sluttid/bild", () => {
    expect(list.length).toBeGreaterThan(10);
    expect(list.filter((i) => i.endText != null).length).toBe(list.length);
    const v = list[0]!;
    expect(v.productId).toMatch(/^\d+$/);
    expect(v.title).toContain("Gamingskärm");
    expect(v.location).toBe("GBG/Ringön");
    expect(v.image).toMatch(/netauktion\.se\/uploads\//);
  });

  it("totalt antal sidor ur pagineringen", () => {
    expect(parseTotalPages(fx("list.html"))).toBeGreaterThan(1);
  });
});

describe("Netauktion batch-status (update_auction_status)", () => {
  const status = parseStatusArray(fx("status.json"));

  it("läser bud + EXAKT total + ledare + nästa minbud per objekt", () => {
    const g = status.get("251391")!; // gamingskärm (momsfri)
    expect(g.currentBid).toBe(700);
    expect(g.total).toBe(825);
    expect(g.leaderName).toBe("Jens123");
    expect(g.nextBid).toBe(800);
    expect(g.active).toBe(true);
  });

  it("parsar HEL budhistorik med namn ur bid_box", () => {
    const m = status.get("251198")!;
    expect(m.bids.length).toBe(3);
    expect(m.bids[0]!.bidderName).toBe("Idaw");
    expect(m.bids[0]!.value).toBe(300);
    expect(m.bids.every((b) => b.bidderId != null)).toBe(true);
  });
});

describe("Netauktion objektsida (BARA beskrivning + eget galleri)", () => {
  const d = parseDetail(fx("detail.html"), 251198);

  it("beskrivning + objektets egna bilder (ej syskonlotters, ej kategoribilder)", () => {
    expect(d.description).toBeTruthy();
    expect(d.images.length).toBeGreaterThan(1);
    for (const u of d.images) expect(u).not.toContain("/uploads/categories");
  });
});

describe("Netauktion objektsmoms härledd ur exakt total → computeTotal blir exakt", () => {
  it("momsfri (gamingskärm): bud 700, total 825 → vatRate 0; computeTotal = 825", () => {
    expect(deriveVatRate(700, 825)).toBe(0);
    expect(computeTotal({ bid: 700, sourceVatRate: 0 }, feeModelFor("netauktion")).total).toBe(825);
  });
  it("momspliktig (mattor): bud 300, total 500 → vatRate 25; computeTotal = 500", () => {
    expect(deriveVatRate(300, 500)).toBe(25);
    expect(computeTotal({ bid: 300, sourceVatRate: 25 }, feeModelFor("netauktion")).total).toBe(500);
  });
});

describe("Netauktion sluttid (svensk lokaltid → UTC)", () => {
  it("'2026-06-28 19:35:00' (CEST) → 17:35 UTC", () => {
    expect(parseSwedishEnd("2026-06-28 19:35:00")).toBe("2026-06-28T17:35:00.000Z");
  });
});

describe("Netauktion normalisering (kort + status + detalj)", () => {
  const v = parseList(fx("list.html")).find((i) => i.productId === "251391")!;
  const st = parseStatusArray(fx("status.json")).get("251391")!;

  it("mapItem speglar bud/sluttid/härledd moms; mapBids ger budhistorik med namn", () => {
    const it = mapItem(v, st, null, new Date("2026-06-27T00:00:00Z"));
    expect(it.house).toBe("netauktion");
    expect(it.seller).toBe("Netauktion");
    expect(it.currentBid).toBe(700);
    expect(it.minBid).toBe(800);
    expect(it.vatRate).toBe(0); // momsfri, härlett ur exakt total
    const bids = mapBids(v, st);
    expect(bids.length).toBe(4);
    expect(bids[0]!.bidderName).toBe("Jens123");
    expect(bids[0]!.itemExternalId).toBe("251391");
  });
});

describe("Netauktion bid_box-parser", () => {
  it("hanterar tom/saknad bid_box", () => {
    expect(parseBidBox(null)).toEqual([]);
    expect(parseBidBox("")).toEqual([]);
  });
});
