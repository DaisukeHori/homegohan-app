/**
 * 料理を創造するためのLLMロジック（共有モジュール）
 *
 * 高速化のため、Agent SDKではなく直接REST API呼び出しを使用
 */

import { z } from "zod";

// =========================================================
// Types / Schemas
// =========================================================

export const ALLOWED_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "midnight_snack"] as const;
export type MealType = (typeof ALLOWED_MEAL_TYPES)[number];

export const GeneratedDishSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["main", "side", "soup", "rice", "other"]),
  ingredients: z.array(z.object({
    name: z.string().min(1),
    amount_g: z.number(),
    note: z.string().optional(),
  })),
  instructions: z.array(z.string()),
});

export const GeneratedMealSchema = z.object({
  mealType: z.enum(ALLOWED_MEAL_TYPES),
  dishes: z.array(GeneratedDishSchema),
  advice: z.string().optional(),
});

export type GeneratedMeal = z.infer<typeof GeneratedMealSchema>;
export type GeneratedDish = z.infer<typeof GeneratedDishSchema>;

// =========================================================
// Helpers
// =========================================================

function stripMarkdownCodeBlock(text: string): string {
  let cleaned = text.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) cleaned = cleaned.substring(firstNewline + 1);
    if (cleaned.endsWith("```")) cleaned = cleaned.substring(0, cleaned.length - 3).trim();
  }

  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const jsonStart = cleaned.search(/[\{\[]/);
    if (jsonStart > 0) cleaned = cleaned.substring(jsonStart);
  }

  const lastBrace = cleaned.lastIndexOf("}");
  const lastBracket = cleaned.lastIndexOf("]");
  const jsonEnd = Math.max(lastBrace, lastBracket);
  if (jsonEnd > 0 && jsonEnd < cleaned.length - 1) cleaned = cleaned.substring(0, jsonEnd + 1);

  return cleaned.trim();
}

function safeJsonParse(text: string): unknown {
  let cleaned = stripMarkdownCodeBlock(text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("JSON parse failed (first attempt):", e);
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (char) => (char === "\n" || char === "\r" || char === "\t" ? char : ""));
    return JSON.parse(cleaned);
  }
}

// =========================================================
// 参考メニューの型
// =========================================================

export type MenuReference = {
  title: string;
  dishes: Array<{ name: string; role?: string; class_raw?: string }>;
};

// =========================================================
// 単一食事を創造するLLMエージェント
// =========================================================

export async function generateMealWithLLM(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  mealType: MealType;
  currentDishName: string | null;
  referenceMenus: MenuReference[];
}): Promise<GeneratedMeal> {
  const mealTypeJa = input.mealType === "breakfast" ? "朝食" 
    : input.mealType === "lunch" ? "昼食" 
    : input.mealType === "dinner" ? "夕食" 
    : input.mealType === "snack" ? "間食" 
    : "夜食";

  const systemPrompt =
    `あなたは日本の国家資格「管理栄養士」兼 料理研究家です。\n` +
    `このタスクは「${mealTypeJa}の献立を創造する」ことです。\n` +
    `\n` +
    `【絶対ルール】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- ingredients[].amount_g は必ず g 単位（大さじ/小さじ/個/本などは料理として自然なgに換算）\n` +
    `- ingredients[].name は **食材名のみ**（括弧・分量・用途・状態は入れない）\n` +
    `  - 例: 「キャベツ」「卵」「豚ひき肉」「ごま油」「醤油」\n` +
    `- instructions は手順ごとに分割し、番号なしで配列に入れる\n` +
    `- アレルギー/禁忌食材は絶対に使わない\n` +
    `\n` +
    `【献立の構成】\n` +
    `- 昼食・夕食は「1汁3菜」を基本（主菜 + 副菜 + 汁物 + ご飯など、3〜4品）\n` +
    `- 朝食は2品以上（主食 + 汁物 or おかず）\n` +
    `- 間食/夜食は1〜2品\n` +
    `\n` +
    `【品質（管理栄養士としての配慮）】\n` +
    `- ユーザーの料理経験/調理時間を考慮し、現実的に作れる献立を\n` +
    `- 減塩指示がある場合は、塩・醤油・味噌を控えめに、香味野菜/酢/だしで補う\n` +
    `- 野菜・たんぱく質のバランスを意識\n` +
    `- 日本の家庭料理として自然な組み合わせ\n` +
    `\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "mealType": "${input.mealType}",\n` +
    `  "dishes": [\n` +
    `    {\n` +
    `      "name": "料理名",\n` +
    `      "role": "main" | "side" | "soup" | "rice" | "other",\n` +
    `      "ingredients": [{ "name": "食材名", "amount_g": 数値, "note": "任意" }],\n` +
    `      "instructions": ["手順1", "手順2", ...]\n` +
    `    }\n` +
    `  ],\n` +
    `  "advice": "簡単な一言アドバイス（任意）"\n` +
    `}\n`;

  // 参考例を3つまで抜粋
  const referenceText = input.referenceMenus.slice(0, 3).map((m, i) => {
    const dishes = Array.isArray(m.dishes) ? m.dishes : [];
    const dishNames = dishes.map((d: any) => `${d.name}(${d.role || d.class_raw || "other"})`).join(", ");
    return `例${i + 1}: ${m.title} → ${dishNames}`;
  }).join("\n");

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${JSON.stringify(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【食事タイプ】\n${mealTypeJa}\n\n` +
    `${input.currentDishName ? `【現在の献立（これとは異なるものを）】\n${input.currentDishName}\n\n` : ""}` +
    `【参考にできる献立例（あくまで参考）】\n${referenceText}\n\n` +
    `上記を参考に、${mealTypeJa}の献立を創造してください。参考例をそのままコピーせず、ユーザーに合わせてアレンジしてください。`;

  // 直接REST API呼び出し（gpt-5.1-codex-mini - v1/responses API）
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [
        { role: "user", content: `${systemPrompt}\n\n---\n\n${userPrompt}` },
      ],
      reasoning_effort: "low",
      max_completion_tokens: 8000,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI API error: ${res.status} - ${errorText}`);
  }

  const json = await res.json();
  const out = json.choices?.[0]?.message?.content ?? "";
  if (!out) throw new Error("LLM output is empty");
  const parsed = safeJsonParse(out);
  return GeneratedMealSchema.parse(parsed);
}

