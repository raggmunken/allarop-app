import { describe, it, expect } from "vitest";
import { traderaCategoryById, traderaCategoryToKey } from "../src/categories/tradera-map.ts";
import { houseCategoryKey } from "../src/categories/houseCategory.ts";

describe("traderaCategoryToKey (rot + löv)", () => {
  it("mappar otvetydiga rot-namn", () => {
    expect(traderaCategoryToKey("Fordon")).toBe("fordon/personbilar");
    expect(traderaCategoryToKey("Böcker & Tidningar")).toBeTruthy();
    expect(traderaCategoryToKey("Hemelektronik")).toBe("elektronik/ljud-bild-tv");
    expect(traderaCategoryToKey("Klockor")).toBe("smycken/klockor");
    expect(traderaCategoryToKey("Frimärken")).toBe("samla/frimarken");
    expect(traderaCategoryToKey("Fordonsdelar & tillbehör")).toBe("fordon/bildelar");
    expect(traderaCategoryToKey("Bygg & Verktyg")).toBe("verktyg/handverktyg");
    expect(traderaCategoryToKey("Skor")).toBe("klader/klader-skor");
    expect(traderaCategoryToKey("Barnleksaker")).toBe("samla/leksaker");
    expect(traderaCategoryToKey("Accessoarer")).toBe("klader/accessoarer");
  });

  it("lämnar tvetydiga rot-namn null (hellre text/LLM än fel)", () => {
    expect(traderaCategoryToKey("Övrigt")).toBeNull();
    expect(traderaCategoryToKey("Hobby")).toBeNull();
  });

  it("löv-namn mappas granulärt", () => {
    expect(traderaCategoryToKey("Oljemålningar")).toBe("konst/konst-tavlor");
    expect(traderaCategoryToKey("Vinyl")).toBe("media/vinyl");
  });
});

describe("traderaCategoryById (rot-id → nyckel)", () => {
  it("rot-id mappas via rot-namnet", () => {
    expect(traderaCategoryById(15)).toBe("samla/frimarken"); // Frimärken
    expect(traderaCategoryById(19)).toBe("smycken/klockor"); // Klockor
    expect(traderaCategoryById(30)).toBe("media/tvspel"); // TV-spel & Datorspel
    expect(traderaCategoryById(1001386)).toBe("fordon/bildelar"); // Fordonsdelar
  });
  it("okänt id → null", () => {
    expect(traderaCategoryById(999999)).toBeNull();
    expect(traderaCategoryById(null)).toBeNull();
  });
});

describe("houseCategoryKey (tradera-gren)", () => {
  it("categoryName (löv) vinner över categoryId", () => {
    const { key, raw } = houseCategoryKey("tradera", { categoryId: 10, categoryName: "Oljemålningar" });
    expect(key).toBe("konst/konst-tavlor");
    expect(raw).toBe("Oljemålningar");
  });
  it("categoryId (rot) används när namn saknas", () => {
    const { key } = houseCategoryKey("tradera", { categoryId: 22 });
    expect(key).toBe("samla/mynt"); // Mynt & Sedlar
  });
  it("tvetydig rot → key null (faller på text/LLM)", () => {
    const { key } = houseCategoryKey("tradera", { categoryId: 28 }); // Övrigt
    expect(key).toBeNull();
  });
});
