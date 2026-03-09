import { describe, expect, it } from "vitest";

import {
  isValidMenuReferenceCandidate,
  mapMenuReferenceCandidates,
  rerankMenuReferenceCandidates,
} from "../supabase/functions/generate-menu-v4/reference-menu-utils";

describe("reference menu utils", () => {
  it("filters placeholder-title candidates", () => {
    expect(
      isValidMenuReferenceCandidate({
        title: "（無題）",
        dishes: [{ name: "鮭の塩焼き", role: "main" }],
      }),
    ).toBe(false);
  });

  it("filters candidates without dish names", () => {
    expect(
      isValidMenuReferenceCandidate({
        title: "減塩献立",
        dishes: [{ name: "", role: "main" }],
      }),
    ).toBe(false);
  });

  it("rerankMenuReferenceCandidates excludes invalid candidates", () => {
    const ranked = rerankMenuReferenceCandidates(
      "子ども向け献立",
      [
        { title: "（無題）", dishes: [{ name: "鮭の塩焼き", role: "main" }], similarity: 0.99 },
        { title: "子供もパクパク 鮭の甘辛ゴマ絡め", dishes: [{ name: "鮭の甘辛ゴマ絡め", role: "main" }], similarity: 0.5 },
      ],
      5,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.title).toContain("子供");
  });

  it("mapMenuReferenceCandidates drops empty dishes", () => {
    const mapped = mapMenuReferenceCandidates([
      {
        title: "減塩献立",
        dishes: [
          { name: "", role: "main" },
          { name: "塩鮭のみりん漬け", role: "main" },
        ],
      },
    ]);
    expect(mapped).toEqual([
      {
        title: "減塩献立",
        dishes: [{ name: "塩鮭のみりん漬け", role: "main" }],
      },
    ]);
  });
});