// =========================================================
// 週間献立用：1日分を創造するLLMエージェント
// =========================================================

export const DailyGeneratedMealsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  meals: z.array(GeneratedMealSchema),
});

export type DailyGeneratedMeals = z.infer<typeof DailyGeneratedMealsSchema>;

export async function generateDayMealsWithLLM(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  date: string;
  mealTypes: MealType[];
  referenceMenus: MenuReference[];
  previousDayMeals?: string[]; // 前日の献立名（重複を避けるため）
}): Promise<DailyGeneratedMeals> {
  const systemPrompt =
    `あなたは日本の国家資格「管理栄養士」兼 料理研究家です。\n` +
    `このタスクは「1日分の献立を創造する」ことです。\n` +
    `\n` +
    `【絶対ルール】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- ingredients[].amount_g は必ず g 単位（大さじ/小さじ/個/本などは料理として自然なgに換算）\n` +
    `- ingredients[].name は **食材名のみ**（括弧・分量・用途・状態は入れない）\n` +
    `  - 例: 「キャベツ」「卵」「豚ひき肉」「ごま油」「醤油」\n` +
    `- instructions は手順ごとに分割し、番号なしで配列に入れる\n` +
    `- アレルギー/禁忌食材は絶対に使わない\n` +
    `\n` +
    `【献立の構成】\n` +
    `- 昼食・夕食は「1汁3菜」を基本（主菜 + 副菜 + 汁物 + ご飯など、3〜4品）\n` +
    `- 朝食は2品以上（主食 + 汁物 or おかず）\n` +
    `\n` +
    `【品質（管理栄養士としての配慮）】\n` +
    `- ユーザーの料理経験/調理時間を考慮し、現実的に作れる献立を\n` +
    `- 減塩指示がある場合は、塩・醤油・味噌を控えめに、香味野菜/酢/だしで補う\n` +
    `- 野菜・たんぱく質のバランスを意識\n` +
    `- 日本の家庭料理として自然な組み合わせ\n` +
    `- 前日の献立と同じ料理は避ける\n` +
    `- 中華・洋食・エスニックなど特定ジャンルが連続しすぎないようにする（和食・家庭料理の連続はOK）\n` +
    `\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "date": "${input.date}",\n` +
    `  "meals": [\n` +
    `    {\n` +
    `      "mealType": "breakfast" | "lunch" | "dinner",\n` +
    `      "dishes": [\n` +
    `        {\n` +
    `          "name": "料理名",\n` +
    `          "role": "main" | "side" | "soup" | "rice" | "other",\n` +
    `          "ingredients": [{ "name": "食材名", "amount_g": 数値, "note": "任意" }],\n` +
    `          "instructions": ["手順1", "手順2", ...]\n` +
    `        }\n` +
    `      ],\n` +
    `      "advice": "簡単な一言アドバイス（任意）"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n`;

  // 参考例を5つまで抜粋
  const referenceText = input.referenceMenus.slice(0, 5).map((m, i) => {
    const dishes = Array.isArray(m.dishes) ? m.dishes : [];
    const dishNames = dishes.map((d: any) => `${d.name}(${d.role || d.class_raw || "other"})`).join(", ");
    return `例${i + 1}: ${m.title} → ${dishNames}`;
  }).join("\n");

  const previousDayText = input.previousDayMeals?.length
    ? `【前日の献立（これらとは異なるものを）】\n${input.previousDayMeals.join("、")}\n\n`
    : "";

  const mealTypesJa = input.mealTypes.map(t =>
    t === "breakfast" ? "朝食" : t === "lunch" ? "昼食" : t === "dinner" ? "夕食" : t
  ).join("、");

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${JSON.stringify(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【日付】\n${input.date}\n\n` +
    `【生成する食事タイプ】\n${mealTypesJa}\n\n` +
    `${previousDayText}` +
    `【参考にできる献立例（あくまで参考）】\n${referenceText}\n\n` +
    `上記を参考に、${input.date}の1日分の献立（${mealTypesJa}）を創造してください。参考例をそのままコピーせず、ユーザーに合わせてアレンジしてください。`;

  // 直接REST API呼び出し（gpt-5.1-codex-mini - v1/responses API）
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [
        { role: "user", content: `${systemPrompt}\n\n---\n\n${userPrompt}` },
      ],
      reasoning_effort: "low",
      max_completion_tokens: 8000,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI API error: ${res.status} - ${errorText}`);
  }

  const json = await res.json();
  const out = json.choices?.[0]?.message?.content ?? "";
  if (!out) throw new Error("LLM output is empty");
  const parsed = safeJsonParse(out);
  return DailyGeneratedMealsSchema.parse(parsed);
}

