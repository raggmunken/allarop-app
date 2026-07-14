import { describe, it, expect } from "vitest";
import { tokensOf, voteTokens } from "../src/categories/learned.ts";

const lex = (rows: [string, string, number][]): Map<string, Map<string, number>> => {
  const m = new Map<string, Map<string, number>>();
  for (const [t, c, n] of rows) {
    if (!m.has(t)) m.set(t, new Map());
    m.get(t)!.set(c, n);
  }
  return m;
};

describe("tokensOf (titel → betydelsebärande tokens)", () => {
  it("gemener, stoppord bort, dedupe, min 3 tecken", () => {
    expect(tokensOf("TIG-svets med tillbehör, 4 st")).toEqual(["tig", "svets", "tillbehör"]);
    expect(tokensOf("Stol och stol")).toEqual(["stol"]);
    expect(tokensOf("åäö ÅÄÖ")).toEqual(["åäö"]);
    expect(tokensOf("12 34 ab")).toEqual([]);
    // Mått-/storleksord bär noll kategorisignal (fanns i ring-titel → röstade kläder).
    expect(tokensOf("Ring SCH tvåfärgad ograverad stl19 bredd:4,9mm")).toEqual([
      "ring", "sch", "tvåfärgad", "ograverad",
    ]);
  });
});

describe("voteTokens (konservativ röstning)", () => {
  it("klassar när evidensen är stark och entydig", () => {
    const m = lex([
      ["tig", "verktyg/svets", 20],
      ["svets", "verktyg/svets", 30],
      ["tillbehör", "verktyg/svets", 5],
      ["tillbehör", "media/tvspel", 4],
    ]);
    const hit = voteTokens(tokensOf("TIG-svets tillbehör"), m)!;
    expect(hit.category).toBe("verktyg/svets");
    expect(hit.evidence).toBeGreaterThanOrEqual(12);
  });

  it("avstår vid för lite evidens eller splittrade röster", () => {
    // För lite: bara 3 observationer totalt.
    expect(voteTokens(["stol"], lex([["stol", "mobler/stolar", 3]]))).toBeNull();
    // Splittrat: "tillbehör" pekar åt två håll ungefär lika mycket → under 75 %-andel.
    const split = lex([
      ["tillbehör", "verktyg/svets", 15],
      ["tillbehör", "media/tvspel", 14],
    ]);
    expect(voteTokens(["tillbehör"], split)).toBeNull();
    // Okända tokens → null.
    expect(voteTokens(["okändord"], split)).toBeNull();
  });

  it("stark signal vinner över svag brus-signal", () => {
    const m = lex([
      ["nes", "media/tvspel", 40],
      ["tillbehör", "verktyg/svets", 8],
      ["tillbehör", "media/tvspel", 6],
    ]);
    const hit = voteTokens(tokensOf("NES tillbehör"), m)!;
    expect(hit.category).toBe("media/tvspel"); // 46 mot 8 → ~85 % andel
  });
});
