import { describe, it, expect } from "vitest";
import { detectConflict, topLevel } from "../src/categories/conflict.ts";

describe("topLevel", () => {
  it("extracts the part before the slash", () => {
    expect(topLevel("smycken/klockor")).toBe("smycken");
  });
  it("returns the whole key when there is no slash", () => {
    expect(topLevel("ovrigt")).toBe("ovrigt");
  });
  it("returns null for null/undefined", () => {
    expect(topLevel(null)).toBeNull();
    expect(topLevel(undefined)).toBeNull();
  });
});

describe("detectConflict", () => {
  it("flags a text/house mismatch at the top level (the Rolex-catalog case)", () => {
    expect(detectConflict("smycken/klockor", "text", "bocker/tidningar")).toBe(true);
  });
  it("does not flag when top-level categories agree", () => {
    expect(detectConflict("smycken/klockor", "text", "smycken/smycken-sub")).toBe(false);
  });
  it("does not flag when there is no house category", () => {
    expect(detectConflict("smycken/klockor", "text", null)).toBe(false);
  });
  it("does not flag a mixed-lot classification", () => {
    expect(detectConflict("ovrigt/partier", "mixed", "bocker/tidningar")).toBe(false);
  });
  it("does not flag house- or learned/llm-sourced classifications (only 'text' can conflict)", () => {
    expect(detectConflict("fordon/personbilar", "house", "elektronik/datorer")).toBe(false);
  });
});