// =========================================================
// 週間献立の全体俯瞰レビュー
// =========================================================

export type WeeklyMealsSummary = {
  date: string;
  meals: Array<{
    mealType: MealType;
    dishNames: string[];
  }>;
};

export type ReviewResult = {
  hasIssues: boolean;
  issues: Array<{
    date: string;
    mealType: MealType;
    issue: string;
    suggestion: string;
  }>;
  swaps: Array<{
    date1: string;
    mealType1: MealType;
    date2: string;
    mealType2: MealType;
    reason: string;
  }>;
};

const ReviewResultSchema = z.object({
  hasIssues: z.boolean(),
  issues: z.array(z.object({
    date: z.string(),
    mealType: z.enum(ALLOWED_MEAL_TYPES),
    issue: z.string(),
    suggestion: z.string(),
  })),
  swaps: z.array(z.object({
    date1: z.string(),
    mealType1: z.enum(ALLOWED_MEAL_TYPES),
    date2: z.string(),
    mealType2: z.enum(ALLOWED_MEAL_TYPES),
    reason: z.string(),
  })),
});

export async function reviewWeeklyMenus(input: {
  weeklyMeals: WeeklyMealsSummary[];
  userSummary: string;
}): Promise<ReviewResult> {
  const systemPrompt = 
    `あなたは日本の国家資格「管理栄養士」です。\n` +
    `1週間分の献立をレビューし、問題点を指摘してください。\n` +
    `\n` +
    `【チェックポイント】\n` +
    `1. 同日の昼と夜で主菜が被っていないか（例：昼も夜もカレー）\n` +
    `2. 連日で同じような料理が続いていないか（例：2日連続で焼き魚）\n` +
    `3. 特定ジャンル（中華、洋食など）が連続しすぎていないか（和食・家庭料理の連続はOK）\n` +
    `4. 昼食・夕食が「1汁3菜」になっているか（主菜+副菜+汁物+ご飯の3〜4品）\n` +
    `5. 昼と夜を入れ替えた方がバランスが良い場合\n` +
    `\n` +
    `【出力ルール】\n` +
    `- 出力は **厳密なJSONのみ**\n` +
    `- 問題がなければ hasIssues: false, issues: [], swaps: []\n` +
    `- 昼夜入れ替え推奨は swaps に記載\n` +
    `\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "hasIssues": boolean,\n` +
    `  "issues": [\n` +
    `    { "date": "YYYY-MM-DD", "mealType": "lunch"|"dinner", "issue": "問題の説明", "suggestion": "改善案" }\n` +
    `  ],\n` +
    `  "swaps": [\n` +
    `    { "date1": "YYYY-MM-DD", "mealType1": "lunch", "date2": "YYYY-MM-DD", "mealType2": "dinner", "reason": "理由" }\n` +
    `  ]\n` +
    `}\n`;

  // 週間献立をテキスト形式に変換
  const mealsText = input.weeklyMeals.map(day => {
    const mealsStr = day.meals.map(m => {
      const mealTypeJa = m.mealType === "breakfast" ? "朝食" 
        : m.mealType === "lunch" ? "昼食" 
        : m.mealType === "dinner" ? "夕食" : m.mealType;
      return `  ${mealTypeJa}: ${m.dishNames.join("、")}`;
    }).join("\n");
    return `${day.date}:\n${mealsStr}`;
  }).join("\n\n");

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【1週間の献立】\n${mealsText}\n\n` +
    `上記の献立をレビューしてください。`;

  // 直接REST API呼び出し（gpt-5.1-codex-mini - v1/responses API）
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [
        { role: "user", content: `${systemPrompt}\n\n---\n\n${userPrompt}` },
      ],
      reasoning_effort: "low",
      max_completion_tokens: 4000,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`OpenAI API error: ${res.status} - ${errorText}`);
    return { hasIssues: false, issues: [], swaps: [] };
  }

  const json = await res.json();
  const out = json.choices?.[0]?.message?.content ?? "";
  if (!out) {
    return { hasIssues: false, issues: [], swaps: [] };
  }

  try {
    const parsed = safeJsonParse(out);
    return ReviewResultSchema.parse(parsed);
  } catch (e) {
    console.error("Review parsing failed:", e);
    return { hasIssues: false, issues: [], swaps: [] };
  }
}

// =========================================================
// 問題のある食事を再生成
// =========================================================

export async function regenerateMealForIssue(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  date: string;
  mealType: MealType;
  currentDishes: string[];
  issue: string;
  suggestion: string;
  referenceMenus: MenuReference[];
}): Promise<GeneratedMeal> {
  const mealTypeJa = input.mealType === "breakfast" ? "朝食" 
    : input.mealType === "lunch" ? "昼食" 
    : input.mealType === "dinner" ? "夕食" 
    : input.mealType === "snack" ? "間食" 
    : "夜食";

  const systemPrompt =
    `あなたは日本の国家資格「管理栄養士」兼 料理研究家です。\n` +
    `このタスクは「${mealTypeJa}の献立を改善する」ことです。\n` +
    `\n` +
    `【絶対ルール】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- ingredients[].amount_g は必ず g 単位\n` +
    `- ingredients[].name は **食材名のみ**\n` +
    `- 昼食・夕食は「1汁3菜」を基本（主菜 + 副菜 + 汁物 + ご飯など、3〜4品）\n` +
    `- 朝食は2品以上\n` +
    `\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "mealType": "${input.mealType}",\n` +
    `  "dishes": [\n` +
    `    {\n` +
    `      "name": "料理名",\n` +
    `      "role": "main" | "side" | "soup" | "rice" | "other",\n` +
    `      "ingredients": [{ "name": "食材名", "amount_g": 数値, "note": "任意" }],\n` +
    `      "instructions": ["手順1", "手順2", ...]\n` +
    `    }\n` +
    `  ],\n` +
    `  "advice": "簡単な一言アドバイス（任意）"\n` +
    `}\n`;

  const referenceText = input.referenceMenus.slice(0, 3).map((m, i) => {
    const dishes = Array.isArray(m.dishes) ? m.dishes : [];
    const dishNames = dishes.map((d: any) => `${d.name}(${d.role || d.class_raw || "other"})`).join(", ");
    return `例${i + 1}: ${m.title} → ${dishNames}`;
  }).join("\n");

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${JSON.stringify(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【日付・食事タイプ】\n${input.date} ${mealTypeJa}\n\n` +
    `【現在の献立（問題あり）】\n${input.currentDishes.join("、")}\n\n` +
    `【問題点】\n${input.issue}\n\n` +
    `【改善案】\n${input.suggestion}\n\n` +
    `【参考にできる献立例】\n${referenceText}\n\n` +
    `上記の問題点を解決した新しい献立を創造してください。`;

  // 直接REST API呼び出し（gpt-5.1-codex-mini - v1/responses API）
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [
        { role: "user", content: `${systemPrompt}\n\n---\n\n${userPrompt}` },
      ],
      reasoning_effort: "low",
      max_completion_tokens: 8000,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI API error: ${res.status} - ${errorText}`);
  }

  const json = await res.json();
  const out = json.choices?.[0]?.message?.content ?? "";
  if (!out) throw new Error("LLM output is empty");
  const parsed = safeJsonParse(out);
  return GeneratedMealSchema.parse(parsed);
}
