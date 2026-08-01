import { describe, it, expect } from "vitest";
import { categorizationDecisionPatch } from "../src/db/repo.ts";

describe("categorizationDecisionPatch", () => {
  it("approve locks in the current category as 'human', clears the conflict flag", () => {
    expect(categorizationDecisionPatch("approve")).toEqual({
      category: null, category_conf: "human", category_conflict: false,
    });
  });
  it("reject clears the category and re-flags for priority reclassification", () => {
    expect(categorizationDecisionPatch("reject")).toEqual({
      category: null, category_conf: null, category_conflict: true,
    });
  });
});
