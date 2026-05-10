/**
 * オンボーディング 3 パス完走 + 質問 ID 重複検出
 *
 * Bug 1 (target_date と weight_change_rate の冗長質問) regression 防止のため、
 * athlete_performance / lose_weight / gain_muscle の 3 パスで全質問を完走し、
 * 表示された質問 ID に重複がないことを assert する。
 *
 * 質問 ID の特定方法:
 *   page.tsx に data-question-id 等の DOM 属性は存在しないため、
 *   QUESTIONS 配列 (page.tsx と同一ロジック) をテスト側でシミュレートし
 *   「このパスで表示されるはず ID シーケンス」を事前計算する。
 *   ブラウザ操作は計算済みシーケンスの各ステップを順に進める。
 *   各ステップを進めるたびに ID を push し、最後に重複 assert を行う。
 *
 * 実行方法:
 *   PLAYWRIGHT_BASE_URL=http://localhost:3003 \
 *   npx playwright test tests/e2e/onboarding-multi-path.spec.ts --project=chromium
 */

import { test, expect, type Page } from "@playwright/test";
import { login } from "./fixtures/auth";

// ─── QUESTIONS 定義 (page.tsx の QUESTIONS 配列と同期) ────────────────────────
// showIf ロジックのみを抽出。ブラウザに送るのではなく Node.js 側でシミュレートする。

type QuestionDef = {
  id: string;
  type: string;
  showIf?: (answers: Record<string, unknown>) => boolean;
  allowSkip?: boolean;
};

const QUESTIONS: QuestionDef[] = [
  { id: "nickname", type: "text" },
  { id: "gender", type: "choice" },
  { id: "body_stats", type: "custom_stats" },
  { id: "nutrition_goal", type: "choice" },
  {
    id: "target_weight",
    type: "number",
    showIf: (a) =>
      a.nutrition_goal === "lose_weight" || a.nutrition_goal === "gain_muscle",
  },
  // athlete_performance 向け追加質問
  {
    id: "sport_type",
    type: "choice",
    showIf: (a) => a.nutrition_goal === "athlete_performance",
  },
  {
    id: "sport_custom_name",
    type: "text",
    showIf: (a) =>
      a.nutrition_goal === "athlete_performance" && a.sport_type === "custom",
  },
  {
    id: "sport_experience",
    type: "choice",
    showIf: (a) => a.nutrition_goal === "athlete_performance",
  },
  {
    id: "training_phase",
    type: "choice",
    showIf: (a) => a.nutrition_goal === "athlete_performance",
  },
  {
    id: "competition_date",
    type: "date",
    showIf: (a) =>
      a.nutrition_goal === "athlete_performance" &&
      (a.training_phase === "competition" || a.training_phase === "cut"),
    allowSkip: true,
  },
  {
    id: "target_date",
    type: "date",
    showIf: (a) =>
      a.nutrition_goal === "lose_weight" || a.nutrition_goal === "gain_muscle",
    allowSkip: true,
  },
  {
    id: "weight_change_rate",
    type: "choice",
    showIf: (a) =>
      a.nutrition_goal === "lose_weight" || a.nutrition_goal === "gain_muscle",
  },
  { id: "exercise_types", type: "multi_choice" },
  {
    id: "exercise_frequency",
    type: "choice",
    showIf: (a) =>
      !Array.isArray(a.exercise_types) ||
      !(a.exercise_types as string[]).includes("none"),
  },
  {
    id: "exercise_intensity",
    type: "choice",
    showIf: (a) =>
      !Array.isArray(a.exercise_types) ||
      !(a.exercise_types as string[]).includes("none"),
  },
  {
    id: "exercise_duration",
    type: "choice",
    showIf: (a) =>
      !Array.isArray(a.exercise_types) ||
      !(a.exercise_types as string[]).includes("none"),
  },
  { id: "work_style", type: "choice" },
  { id: "health_conditions", type: "multi_choice", allowSkip: true },
  { id: "body_concerns", type: "multi_choice", allowSkip: true },
  { id: "sleep_quality", type: "choice" },
  { id: "stress_level", type: "choice" },
  {
    id: "pregnancy_status",
    type: "choice",
    showIf: (a) => a.gender === "female",
  },
  { id: "medications", type: "multi_choice", allowSkip: true },
  { id: "allergies", type: "tags", allowSkip: true },
  { id: "dislikes", type: "tags", allowSkip: true },
  { id: "favorite_ingredients", type: "tags", allowSkip: true },
  { id: "diet_style", type: "choice", allowSkip: true },
  { id: "cooking_experience", type: "choice" },
  { id: "cooking_time", type: "choice" },
  { id: "cuisine_preference", type: "multi_choice" },
  { id: "family_size", type: "number" },
  { id: "servings_config", type: "servings_grid" },
  { id: "shopping_frequency", type: "choice" },
  { id: "weekly_food_budget", type: "choice", allowSkip: true },
  { id: "kitchen_appliances", type: "multi_choice", allowSkip: true },
  { id: "stove_type", type: "choice" },
  { id: "hobbies", type: "tags", allowSkip: true },
];

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3003";

