/**
 * #1146 (レビュー指摘): 写真で献立を上書きしたとき、糖質 (sugar_g) を炭水化物・食物繊維と一緒に更新する
 *
 * 経路: Web の献立表 → 手動変更 → 写真から入力 (mealId 付き) → /api/ai/analyze-meal-photo
 *       → Edge Function analyze-meal-photo → planned_meals.update(...)
 *
 * 以前は update が sugar_g を書かなかった。AI 献立が保存した糖質 (例: 85.3g) が写真で上書きしたあとも残り、
 * 「炭水化物 40g / 食物繊維 3g / 糖質 85.3g」のように、糖質が炭水化物より大きく表示された
 * (Web の献立カードとモバイルの食事詳細、栄養分析 API の合算にも古い値が入る)。
 * 写真解析パイプラインは糖質を計算していたが、戻り値の nutrition に入れておらず、保存されなかった。
 *
 * 次の 3 つを確かめる。
 *   1. 写真解析パイプライン (analyzeWithEvidence) が、炭水化物・食物繊維と整合した糖質 (nutrition.sugarG) を返す
 *   2. update に渡す栄養の列 (buildPhotoOverwriteNutrition) が、糖質を炭水化物・食物繊維と一緒に書く
 *   3. analyze-meal-photo/index.ts の planned_meals.update が、その関数を通している
 *      (Edge Function の index.ts は Deno.serve を持つため、単体テストでは読み込まず、構文木で確かめる)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPhotoOverwriteNutrition } from "../supabase/functions/_shared/meal-photo-update.ts";
import type {
  EstimatedIngredient,
  IngredientMatchResult,
  MatchedIngredientData,
} from "../supabase/functions/_shared/ingredient-matcher.ts";

const { matchIngredientsMock } = vi.hoisted(() => ({
  matchIngredientsMock: vi.fn(),
}));

// nutrition-pipeline.ts は読み込み時に Deno.env を読む。
// 外部サービスに繋がる依存 (材料マッチング・Gemini・Perplexity) だけを差し替え、
// 栄養の積算・参照レシピとの照合・乖離の補正 (evidence-verifier) は本物を使う。
vi.stubGlobal("Deno", { env: { get: () => undefined } });
vi.mock("../supabase/functions/_shared/ingredient-matcher.ts", () => ({
  matchIngredients: matchIngredientsMock,
  calculateMatchingStats: (results: Array<{ matched: unknown; confidence: string }>) => {
    const total = results.length;
    const matched = results.filter((r) => r.matched !== null).length;
    return {
      total,
      matched,
      highConfidence: results.filter((r) => r.confidence === "high").length,
      mediumConfidence: results.filter((r) => r.confidence === "medium").length,
      lowConfidence: results.filter((r) => r.confidence === "low").length,
      noMatch: results.filter((r) => r.confidence === "none").length,
      matchRate: total > 0 ? matched / total : 0,
    };
  },
}));
vi.mock("../supabase/functions/_shared/gemini-json.ts", () => ({
  generateGeminiJson: vi.fn(),
}));
vi.mock("../supabase/functions/_shared/perplexity-nutrition.ts", () => ({
  estimateNutritionWithPerplexity: vi.fn(async () => null),
  isPerplexityNutritionCandidate: vi.fn(() => false),
}));

afterAll(() => {
  vi.unstubAllGlobals();
});

const { analyzeWithEvidence } = await import("../supabase/functions/_shared/nutrition-pipeline.ts");

// ─────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────

/** 食材 DB (100g あたり)。炭水化物 − 食物繊維 は 材料ごとに 0 で下限をとる */
const INGREDIENT_DB: Record<string, Partial<MatchedIngredientData>> = {
  // 炭水化物 50 / 食物繊維 5 -> 糖質 45
  スパゲッティ: { calories_kcal: 300, protein_g: 10, fat_g: 2, carbs_g: 50, fiber_g: 5 },
  // 炭水化物 50 / 食物繊維 5 -> 糖質 45
  ご飯: { calories_kcal: 150, protein_g: 2.5, fat_g: 0.3, carbs_g: 50, fiber_g: 5 },
  // 食物繊維が炭水化物より多い食材 -> 糖質は 0 (負にしない)
  ひじき: { calories_kcal: 20, protein_g: 1, fat_g: 0.1, carbs_g: 10, fiber_g: 30 },
};

