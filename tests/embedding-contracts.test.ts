import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DATASET_EMBEDDING_API_KEY_ENV,
  DATASET_EMBEDDING_DIMENSIONS,
  DATASET_EMBEDDING_MODEL,
  buildDatasetEmbeddingRequestBody,
  buildMenuSetEmbeddingText,
  isDatasetEmbeddingConfig,
} from "../shared/dataset-embedding.mjs";
import {
  mapMenuReferenceCandidates,
  rerankMenuReferenceCandidates,
  shouldSkipReferenceMenuSearch,
} from "../supabase/functions/generate-menu-v4/reference-menu-utils";
import {
  mergeIngredientCandidates,
  shouldSelectIngredientWithoutLLM,
} from "../supabase/functions/_shared/ingredient-search-utils";

describe("dataset embedding contract", () => {
  it("pins the standard embedding config to voyage-multilingual-2 / 1024", () => {
    expect(DATASET_EMBEDDING_API_KEY_ENV).toBe("AIMLAPI_API_KEY");
    expect(DATASET_EMBEDDING_MODEL).toBe("voyage-multilingual-2");
    expect(DATASET_EMBEDDING_DIMENSIONS).toBe(1024);
    expect(isDatasetEmbeddingConfig("voyage-multilingual-2", 1024)).toBe(true);
    expect(isDatasetEmbeddingConfig("voyage-multilingual-2", 1536)).toBe(false);
    expect(isDatasetEmbeddingConfig("text-embedding-3-small", 1024)).toBe(false);
  });

  it("uses document input_type only when explicitly requested", () => {
    expect(buildDatasetEmbeddingRequestBody("たまねぎ")).toEqual({
      model: "voyage-multilingual-2",
      input: "たまねぎ",
      input_type: "document",
    });
    expect(buildDatasetEmbeddingRequestBody("たまねぎ", { inputType: "query" })).toEqual({
      model: "voyage-multilingual-2",
      input: "たまねぎ",
    });
  });

  it("builds rich menu-set embedding text from menu metadata", () => {
    const text = buildMenuSetEmbeddingText({
      title: "塩分控えめ献立",
      theme_tags: ["減塩", "高血圧"],
      dishes: [
        { name: "鶏の照り焼き", role: "main" },
        { name: "小松菜のおひたし", class_raw: "副菜" },
      ],
      calories_kcal: 560,
      protein_g: 28.4,
      fat_g: 18.2,
      carbs_g: 61.5,
      sodium_g: 2.1,
    });

    expect(text).toContain("タイトル: 塩分控えめ献立");
    expect(text).toContain("テーマ: 減塩 高血圧");
    expect(text).toContain("鶏の照り焼き(main)");
    expect(text).toContain("小松菜のおひたし(副菜)");
    expect(text).toContain("kcal=560");
    expect(text).toContain("salt=2.1");
  });
});

describe("reference-menu utils", () => {
  it("skips search only when the reference dataset is confirmed empty", () => {
    expect(shouldSkipReferenceMenuSearch(0)).toBe(true);
    expect(shouldSkipReferenceMenuSearch(10)).toBe(false);
    expect(shouldSkipReferenceMenuSearch(null)).toBe(false);
  });

  it("maps raw RPC rows to menu references", () => {
    expect(
      mapMenuReferenceCandidates([
        {
          title: "朝食例",
          dishes: [
            { name: "味噌汁", class_raw: "汁物" },
            { name: "焼き鮭", role: "main" },
          ],
        },
      ]),
    ).toEqual([
      {
        title: "朝食例",
        dishes: [
          { name: "味噌汁", role: "汁物" },
          { name: "焼き鮭", role: "main" },
        ],
      },
    ]);
  });

  it("reranks menu references by keyword overlap before vector similarity", () => {
    const ranked = rerankMenuReferenceCandidates(
      "減塩 和食",
      [
        { title: "ダイエット献立", theme_tags: ["低栄養予防"], dishes: [{ name: "サラダ", role: "side" }], similarity: 0.91 },
        { title: "減塩の和食献立", theme_tags: ["減塩", "和食"], dishes: [{ name: "焼き鮭", role: "main" }], similarity: 0.7 },
      ],
      2,
    );

    expect(ranked[0]).toMatchObject({ title: "減塩の和食献立" });
  });
});