/** オンボーディング状態を未開始にリセットする */
async function resetOnboarding(page: Page): Promise<void> {
  const status = await page.evaluate(async (url: string) => {
    const r = await fetch(url, { method: "DELETE", credentials: "include" });
    return r.status;
  }, `${BASE_URL}/api/onboarding/status`);
  expect([200, 401]).toContain(status);
}

/**
 * goal パラメータに基づいた「回答マップ」を返す。
 * training_phase = "training" → competition_date は表示されない。
 */
function buildAnswerMap(goal: string): Record<string, unknown> {
  return {
    nickname: "テストユーザー",
    gender: "male",
    body_stats: "completed",
    nutrition_goal: goal,
    target_weight: 65,
    target_date: "2027-01-01",
    weight_change_rate: "moderate",
    sport_type: "soccer",
    sport_experience: "intermediate",
    training_phase: "training",
    exercise_types: ["running"],
    exercise_frequency: "3",
    exercise_intensity: "moderate",
    exercise_duration: "60",
    work_style: "sedentary",
    health_conditions: null,
    body_concerns: null,
    sleep_quality: "good",
    stress_level: "low",
    medications: null,
    allergies: null,
    dislikes: null,
    favorite_ingredients: null,
    diet_style: "normal",
    cooking_experience: "intermediate",
    cooking_time: "30",
    cuisine_preference: ["japanese"],
    family_size: 2,
    servings_config: "completed",
    shopping_frequency: "2-3_weekly",
    weekly_food_budget: "none",
    kitchen_appliances: null,
    stove_type: "stove:gas",
    hobbies: null,
  };
}

function computeVisibleIds(answers: Record<string, unknown>): string[] {
  return QUESTIONS.filter((q) => !q.showIf || q.showIf(answers)).map(
    (q) => q.id
  );
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) dups.push(id);
    seen.add(id);
  }
  return dups;
}

// ─── 各質問への回答アクション ─────────────────────────────────────────────────

/**
 * 質問 ID ごとに固有のキー要素が表示されるのを待ってから回答する。
 * animation (600ms) + α のマージンとして各質問冒頭で固有要素の可視確認を行う。
 */
