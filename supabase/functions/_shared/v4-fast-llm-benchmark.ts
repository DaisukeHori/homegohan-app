import {
  generateMealWithLLM,
  generateDayMealsWithLLM,
  regenerateMealForIssue,
  type MenuReference,
} from "./meal-generator.ts";
import { selectBestMatchWithLLM } from "./ingredient-matcher.ts";
import { getV4FastLLMConfig } from "./v4-fast-llm.ts";

export type V4FastLLMBenchmarkResult = {
  provider: string;
  model: string;
  iterations: number;
  sections: Array<{
    section: string;
    runs_ms: number[];
    avg_ms: number;
    avg_seconds: number;
  }>;
};

const userSummary = "30代、平日は時短希望、減塩を意識。和食中心で野菜をしっかり取りたい。";
const userContext = {
  goals: {
    nutrition_goal: "健康管理",
  },
  constraints: {
    weekdayCookingMinutes: 20,
    healthy: true,
    japaneseStyle: true,
  },
};

const references: MenuReference[] = [
  {
    title: "焼き魚定食",
    dishes: [
      { name: "鮭の塩焼き", role: "main" },
      { name: "ほうれん草のおひたし", role: "side" },
      { name: "豆腐とわかめの味噌汁", role: "soup" },
      { name: "ご飯", role: "rice" },
    ],
  },
  {
    title: "鶏の照り焼き定食",
    dishes: [
      { name: "鶏の照り焼き", role: "main" },
      { name: "切り干し大根", role: "side" },
      { name: "なめこの味噌汁", role: "soup" },
      { name: "ご飯", role: "rice" },
    ],
  },
  {
    title: "豚しゃぶ定食",
    dishes: [
      { name: "豚しゃぶサラダ", role: "main" },
      { name: "きんぴらごぼう", role: "side" },
      { name: "かぼちゃの味噌汁", role: "soup" },
      { name: "麦ご飯", role: "rice" },
    ],
  },
];

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function measure(iterations: number, label: string, fn: () => Promise<unknown>) {
  const runs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const startedAt = performance.now();
    const currentConsoleLog = console.log;
    try {
      console.log = () => {};
      await fn();
    } finally {
      console.log = currentConsoleLog;
    }
    runs.push(Math.round((performance.now() - startedAt) * 1000) / 1000);
  }

  const avgMs = average(runs);
  return {
    section: label,
    runs_ms: runs,
    avg_ms: Math.round(avgMs * 1000) / 1000,
    avg_seconds: Math.round((avgMs / 1000) * 1000) / 1000,
  };
}

export async function runV4FastLLMBenchmark(iterations = 2): Promise<V4FastLLMBenchmarkResult> {
  const config = getV4FastLLMConfig();

  const results: V4FastLLMBenchmarkResult = {
    provider: config.provider,
    model: config.model,
    iterations,
    sections: [],
  };

  results.sections.push(await measure(iterations, "generateMealWithLLM", async () => {
    await generateMealWithLLM({
      userSummary,
      userContext,
      note: "夜遅いので軽めの間食にしてください。タンパク質は確保したいです。",
      mealType: "snack",
      currentDishName: null,
      referenceMenus: references,
    });
  }));

  results.sections.push(await measure(iterations, "generateDayMealsWithLLM", async () => {
    await generateDayMealsWithLLM({
      userSummary,
      userContext,
      note: "平日なので20分以内で作れて、夕食は魚を入れてください。",
      date: "2026-03-20",
      mealTypes: ["breakfast", "lunch", "dinner"],
      referenceMenus: references,
      previousDayMeals: ["カレーライス", "唐揚げ", "ラーメン"],
    });
  }));

  results.sections.push(await measure(iterations, "regenerateMealForIssue", async () => {
    await regenerateMealForIssue({
      userSummary,
      userContext,
      note: "重複を避けつつ減塩で。",
      date: "2026-03-21",
      mealType: "dinner",
      currentDishes: ["チキンカレー", "ポテトサラダ", "コンソメスープ"],
      issue: "前日と主菜の方向性が近く、塩分もやや高い。",
      suggestion: "魚または豆腐中心にして、だしや酸味を活かした和風献立へ変更する。",
      referenceMenus: references,
    });
  }));

  results.sections.push(await measure(iterations, "ingredientMatcher.selectBestMatchWithLLM", async () => {
    await selectBestMatchWithLLM("ごはん", [
      {
        id: "1",
        name: "こめ［水稲めし］ 精白米 うるち米",
        name_norm: "こめすいとうめしせいはくまいうるちまい",
        similarity: 0.84,
        calories_kcal: 156,
      },
      {
        id: "2",
        name: "こめ［水稲穀粒］ 精白米 うるち米 乾",
        name_norm: "こめすいとうこくりゅうせいはくまいうるちまいかん",
        similarity: 0.8,
        calories_kcal: 342,
      },
      {
        id: "3",
        name: "おおむぎ［押麦めし］",
        name_norm: "おおむぎおしむぎめし",
        similarity: 0.71,
        calories_kcal: 152,
      },
    ]);
  }));

  return results;
}