function matchedData(name: string): MatchedIngredientData {
  return {
    id: `ingredient-${name}`,
    name,
    name_norm: name,
    calories_kcal: null,
    protein_g: null,
    fat_g: null,
    carbs_g: null,
    fiber_g: null,
    sodium_mg: null,
    potassium_mg: null,
    calcium_mg: null,
    magnesium_mg: null,
    phosphorus_mg: null,
    iron_mg: null,
    zinc_mg: null,
    iodine_ug: null,
    cholesterol_mg: null,
    vitamin_a_ug: null,
    vitamin_d_ug: null,
    vitamin_e_alpha_mg: null,
    vitamin_k_ug: null,
    vitamin_b1_mg: null,
    vitamin_b2_mg: null,
    niacin_mg: null,
    vitamin_b6_mg: null,
    vitamin_b12_ug: null,
    folic_acid_ug: null,
    pantothenic_acid_mg: null,
    biotin_ug: null,
    vitamin_c_mg: null,
    salt_eq_g: null,
    discard_rate_percent: null,
    similarity: 1,
    ...INGREDIENT_DB[name],
  };
}

beforeEach(() => {
  matchIngredientsMock.mockReset();
  matchIngredientsMock.mockImplementation(async (_supabase: unknown, ingredients: EstimatedIngredient[]) =>
    ingredients.map((input): IngredientMatchResult => ({
      input,
      matched: INGREDIENT_DB[input.name] ? matchedData(input.name) : null,
      confidence: INGREDIENT_DB[input.name] ? "high" : "none",
      matchMethod: INGREDIENT_DB[input.name] ? "exact_map" : "none",
    })),
  );
});

/** 参照レシピ検索 (search_recipes_with_nutrition) だけを差し替えた Supabase。参照レシピの kcal で乖離の判定が決まる */
function fakeSupabase(referenceCalories: number | null) {
  const rows =
    referenceCalories === null
      ? []
      : [
          {
            id: "reference-1",
            name: "参照レシピ",
            name_norm: "参照レシピ",
            source_url: null,
            ingredients_text: null,
            calories_kcal: referenceCalories,
            protein_g: null,
            fat_g: null,
            carbs_g: null,
            sodium_g: null,
            similarity: 0.9,
          },
        ];
  return { rpc: vi.fn(async () => ({ data: rows, error: null })) } as never;
}

type PrefetchedDish = {
  name: string;
  role: string;
  cookingMethod: string;
  visiblePortionWeightG: number;
  visibleIngredients: EstimatedIngredient[];
  estimatedNutrition?: Record<string, unknown>;
};

async function analyze(dishes: PrefetchedDish[], referenceCalories: number | null) {
  return analyzeWithEvidence(
    [{ base64: "dGVzdA==", mimeType: "image/jpeg" }],
    "dinner",
    fakeSupabase(referenceCalories),
    { dishes } as never,
  );
}

const PASTA: PrefetchedDish = {
  name: "パスタ",
  role: "main",
  cookingMethod: "boiled",
  visiblePortionWeightG: 200,
  visibleIngredients: [{ name: "スパゲッティ", amount_g: 100 }],
};

const HIJIKI_RICE: PrefetchedDish = {
  name: "ひじきご飯",
  role: "main",
  cookingMethod: "boiled",
  visiblePortionWeightG: 200,
  visibleIngredients: [
    { name: "ご飯", amount_g: 100 },
    { name: "ひじき", amount_g: 100 },
  ],
};

// ─────────────────────────────────────────────
// 1. 写真解析パイプライン
// ─────────────────────────────────────────────

describe("analyzeWithEvidence: 糖質 (nutrition.sugarG) を返す (#1146)", () => {
  it("炭水化物 50 / 食物繊維 5 -> 糖質 45 を、炭水化物・食物繊維と一緒に返す", async () => {
    const result = await analyze([PASTA], 300);

    expect(result.totalCarbs).toBe(50);
    expect(result.nutrition.fiberG).toBe(5);
    expect(result.nutrition.sugarG).toBe(45);
  });

  it("材料ごとに 0 で下限をとった糖質をそのまま返す (合計の 炭水化物 60 − 食物繊維 35 = 25 で求め直さない)", async () => {
    const result = await analyze([HIJIKI_RICE], 170);

    expect(result.totalCarbs).toBe(60);
    expect(result.nutrition.fiberG).toBe(35);
    expect(result.nutrition.sugarG).toBe(45);
  });

  it("複数の料理は糖質を合計する", async () => {
    const result = await analyze([PASTA, HIJIKI_RICE], 470);

    expect(result.totalCarbs).toBe(110);
    expect(result.nutrition.fiberG).toBe(40);
    expect(result.nutrition.sugarG).toBe(90);
  });

  it("参照レシピとの乖離が大きく栄養を補正したときは、糖質も炭水化物・食物繊維と同じ比率で補正される", async () => {
    // 計算値 300kcal に対し参照が 100kcal (乖離 200%) -> 参照の ±50% (150kcal) へ寄せる = 全体を 0.5 倍
    const result = await analyze([PASTA], 100);

    expect(result.evidence.verification.reason).toBe("excessive_deviation");
    expect(result.totalCalories).toBe(150);
    expect(result.totalCarbs).toBe(25);
    expect(result.nutrition.fiberG).toBe(2.5);
    expect(result.nutrition.sugarG).toBe(22.5);
    expect(result.nutrition.sugarG).toBe(result.totalCarbs - result.nutrition.fiberG);
  });

  it("Gemini の推定値で炭水化物・食物繊維を上書きした料理は、糖質もその推定値から求める (材料からの 45 が残らない)", async () => {
    const result = await analyze(
      [
        {
          ...PASTA,
          cookingMethod: "other",
          visiblePortionWeightG: 300,
          estimatedNutrition: {
            calories_kcal: 520,
            protein_g: 20,
            fat_g: 15,
            carbs_g: 60,
            fiber_g: 5,
            salt_eq_g: 2,
            confidence: "high",
          },
        },
      ],
      520,
    );

    expect(result.totalCarbs).toBe(60);
    expect(result.nutrition.fiberG).toBe(5);
    expect(result.nutrition.sugarG).toBe(55);
  });
});