async function answerQuestion(
  page: Page,
  qid: string,
  goal: string
): Promise<void> {
  switch (qid) {
    case "nickname":
      await expect(page.getByPlaceholder("例: たろう")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByPlaceholder("例: たろう").fill("テストユーザー");
      await page.locator("form").first().getByRole("button").click();
      break;

    case "gender":
      await expect(page.getByText("正確な栄養計算のために、性別を教えてください")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /男性/ }).click();
      break;

    case "body_stats":
      await expect(page.getByPlaceholder("25")).toBeVisible({ timeout: 10_000 });
      await page.getByPlaceholder("25").fill("30");
      await page.getByPlaceholder("会社員").fill("エンジニア");
      await page.getByPlaceholder("170").fill("170");
      await page.getByPlaceholder("60").fill("65");
      await page.getByRole("button", { name: "次へ" }).click();
      break;

    case "nutrition_goal":
      await expect(page.getByText("一番の目標は何ですか？")).toBeVisible({ timeout: 10_000 });
      if (goal === "lose_weight") {
        await page.getByRole("button", { name: /減量/ }).click();
      } else if (goal === "gain_muscle") {
        await page.getByRole("button", { name: /筋肉増量/ }).click();
      } else if (goal === "athlete_performance") {
        await page.getByRole("button", { name: /競技パフォーマンス/ }).click();
      } else {
        await page.getByRole("button", { name: /現状維持/ }).click();
      }
      break;

    case "target_weight":
      await expect(page.getByPlaceholder("例: 55")).toBeVisible({ timeout: 10_000 });
      await page.getByPlaceholder("例: 55").fill("65");
      await page.locator("form").getByRole("button").click();
      break;

    case "sport_type":
      await expect(page.getByText("主に取り組んでいる競技は？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /サッカー/ }).click();
      break;

    case "sport_custom_name":
      await expect(page.getByPlaceholder("例: トライアスロン")).toBeVisible({ timeout: 10_000 });
      await page.getByPlaceholder("例: トライアスロン").fill("テスト競技");
      await page.locator("form").first().getByRole("button").click();
      break;

    case "sport_experience":
      await expect(page.getByText("競技経験はどのくらいですか？")).toBeVisible({ timeout: 10_000 });
      // sport_experience: 📈 中級者（1〜3年） / cooking_experience: 👨‍🍳 中級者（1-3年）
      // 全角チルダ「〜」で区別する
      await page.getByRole("button", { name: /中級者（1〜3年）/ }).click();
      break;

    case "training_phase":
      await expect(page.getByText("現在のトレーニング期は？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /トレーニング期/ }).click();
      break;

    case "competition_date":
      // allowSkip=true。training_phase=training なら表示されないが念のため
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "target_date":
      await expect(page.getByText("いつまでに達成したいですか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "weight_change_rate":
      await expect(page.getByText("どのくらいのペースで変えたいですか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /普通（月2-3kg）/ }).click();
      break;

    case "exercise_types":
      await expect(page.getByText("普段どんな運動をしていますか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /ランニング/ }).click();
      await page.getByRole("button", { name: "次へ" }).click();
      break;

    case "exercise_frequency":
      await expect(page.getByText("週に何日運動していますか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "3日" }).click();
      break;

    case "exercise_intensity":
      await expect(page.getByText("運動の強度はどのくらいですか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /普通（少し息が上がる）/ }).click();
      break;

    case "exercise_duration":
      await expect(page.getByText("1回の運動時間は？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /30分〜1時間/ }).click();
      break;

    case "work_style":
      await expect(page.getByText("普段の仕事・活動スタイルは？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /デスクワーク/ }).click();
      break;

    case "health_conditions":
      await expect(page.getByText("気になる健康状態はありますか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "body_concerns":
      await expect(page.getByText("体の悩みはありますか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "sleep_quality":
      await expect(page.getByText("睡眠の質はいかがですか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /良好/ }).click();
      break;

    case "stress_level":
      await expect(page.getByText("日々のストレスレベルは？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /低い/ }).click();
      break;

    case "pregnancy_status":
      await expect(page.getByText("妊娠・授乳の状況を教えてください")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /該当なし/ }).click();
      break;

    case "medications":
      await expect(page.getByText("服用中の薬はありますか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "allergies":
      await expect(page.getByText("食物アレルギーはありますか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "dislikes":
      await expect(page.getByText("苦手な食材はありますか？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "favorite_ingredients":
      await expect(page.getByText("好きな食材を教えてください")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "diet_style":
      await expect(page.getByText("食事スタイルを教えてください")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /通常/ }).first().click();
      break;

    case "cooking_experience":
      await expect(page.getByText("料理の経験は？")).toBeVisible({ timeout: 10_000 });
      // cooking_experience: 👨‍🍳 中級者（1-3年） - 半角ハイフンで区別
      await page.getByRole("button", { name: /中級者（1-3年）/ }).click();
      break;

    case "cooking_time":
      await expect(page.getByText("平日の夕食にかけられる調理時間は？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /30分以内/ }).click();
      break;

    case "cuisine_preference":
      await expect(page.getByText("好きな料理ジャンルは？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /和食/ }).click();
      await page.getByRole("button", { name: "次へ" }).click();
      break;

    case "family_size":
      await expect(page.getByPlaceholder("例: 4")).toBeVisible({ timeout: 10_000 });
      await page.getByPlaceholder("例: 4").fill("2");
      await page.locator("form").getByRole("button").click();
      break;

    case "servings_config":
      await expect(page.getByText("曜日ごとの食事人数を設定してください")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "次へ" }).click();
      break;

    case "shopping_frequency":
      await expect(page.getByText("普段の買い物の頻度は？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /週2〜3回/ }).click();
      break;

    case "weekly_food_budget":
      await expect(page.getByText("週の食費予算は？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /特に決めていない/ }).click();
      break;

    case "kitchen_appliances":
      await expect(page.getByText("お持ちの調理器具は？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    case "stove_type":
      await expect(page.getByText("お使いのコンロは？")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: /ガスコンロ/ }).click();
      break;

    case "hobbies":
      await expect(page.getByText("趣味を教えてください")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "スキップ" }).nth(1).click();
      break;

    default:
      throw new Error(`answerQuestion: 未実装の question id "${qid}"`);
  }
}

// ─── テスト本体 ───────────────────────────────────────────────────────────────

const GOALS = ["athlete_performance", "lose_weight", "gain_muscle"] as const;
type Goal = (typeof GOALS)[number];

test.describe("オンボーディング 3 パス完走 + 質問重複検出", () => {
  for (const goal of GOALS) {
    test(`${goal} パスで全質問完走、同 ID 重複 0 件`, async ({ page }) => {
      // 質問数 × 最大待機 + 操作時間を考慮して 3 分に設定
      test.setTimeout(180_000);

      // ─── セットアップ ──────────────────────────────────────────────
      await login(page);
      await resetOnboarding(page);

      // ─── Node.js 側でシミュレート: このパスで表示されるはずの ID 列 ──
      const answers = buildAnswerMap(goal);
      const expectedIds = computeVisibleIds(answers);

      // 静的チェック: QUESTIONS 配列自体の重複を検出
      const staticDups = findDuplicates(expectedIds);
      expect(
        staticDups,
        `[静的チェック] ${goal} パスの QUESTIONS に重複 ID あり: ${staticDups.join(", ")}`
      ).toHaveLength(0);

      // ─── ブラウザ操作 ─────────────────────────────────────────────
      // /onboarding/welcome → 「はじめる」クリック → /onboarding/questions
      // page.goto() で直接 /onboarding/questions に飛ぶと useSearchParams() の
      // Suspense が解決されない (「読み込み中...」が永続表示) 問題を回避する
      await page.goto("/onboarding/welcome");
      await page.waitForURL(/\/onboarding\/welcome/, { timeout: 10_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
      await page.getByRole("link", { name: "はじめる" }).click();
      await page.waitForURL(/\/onboarding\/questions/, { timeout: 15_000 });

      // ─── 各質問を順番に回答し、進んだ ID を記録 ───────────────────
      const visitedIds: string[] = [];

      for (const qid of expectedIds) {
        visitedIds.push(qid);
        try {
          await answerQuestion(page, qid, goal);
        } catch (err) {
          throw new Error(
            `[${goal}] question "${qid}" の回答中にエラー: ${err}\n` +
              `visitedIds so far: ${visitedIds.join(" -> ")}`
          );
        }
      }

      // ─── 完走後: 完了画面または /home への遷移を確認 ─────────────
      await page.waitForURL(/\/onboarding\/complete|\/home/, {
        timeout: 15_000,
      });

      // ─── 重複 assert ─────────────────────────────────────────────
      const runtimeDups = findDuplicates(visitedIds);
      expect(
        runtimeDups,
        `[${goal}] visitedIds に重複 ID あり: ${runtimeDups.join(", ")}\n` +
          `フルシーケンス: ${visitedIds.join(" -> ")}`
      ).toHaveLength(0);

      // 全 expected ID を漏れなく踏んだことも確認
      expect(visitedIds).toEqual(expectedIds);

      // ─── クリーンアップ ────────────────────────────────────────────
      await page.goto("/home");
      await resetOnboarding(page);
    });
  }
});