describe("ingredient search utils", () => {
  it("prefers strong text matches over weak vector candidates", () => {
    const merged = mergeIngredientCandidates(
      "たまねぎ",
      [
        { id: "1", name: "たまねぎ", name_norm: "たまねぎ", similarity: 0.4 },
      ],
      [
        { id: "2", name: "コーンクリームコロッケ", name_norm: "こーんくりーむころっけ", similarity: 0.09 },
      ],
    );

    expect(merged[0]).toMatchObject({ id: "1", name: "たまねぎ" });
    expect(shouldSelectIngredientWithoutLLM("たまねぎ", merged[0])).toBe(true);
  });
});

describe("migration contract", () => {
  it("standardizes vector columns and RPCs to 1024", () => {
    const migrationPath = path.join(
      process.cwd(),
      "supabase/migrations/20260308120000_standardize_dataset_embeddings_to_1536.sql",
    );
    const migration = fs.readFileSync(migrationPath, "utf8");

    expect(migration).toContain("ALTER COLUMN name_embedding TYPE vector(1024)");
    expect(migration).toContain("ALTER COLUMN content_embedding TYPE vector(1024)");
    expect(migration).toContain("search_dataset_ingredients_by_embedding(\n  query_embedding vector(1024)");
    expect(migration).toContain("search_ingredients_full_by_embedding(\n  query_embedding vector(1024)");
    expect(migration).toContain("search_menu_examples(\n  query_embedding vector(1024)");
    expect(migration).toContain("search_recipes_hybrid(\n  query_text text,\n  query_embedding vector(1024) DEFAULT NULL");
    expect(migration).not.toContain("CREATE OR REPLACE FUNCTION search_dataset_ingredients_by_embedding(\n  query_embedding vector(384)");
    expect(migration).not.toContain("CREATE OR REPLACE FUNCTION search_ingredients_full_by_embedding(\n  query_embedding vector(384)");
    expect(migration).not.toContain("CREATE OR REPLACE FUNCTION search_menu_examples(\n  query_embedding vector(384)");
    expect(migration).not.toContain("CREATE OR REPLACE FUNCTION search_recipes_hybrid(\n  query_text text,\n  query_embedding vector(384)");
  });
});

describe("rpc caller contract", () => {
  it("uses the new search_menu_examples argument names everywhere", () => {
    const callers = [
      path.join(process.cwd(), "supabase/functions/generate-menu-v4/index.ts"),
      path.join(process.cwd(), "scripts/check-search-smoke.mjs"),
      path.join(process.cwd(), "scripts/check-search-quality.mjs"),
      path.join(process.cwd(), "scripts/test-vector-search.mjs"),
    ];

    for (const callerPath of callers) {
      const source = fs.readFileSync(callerPath, "utf8");
      expect(source).toContain('filter_meal_type_hint');
      expect(source).toContain('filter_max_sodium');
      expect(source).toContain('filter_theme_tags');
      expect(source).not.toContain('required_tags');
      expect(source).not.toContain('min_similarity');
    }
  });

  it("keeps hybrid recipe callers on query_text + query_embedding", () => {
    const callers = [
      path.join(process.cwd(), "supabase/functions/knowledge-gpt/index.ts"),
      path.join(process.cwd(), "scripts/check-search-smoke.mjs"),
      path.join(process.cwd(), "scripts/check-search-quality.mjs"),
    ];

    for (const callerPath of callers) {
      const source = fs.readFileSync(callerPath, "utf8");
      expect(source).toContain('query_text');
      expect(source).toContain('query_embedding');
      expect(source).toContain('similarity_threshold');
    }
  });
});
