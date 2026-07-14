import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { getActionResult, parseFlight, resolveValue } from "../src/connectors/tovek/flight.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name));

describe("flight-parser mot verkliga Tovek-svar", () => {
  it("listar parts ur list-svaret", () => {
    const res = getActionResult(fixture("tovek_list.flight.txt")) as any;
    expect(Array.isArray(res.auctions)).toBe(true);
    expect(res.auctions.length).toBe(3);
    expect(res.totalHits).toBe(14);
    const first = res.auctions[0];
    expect(first.partId).toBe(7518);
    expect(first.partTitle).toBe("Fastighet Falkenberg Holmen 1:79");
    expect(first.partLocation).toBe("Källsjö, Ullared"); // verifierar UTF-8/byte-hantering
    expect(first.images.length).toBeGreaterThan(0);
    expect(first.images[0]).toContain("b-cdn.net");
  });

  it("löser upp text-referens ($2) i part-items-svaret", () => {
    const res = getActionResult(fixture("tovek_partitems.flight.txt")) as any;
    expect(Array.isArray(res.auctionItems)).toBe(true);
    const item = res.auctionItems[0];
    expect(item.itemId).toBe(757677);
    expect(item.itemMinBid).toBe(500000);
    expect(item.itemFeeValue).toBe(15000); // avgift följer med datan
    expect(item.itemVatValue).toBe(0);
    // itemDescription var "$2" → ska nu vara den upplösta textblobben.
    expect(typeof item.itemDescription).toBe("string");
    expect(item.itemDescription).toContain("Holmen 105");
    expect(item.itemDescription).toContain("kvm");
  });

  it("läser budhistorik och hittar högsta bud", () => {
    const res = getActionResult(fixture("tovek_itembids.flight.txt")) as any;
    expect(Array.isArray(res.bids)).toBe(true);
    expect(res.bids.length).toBeGreaterThan(0);
    const top = res.bids[0];
    expect(top.historyBidValue).toBe(720000);
    expect(top.totalHits).toBe(11);
  });

  it("läser part-facetter (totalItems)", () => {
    const res = getActionResult(fixture("tovek_partfacets.flight.txt")) as any;
    expect(res.totalItems).toBe(1);
    expect(Array.isArray(res.options)).toBe(true);
  });

  it("parseFlight exponerar råa rows och resolveValue följer referenser", () => {
    const chunks = parseFlight(fixture("tovek_partitems.flight.txt"));
    expect(chunks.has("0")).toBe(true);
    expect(chunks.has("1")).toBe(true);
    expect(chunks.has("2")).toBe(true); // textchunk
    expect(typeof chunks.get("2")).toBe("string");
    const resolved = resolveValue("$2", chunks) as string;
    expect(resolved).toContain("Totalareal");
  });
});
