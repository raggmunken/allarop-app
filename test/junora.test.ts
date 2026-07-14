import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseList,
  parseDetail,
  bodyHtmlToText,
  toIsoUtc,
} from "../src/connectors/junora/client.ts";
import { mapItem } from "../src/connectors/junora/map.ts";
import { slagavgiftForReserve } from "../src/connectors/junora/fee.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "junora", n), "utf8");
const NOW = new Date("2026-06-29T00:00:00Z");

describe("Junora listparser (auctioneer-api)", () => {
  const { items, total } = parseList(fx("list.json"));

  it("läser objekt med id/slug/namn/plats/bud/sluttid/status + total", () => {
    expect(items.length).toBe(50);
    expect(total).toBeGreaterThan(300);
    const v = items[0]!;
    expect(v.remoteId).toMatch(/^\d+$/);
    expect(v.slug).toBeTruthy();
    expect(v.name).toBeTruthy();
    expect(v.city).toBeTruthy();
    expect(v.endTimeUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(v.status).toBe(2); // aktiv
  });
});

describe("Junora sluttid (UTC utan Z → ISO)", () => {
  it("lägger på Z", () => {
    expect(toIsoUtc("2026-07-02T09:50:00")).toBe("2026-07-02T09:50:00Z");
    expect(toIsoUtc(null)).toBeNull();
  });
});

describe("Junora detalj (Shopify product.json + auktionsdetalj)", () => {
  const d = parseDetail(fx("product.json"), fx("auction.json"));

  it("galleri ur Shopify images", () => {
    expect(d.images.length).toBeGreaterThan(1);
    for (const u of d.images) expect(u).toMatch(/^https?:\/\//);
  });

  it("rik beskrivning ur body_html (spec-tabell → text, ej CSS)", () => {
    expect(d.description).toBeTruthy();
    expect(d.description).not.toContain("border-collapse"); // CSS bortstrippad
  });

  it("startbud ur auktionsdetaljens startingPrice", () => {
    expect(typeof d.startBid === "number" || d.startBid === null).toBe(true);
  });
});

describe("Junora body_html → text", () => {
  it("spec-tabell blir 'nyckel: värde'-rader, CSS bort", () => {
    const html = `<style>table.keyval{width:100%}</style><table class="keyval">
      <tr><td>Märke</td><td>Wolagri</td></tr><tr><td>Modell</td><td>FW 500-4K</td></tr></table>`;
    const t = bodyHtmlToText(html)!;
    expect(t).toContain("Märke: Wolagri");
    expect(t).toContain("Modell: FW 500-4K");
    expect(t).not.toContain("width");
  });
});

describe("Junora normalisering (ungefärlig slagavgift)", () => {
  const { items } = parseList(fx("list.json"));
  const v = items[0]!;
  const d = parseDetail(fx("product.json"), fx("auction.json"));

  it("mapItem: slagavgift ur reservpris → estimate-total med moms ur säljartyp", () => {
    const it = mapItem(v, d, NOW);
    expect(it.house).toBe("junora");
    expect(it.seller).toBe("Junora");
    // reservpris 25000 → slagavgift 2785 (exakt tabellpunkt)
    expect(it.feeValue).toBe(2785);
    expect(it.endsAt).toBe("2026-07-02T09:50:00Z");
    expect(it.bidCount).toBe(v.numBids);
    expect(it.media.length).toBeGreaterThan(1);
    // Säljartyp okänd (ingen sid-HTML i fixturen) men reservpris finns → bud-moms default 25.
    expect(it.vatRate).toBe(25);
    // Med känd slagavgift → basis "estimate" (UI visar "≈"): bud×1,25 + slagavgift.
    const total = computeTotal(
      { bid: 5000, sourceFeeValue: it.feeValue, sourceVatRate: it.vatRate },
      feeModelFor("junora"),
    );
    expect(total.basis).toBe("estimate");
    expect(total.total).toBe(5000 * 1.25 + 2785);
  });

  it("utan reservpris (ej berikat) → external (+ avgift)", () => {
    const noDetail = mapItem(v, null, NOW);
    expect(noDetail.feeValue).toBeNull();
    const total = computeTotal({ bid: 5000 }, feeModelFor("junora"));
    expect(total.basis).toBe("external");
    expect(total.total).toBe(5000);
  });

  it("slagavgift-tabell: tabellpunkt, golv, interpolation, extrapolering", () => {
    expect(slagavgiftForReserve(25000)).toBe(2785); // exakt punkt
    expect(slagavgiftForReserve(100)).toBe(130); // golv
    expect(slagavgiftForReserve(0)).toBe(130);
    expect(slagavgiftForReserve(null)).toBeNull();
    const mid = slagavgiftForReserve(2500)!; // mellan 2000(265) och 3000(525)
    expect(mid).toBeGreaterThan(265);
    expect(mid).toBeLessThan(525);
    expect(slagavgiftForReserve(3_000_000)!).toBeGreaterThan(37485); // inget tak
  });

  it("status 4 (avslutad) → ended", () => {
    const ended = mapItem({ ...v, status: 4 }, null, NOW);
    expect(ended.status).toBe("ended");
  });

  it("reservpris: status ur list-flaggor + VÄRDE ur detaljen", () => {
    expect(mapItem({ ...v, reserveMet: true, withoutReserve: false }, d, NOW).reserveStatus).toBe("met");
    expect(mapItem({ ...v, reserveMet: false, withoutReserve: false }, d, NOW).reserveStatus).toBe("not_met");
    expect(mapItem({ ...v, reserveMet: false, withoutReserve: true }, d, NOW).reserveStatus).toBe("none");
    // VÄRDET kommer ur auction.json (reservationPrice) - Junora läcker det.
    expect(mapItem(v, d, NOW).reservePrice).toBe(25000);
  });

  it("filtrerar bort orimligt reservpris (Junora-overflow)", () => {
    const big = parseDetail("{}", JSON.stringify({ startingPrice: 1000, reservationPrice: 5464654654125 }));
    expect(big.reservePrice).toBeNull();
    expect(big.startBid).toBe(1000);
  });
});