// ─────────────────────────────────────────────
// 2. update に渡す栄養の列
// ─────────────────────────────────────────────

/** 上書き前の AI 献立の行。糖質 85.3g が保存されている (#1146 以降の save-meal の保存値) */
function staleAiMealRow() {
  return {
    dish_name: "親子丼",
    calories_kcal: 650,
    protein_g: 28,
    fat_g: 18,
    carbs_g: 98,
    fiber_g: 12.7,
    sugar_g: 85.3,
    sodium_g: 2.1,
  };
}

describe("buildPhotoOverwriteNutrition: 糖質を炭水化物・食物繊維と一緒に上書きする (#1146)", () => {
  it("パイプラインの結果から、炭水化物・食物繊維・糖質を同じ解析結果で書く", async () => {
    const result = await analyze([PASTA], 300);

    const columns = buildPhotoOverwriteNutrition(result);

    expect(columns.carbs_g).toBe(50);
    expect(columns.fiber_g).toBe(5);
    expect(columns.sugar_g).toBe(45);
  });

  it("写真で上書きしたあと、上書き前の糖質 (85.3g) が残らず、糖質が炭水化物を超えない", async () => {
    const result = await analyze([PASTA], 300);
    const row = staleAiMealRow();

    // planned_meals.update(payload) 後の行 = 古い行に payload を重ねたもの
    const after = { ...row, ...buildPhotoOverwriteNutrition(result) };

    expect(after.carbs_g).toBe(50);
    expect(after.fiber_g).toBe(5);
    expect(after.sugar_g).toBe(45); // 85.3 のままにならない
    expect(after.sugar_g).toBeLessThanOrEqual(after.carbs_g);
  });

  it("糖質が解析結果に無いときは、undefined (列を送らない = 古い値が残る) ではなく null を明示して古い値を消す", () => {
    const withoutSugar = {
      totalCalories: 500,
      totalProtein: 20,
      totalFat: 10,
      totalCarbs: 40,
      nutrition: { fiberG: 3 },
    };

    const columns = buildPhotoOverwriteNutrition(withoutSugar as never);

    expect(Object.prototype.hasOwnProperty.call(columns, "sugar_g")).toBe(true);
    expect(columns.sugar_g).toBeNull();
    expect({ ...staleAiMealRow(), ...columns }.sugar_g).toBeNull();
  });

  it("糖質 0g (炭水化物の無い料理) は null にせず 0 で書く", () => {
    const meatOnly = {
      totalCalories: 300,
      totalProtein: 35,
      totalFat: 18,
      totalCarbs: 0,
      nutrition: { fiberG: 0, sugarG: 0 },
    };

    expect(buildPhotoOverwriteNutrition(meatOnly as never).sugar_g).toBe(0);
  });

  it("書く列の一覧: これまでの栄養の列に、sugar_g を足しただけ (列の書き忘れ・消し忘れを防ぐ)", () => {
    const nutrition = Object.fromEntries(
      [
        "sodiumG", "fiberG", "sugarG", "potassiumMg", "calciumMg", "phosphorusMg", "ironMg", "zincMg", "iodineUg",
        "cholesterolMg", "vitaminAUg", "vitaminDUg", "vitaminEMg", "vitaminKUg", "vitaminB1Mg", "vitaminB2Mg",
        "vitaminB6Mg", "vitaminB12Ug", "folicAcidUg", "vitaminCMg", "magnesiumMg",
      ].map((key, index) => [key, index + 1]),
    );

    const columns = buildPhotoOverwriteNutrition({
      totalCalories: 1,
      totalProtein: 2,
      totalFat: 3,
      totalCarbs: 4,
      nutrition,
    } as never);

    expect(Object.keys(columns).sort()).toEqual(
      [
        // 基本栄養素
        "calories_kcal", "protein_g", "fat_g", "carbs_g",
        // 拡張栄養素 (これまで)
        "sodium_g", "fiber_g", "potassium_mg", "calcium_mg", "phosphorus_mg", "iron_mg", "zinc_mg", "iodine_ug",
        "cholesterol_mg", "vitamin_a_ug", "vitamin_d_ug", "vitamin_e_mg", "vitamin_k_ug", "vitamin_b1_mg",
        "vitamin_b2_mg", "vitamin_b6_mg", "vitamin_b12_ug", "folic_acid_ug", "vitamin_c_mg", "magnesium_mg",
        // 今回足した列
        "sugar_g",
      ].sort(),
    );
    // 値の取り違えが無い (入力の連番が、対応する列にそのまま入る)
    expect(columns).toMatchObject({
      calories_kcal: 1,
      protein_g: 2,
      fat_g: 3,
      carbs_g: 4,
      sodium_g: 1,
      fiber_g: 2,
      sugar_g: 3,
      potassium_mg: 4,
      magnesium_mg: 21,
    });
  });
});

