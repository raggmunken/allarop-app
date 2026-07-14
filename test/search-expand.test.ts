import { describe, it, expect } from "vitest";
import { buildExpandPrompt, normalizeQuery, parseExpansion, worthExpanding } from "../src/ai/search-expand.ts";

describe("Smart sök-expansion", () => {
  it("normalizeQuery + worthExpanding (skippa korta/pågående inmatningar)", () => {
    expect(normalizeQuery("  DiskHo  ")).toBe("diskho");
    expect(worthExpanding("diskho")).toBe(true);
    expect(worthExpanding("dykning")).toBe(true);
    expect(worthExpanding("dyk")).toBe(false); // för kort
    expect(worthExpanding("123456")).toBe(false); // inga bokstäver
    expect(worthExpanding("a".repeat(80))).toBe(false); // orimligt lång
  });

  it("buildExpandPrompt innehåller frågan + taxonomin + JSON-instruktion", () => {
    const p = buildExpandPrompt("dykning");
    expect(p).toContain('"dykning"');
    expect(p).toContain("media/tvspel");
    expect(p).toContain("synonyms");
  });

  it("parseExpansion: sanerar (dubbletter/skräp/okända kategorier bort, själva frågan bort)", () => {
    const text = `Här: {"synonyms":["ho","vask","HO","diskho","x"],"related":["blandare","diskmaskin"],"categories":["hem/husgerad-kok","påhittad/nyckel"]}`;
    const e = parseExpansion(text, "diskho")!;
    expect(e.synonyms).toEqual(["ho", "vask"]); // dubblett-"ho", själva frågan och 1-teckens "x" bort
    expect(e.related).toEqual(["blandare", "diskmaskin"]);
    expect(e.categories).toEqual(["hem/husgerad-kok"]); // okänd nyckel kastad
  });

  it("parseExpansion: obrukbart svar → null", () => {
    expect(parseExpansion("kan inte svara", "diskho")).toBeNull();
    expect(parseExpansion("[1,2,3]", "diskho")).toBeNull();
  });
});