// ─────────────────────────────────────────────
// 3. analyze-meal-photo/index.ts の配線
// ─────────────────────────────────────────────

const INDEX_PATH = path.resolve(__dirname, "../supabase/functions/analyze-meal-photo/index.ts");

function parseIndex(): ts.SourceFile {
  const source = fs.readFileSync(INDEX_PATH, "utf8");
  return ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** `<何か>.from('<table>').update({ ... })` の update に渡しているオブジェクトリテラルを集める */
function findUpdatePayloads(sf: ts.SourceFile, table: string): ts.ObjectLiteralExpression[] {
  const found: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "update"
    ) {
      const receiver = node.expression.expression;
      const isFromTable =
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === "from" &&
        receiver.arguments.length > 0 &&
        ts.isStringLiteralLike(receiver.arguments[0]) &&
        receiver.arguments[0].text === table;
      const payload = node.arguments[0];
      if (isFromTable && payload && ts.isObjectLiteralExpression(payload)) found.push(payload);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("analyze-meal-photo/index.ts: planned_meals の update は buildPhotoOverwriteNutrition を通す (#1146)", () => {
  it("meal-photo-update.ts から buildPhotoOverwriteNutrition を import している", () => {
    const sf = parseIndex();
    const imports = sf.statements.filter(ts.isImportDeclaration).map((decl) => ({
      from: (decl.moduleSpecifier as ts.StringLiteral).text,
      names:
        decl.importClause?.namedBindings && ts.isNamedImports(decl.importClause.namedBindings)
          ? decl.importClause.namedBindings.elements.map((el) => el.name.text)
          : [],
    }));

    expect(imports).toContainEqual({
      from: "../_shared/meal-photo-update.ts",
      names: ["buildPhotoOverwriteNutrition"],
    });
  });

  it("写真で上書きする planned_meals の update は 1 か所で、栄養の列を buildPhotoOverwriteNutrition(result) から受け取る", () => {
    const payloads = findUpdatePayloads(parseIndex(), "planned_meals");
    expect(payloads).toHaveLength(1);

    const spreads = payloads[0].properties
      .filter(ts.isSpreadAssignment)
      .map((spread) => spread.expression.getText());
    expect(spreads).toContain("buildPhotoOverwriteNutrition(result)");
  });

  it("栄養の列を index.ts で個別に書き直していない (炭水化物だけ書いて糖質を書き忘れる、を防ぐ)", () => {
    const payloads = findUpdatePayloads(parseIndex(), "planned_meals");
    expect(payloads).toHaveLength(1);

    const handWritten = payloads[0].properties
      .filter(ts.isPropertyAssignment)
      .map((prop) => prop.name.getText());

    for (const column of ["calories_kcal", "protein_g", "fat_g", "carbs_g", "fiber_g", "sugar_g"]) {
      expect(handWritten).not.toContain(column);
    }
    // 栄養以外の列は、これまでどおり index.ts で書く
    expect(handWritten).toEqual(
      expect.arrayContaining(["dish_name", "dishes", "image_url", "description", "veg_score", "mode", "updated_at"]),
    );
  });
});
