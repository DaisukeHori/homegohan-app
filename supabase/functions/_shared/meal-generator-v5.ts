/**
 * V5 向けの prompt 層。
 *
 * V4 の meal-generator をベースにしつつ、sample seed / family brief /
 * breakfast template / forbidden names / sodium mode を明示的に prompt へ注入する。
 */

import { SINGLE_SERVING_PROMPT_GUIDANCE } from "./generation-serving.ts";
import {
  DailyGeneratedMealsSchema,
  GeneratedMealSchema,
  type DailyGeneratedMeals,
  type GeneratedMeal,
  type MealType,
  type MenuReference,
} from "./meal-generator.ts";
import { callV4FastLLM, type V4FastLLMSection } from "./v4-fast-llm.ts";
import type {
  BreakfastTemplate,
  MainDishFamily,
  SodiumMode,
} from "../generate-menu-v5/diversity-taxonomy.ts";

export type V5MealBrief = {
  sampleSeed?: MenuReference | null;
  referenceExamples?: MenuReference[];
  forbiddenDishNames?: string[];
  forbiddenMainDishFamilies?: MainDishFamily[];
  forbiddenBreakfastTemplates?: BreakfastTemplate[];
  requiredMainDishFamily?: MainDishFamily | null;
  requiredBreakfastTemplate?: BreakfastTemplate | null;
  sodiumMode?: SodiumMode | null;
};

type V5BriefByMealType = Partial<Record<MealType, V5MealBrief>>;

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
  } catch (error) {
    console.error("JSON parse failed (first attempt):", error);
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (char) => (char === "\n" || char === "\r" || char === "\t" ? char : ""));
    return JSON.parse(cleaned);
  }
}

async function callStructuredV5LLM<T>(params: {
  section: V4FastLLMSection;
  systemPrompt: string;
  userPrompt: string;
  maxCompletionTokens: number;
  schema: { parse(value: unknown): T };
}): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const retrySuffix = attempt === 0
      ? ""
      : "\n\n【再出力】前回は JSON が壊れていました。厳密な JSON のみを出力し、配列やオブジェクトの閉じ忘れ・余計な文字を絶対に入れないでください。";
    try {
      const { text } = await callV4FastLLM({
        section: params.section,
        systemPrompt: params.systemPrompt,
        userPrompt: `${params.userPrompt}${retrySuffix}`,
        maxCompletionTokens: params.maxCompletionTokens,
      });
      return params.schema.parse(safeJsonParse(text));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function prunePromptValue<T>(value: T): T | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed as T : undefined;
  }
  if (Array.isArray(value)) {
    const pruned = value
      .map((item) => prunePromptValue(item))
      .filter((item): item is NonNullable<typeof item> => item != null);
    return pruned.length > 0 ? pruned as T : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => [key, prunePromptValue(entryValue)] as const)
      .filter(([, entryValue]) => entryValue != null);
    return entries.length > 0 ? Object.fromEntries(entries) as T : undefined;
  }
  return value;
}

function buildCompactUserContextText(userContext: unknown): string {
  const ctx = (userContext ?? {}) as Record<string, any>;
  const compact = prunePromptValue({
    hard: {
      allergies: ctx?.hard?.allergies,
    },
    goals: {
      nutrition_goal: ctx?.goals?.nutrition_goal,
      weight_change_rate: ctx?.goals?.weight_change_rate,
      nutrition_targets: {
        daily_calories: ctx?.goals?.nutrition_targets?.daily_calories,
        protein_g: ctx?.goals?.nutrition_targets?.protein_g,
        sodium_g: ctx?.goals?.nutrition_targets?.sodium_g,
      },
    },
    performance: {
      sport_name: ctx?.performance?.sport_name,
      sport_role: ctx?.performance?.sport_role,
      phase: ctx?.performance?.phase,
      priorities: ctx?.performance?.priorities,
      is_growth_protection: ctx?.performance?.is_growth_protection,
      is_cutting: ctx?.performance?.is_cutting,
    },
    feasibility: {
      cooking_experience: ctx?.feasibility?.cooking_experience,
      weekday_cooking_minutes: ctx?.feasibility?.weekday_cooking_minutes,
      weekend_cooking_minutes: ctx?.feasibility?.weekend_cooking_minutes,
      family_size: ctx?.feasibility?.family_size,
    },
    preferences: {
      cuisine_preferences: ctx?.preferences?.cuisine_preferences,
      favorite_ingredients: Array.isArray(ctx?.preferences?.favorite_ingredients)
        ? ctx.preferences.favorite_ingredients.slice(0, 8)
        : undefined,
      dislikes: ctx?.preferences?.dislikes,
    },
    medical: {
      health_conditions: ctx?.medical?.health_conditions,
      medications: ctx?.medical?.medications,
    },
    weekly: {
      note: ctx?.weekly?.note,
      constraints: {
        useFridgeFirst: ctx?.weekly?.constraints?.useFridgeFirst,
        quickMeals: ctx?.weekly?.constraints?.quickMeals,
        japaneseStyle: ctx?.weekly?.constraints?.japaneseStyle,
        healthy: ctx?.weekly?.constraints?.healthy,
        themes: ctx?.weekly?.constraints?.themes,
        ingredients: Array.isArray(ctx?.weekly?.constraints?.ingredients)
          ? ctx.weekly.constraints.ingredients.slice(0, 10)
          : undefined,
        cookingTime: ctx?.weekly?.constraints?.cookingTime,
        familySize: ctx?.weekly?.constraints?.familySize,
        cheatDay: ctx?.weekly?.constraints?.cheatDay,
      },
    },
    health: {
      guidance: ctx?.health?.guidance
        ? {
            generalDirection: ctx.health.guidance.generalDirection,
            avoidanceHints: ctx.health.guidance.avoidanceHints,
            emphasisHints: ctx.health.guidance.emphasisHints,
            specialNotes: ctx.health.guidance.specialNotes,
          }
        : undefined,
    },
  });

  return JSON.stringify(compact ?? {});
}

function mealTypeToJa(mealType: MealType): string {
  return mealType === "breakfast"
    ? "朝食"
    : mealType === "lunch"
      ? "昼食"
      : mealType === "dinner"
        ? "夕食"
        : mealType === "snack"
          ? "間食"
          : "夜食";
}

function mainDishFamilyToJa(family: MainDishFamily | null | undefined): string {
  switch (family) {
    case "teriyaki_chicken":
      return "鶏の照り焼き系";
    case "simmered_chicken":
      return "鶏の煮物系";
    case "stir_fry_chicken":
      return "鶏の炒め物系";
    case "ginger_pork":
      return "豚の生姜焼き系";
    case "stir_fry_pork":
      return "豚の炒め物系";
    case "grilled_salmon":
      return "鮭の焼き魚系";
    case "foil_salmon":
      return "鮭のホイル焼き系";
    case "grilled_mackerel":
      return "さばの焼き魚系";
    case "miso_fish":
      return "味噌だれ系の魚 main";
    case "simmered_fish":
      return "魚の煮付け系";
    case "tofu_main":
      return "豆腐 main";
    case "egg_main":
      return "卵 main";
    case "curry_main":
      return "カレー系";
    case "gratin_main":
      return "グラタン・ドリア系";
    case "rice_bowl":
      return "丼もの";
    case "noodle_soup":
      return "麺類";
    case "other_main":
      return "その他";
    default:
      return String(family ?? "");
  }
}

function breakfastTemplateToJa(template: BreakfastTemplate | null | undefined): string {
  switch (template) {
    case "rice_miso_egg":
      return "ご飯 + 味噌汁 + 卵系";
    case "rice_miso_grilled_fish":
      return "ご飯 + 味噌汁 + 焼き魚系";
    case "rice_soup_tofu":
      return "ご飯 + 汁物 + 豆腐系";
    case "bread_egg":
      return "パン + 卵系";
    case "bread_yogurt":
      return "パン + ヨーグルト系";
    case "noodle_soup":
      return "麺 + 汁物";
    case "other_breakfast":
      return "その他の朝食";
    default:
      return String(template ?? "");
  }
}

function sodiumModeToJa(mode: SodiumMode | null | undefined): string {
  if (mode === "low") return "減塩モード";
  return "通常モード";
}

function renderReferenceMenu(menu: MenuReference | null | undefined, label: string): string {
  if (!menu) return "";
  const dishes = Array.isArray(menu.dishes) ? menu.dishes : [];
  const dishText = dishes
    .map((dish) => `${String(dish?.name ?? "")}(${String(dish?.role ?? dish?.class_raw ?? "other")})`)
    .filter(Boolean)
    .join(", ");
  return [`【${label}】`, `${menu.title} → ${dishText}`].join("\n");
}

function renderReferenceExamples(referenceMenus: MenuReference[], limit: number): string {
  return referenceMenus
    .slice(0, limit)
    .map((menu, index) => renderReferenceMenu(menu, `参考例${index + 1}`))
    .filter(Boolean)
    .join("\n\n");
}

function buildForbiddenDishNamesText(names: string[] | null | undefined): string {
  const normalized = [...new Set((names ?? []).map((name) => String(name ?? "").trim()).filter(Boolean))];
  if (normalized.length === 0) return "";
  return `【再出力禁止の料理名】\n${normalized.slice(0, 10).join("、")}`;
}

function buildForbiddenFamiliesText(families: MainDishFamily[] | null | undefined): string {
  const normalized = [...new Set((families ?? []).map((family) => String(family ?? "").trim()).filter(Boolean))];
  if (normalized.length === 0) return "";
  return `【禁止する主菜 family】\n${normalized.map((family) => mainDishFamilyToJa(family as MainDishFamily)).join("、")}`;
}

function buildForbiddenBreakfastTemplatesText(templates: BreakfastTemplate[] | null | undefined): string {
  const normalized = [...new Set((templates ?? []).map((template) => String(template ?? "").trim()).filter(Boolean))];
  if (normalized.length === 0) return "";
  return `【禁止する朝食 template】\n${normalized.map((template) => breakfastTemplateToJa(template as BreakfastTemplate)).join("、")}`;
}

function buildSodiumModeText(mode: SodiumMode | null | undefined): string {
  const lines = [
    "【塩分モード】",
    `${sodiumModeToJa(mode)}。塩・醤油・味噌を控えめにし、だし・酢・香味野菜・柑橘で味を立てること。`,
    "朝食は塩分 1.8g 前後、昼食・夕食は 3.0g 前後を目安にし、味噌汁・照り焼き・濃い汁物の重ねを避けること。",
    "同じ meal の中で、醤油だれ・味噌・ポン酢・梅肉・コンソメ強めの味付けを2品以上重ねないこと。",
    "1日の塩分合計は 10g を強く下回る方向で組み、汁物を入れる場合は主菜と副菜を薄味にすること。",
  ];
  if (mode !== "low") {
    return lines.join("\n");
  }
  lines.push("low の日は特に汁物・タレ・加工肉・漬物を重ねず、梅肉・キムチ・佃煮も避けること。");
  return lines.join("\n");
}

function buildFamilyNamingCue(family: MainDishFamily | null | undefined): string {
  switch (family) {
    case "teriyaki_chicken":
      return "主菜名には「照り焼き」を入れること。";
    case "simmered_chicken":
    case "simmered_fish":
      return "主菜名には「煮」「煮付け」「炊き」を入れ、煮物と分かる名前にすること。";
    case "stir_fry_chicken":
    case "stir_fry_pork":
      return "主菜名には「炒め」「ソテー」「回鍋肉風」など炒め系と分かる語を入れること。";
    case "ginger_pork":
      return "主菜名には「生姜」「しょうが焼き」を入れること。";
    case "grilled_salmon":
      return "主菜名には「焼き」「グリル」「ソテー」「ムニエル」など焼き物と分かる語を入れること。";
    case "foil_salmon":
      return "主菜名には「ホイル」または「包み焼き」を入れること。";
    case "miso_fish":
      return "主菜名には「味噌」「みそ」「西京」など味噌系と分かる語を入れること。";
    case "tofu_main":
      return "主菜名には「豆腐」または「厚揚げ」を入れること。";
    case "egg_main":
      return "主菜名には「卵」「オムレツ」「スクランブル」など卵系と分かる語を入れること。";
    case "curry_main":
      return "主菜名には「カレー」または「キーマ」を入れること。";
    case "gratin_main":
      return "主菜名には「グラタン」「ドリア」を入れること。";
    case "rice_bowl":
      return "主菜名には「丼」「混ぜご飯」「チャーハン」など主食系と分かる語を入れること。";
    case "noodle_soup":
      return "主菜名には「うどん」「そば」「麺」「パスタ」など麺類と分かる語を入れること。";
    default:
      return "";
  }
}

function buildStructureRuleText(input: {
  mealType: MealType;
  requiredMainDishFamily?: MainDishFamily | null;
  requiredBreakfastTemplate?: BreakfastTemplate | null;
}): string {
  const lines: string[] = [];

  if (input.requiredMainDishFamily && input.requiredMainDishFamily !== "rice_bowl" && input.requiredMainDishFamily !== "noodle_soup") {
    lines.push(`主菜 family が ${mainDishFamilyToJa(input.requiredMainDishFamily)} の場合、role="main" のおかずを必ず1品作ること。`);
    lines.push("ご飯・パン・麺は role=\"rice\" または role=\"other\" にし、主菜そのものにしないこと。");
  }
  lines.push("最もボリュームのあるたんぱく質おかず1品だけを role=\"main\" にし、汁物や主食には role=\"main\" を付けないこと。");
  const familyNamingCue = buildFamilyNamingCue(input.requiredMainDishFamily);
  if (familyNamingCue) {
    lines.push(familyNamingCue);
  }

  if (input.mealType === "breakfast") {
    switch (input.requiredBreakfastTemplate) {
      case "bread_egg":
        lines.push("朝食 template が パン + 卵系 の場合、パン1品と卵系のおかず1品を必ず含めること。");
        break;
      case "bread_yogurt":
        lines.push("朝食 template が パン + ヨーグルト系 の場合、パン1品とヨーグルト系1品を必ず含めること。");
        break;
      case "rice_miso_egg":
        lines.push("朝食 template が ご飯 + 味噌汁 + 卵系 の場合、ご飯・味噌汁・卵系おかずを揃えること。");
        break;
      case "rice_miso_grilled_fish":
        lines.push("朝食 template が ご飯 + 味噌汁 + 焼き魚系 の場合、ご飯・味噌汁・焼き魚の主菜を揃えること。");
        break;
      case "rice_soup_tofu":
        lines.push("朝食 template が ご飯 + 汁物 + 豆腐系 の場合、ご飯・汁物・豆腐系おかずを揃えること。");
        break;
      default:
        break;
    }
  }

  return lines.join("\n");
}

function buildPortionRuleText(input: {
  mealType: MealType;
  requiredMainDishFamily?: MainDishFamily | null;
  requiredBreakfastTemplate?: BreakfastTemplate | null;
}): string {
  const lines: string[] = [];

  if (input.mealType === "breakfast") {
    lines.push("朝食全体は 350〜550kcal を狙い、300kcal 未満の軽すぎる構成にしないこと。");
    lines.push("朝食は『主食1つ + 主たんぱく1つ + 補助1つ』を基本にし、パンと卵だけ・パンとヨーグルトだけの2品で終わらせないこと。");
    lines.push("ご飯系ならご飯 120〜160g、汁物 150〜220g、卵/魚/豆腐の主たんぱく食材 60〜100g を目安にすること。");
    lines.push("パン系ならパン 60〜90g に加え、卵 2個前後またはヨーグルト 100〜150g を含め、果物・サラダ・スープのいずれかを1品足すこと。");
  } else if (input.mealType === "lunch") {
    lines.push("昼食全体は 500〜800kcal を狙い、900kcal を超えるような重すぎる構成にしないこと。");
    lines.push("昼食は 3〜4品を基本にし、主菜の主たんぱく食材は 80〜130g を目安にすること。");
    lines.push("ご飯を付ける場合は 140〜180g を目安にし、丼・カレー・麺類の日は追加のご飯やパンを絶対に付けないこと。");
  } else if (input.mealType === "dinner") {
    lines.push("夕食全体は 550〜850kcal を狙い、950kcal を超えるような重すぎる構成にしないこと。");
    lines.push("夕食は 3〜4品を基本にし、主菜の主たんぱく食材は 90〜140g を目安にすること。");
    lines.push("ドリア・グラタン・カレー・丼・麺類を主役にした日は、汁物か副菜のどちらかを軽い1品に絞り、追加の主食を付けないこと。");
  }

  if (
    input.requiredMainDishFamily === "curry_main"
    || input.requiredMainDishFamily === "gratin_main"
    || input.requiredMainDishFamily === "rice_bowl"
    || input.requiredMainDishFamily === "noodle_soup"
  ) {
    lines.push("主菜 family が主食一体型または重めの family なので、全体は 2〜3品に抑え、別の重い副菜や追加主食を入れないこと。");
  }

  if (input.mealType === "breakfast" && input.requiredBreakfastTemplate === "bread_egg") {
    lines.push("パン + 卵系の朝食では、パン1品と卵主菜1品に加え、果物・ヨーグルト・サラダ・スープのいずれかを必ず付けること。");
  }
  if (input.mealType === "breakfast" && input.requiredBreakfastTemplate === "bread_yogurt") {
    lines.push("パン + ヨーグルト系の朝食では、パン1品とヨーグルト1品に加え、卵料理・果物・サラダのいずれかを必ず付けること。");
  }

  return lines.join("\n");
}

function buildV5SingleMealBrief(input: {
  mealType: MealType;
  sampleSeed?: MenuReference | null;
  referenceExamples?: MenuReference[];
  forbiddenDishNames?: string[];
  forbiddenMainDishFamilies?: MainDishFamily[];
  forbiddenBreakfastTemplates?: BreakfastTemplate[];
  requiredMainDishFamily?: MainDishFamily | null;
  requiredBreakfastTemplate?: BreakfastTemplate | null;
  sodiumMode?: SodiumMode | null;
}): string {
  const lines: string[] = [];
  lines.push("【V5 brief】");
  if (input.sampleSeed) {
    lines.push("sample seed を強く参考にしてよいが、完全一致コピーは禁止。");
    lines.push(renderReferenceMenu(input.sampleSeed, "sample seed"));
  }
  const referenceExamples = renderReferenceExamples(input.referenceExamples ?? [], 2);
  if (referenceExamples) {
    lines.push(`【family 参考例】\n${referenceExamples}`);
  }
  if (input.requiredMainDishFamily) {
    lines.push(`主菜 family を ${mainDishFamilyToJa(input.requiredMainDishFamily)} に合わせること。`);
  }
  if (input.mealType === "breakfast" && input.requiredBreakfastTemplate) {
    lines.push(`朝食 template を ${breakfastTemplateToJa(input.requiredBreakfastTemplate)} に合わせること。`);
  }
  const structureRules = buildStructureRuleText(input);
  if (structureRules) {
    lines.push(`【構成ルール】\n${structureRules}`);
  }
  const portionRules = buildPortionRuleText(input);
  if (portionRules) {
    lines.push(`【量感ルール】\n${portionRules}`);
  }
  const forbiddenText = buildForbiddenDishNamesText(input.forbiddenDishNames);
  if (forbiddenText) lines.push(forbiddenText);
  const forbiddenFamilyText = buildForbiddenFamiliesText(input.forbiddenMainDishFamilies);
  if (forbiddenFamilyText) lines.push(forbiddenFamilyText);
  const forbiddenBreakfastText = buildForbiddenBreakfastTemplatesText(input.forbiddenBreakfastTemplates);
  if (forbiddenBreakfastText) lines.push(forbiddenBreakfastText);
  const sodiumText = buildSodiumModeText(input.sodiumMode);
  if (sodiumText) lines.push(sodiumText);
  return lines.filter(Boolean).join("\n\n");
}

function buildV5DayBrief(briefByMealType: V5BriefByMealType | undefined, mealTypes: MealType[]): string {
  const sections = mealTypes
    .map((mealType) => {
      const brief = briefByMealType?.[mealType];
      if (!brief) return "";
      const lines: string[] = [];
      lines.push(`【${mealTypeToJa(mealType)} の V5 brief】`);
      if (brief.sampleSeed) {
        lines.push(renderReferenceMenu(brief.sampleSeed, "sample seed"));
        lines.push("sample を強く参考にしてよいが、主菜名または副菜/汁物の構成を少なくとも一部変えること。");
      }
      const referenceExamples = renderReferenceExamples(brief.referenceExamples ?? [], 2);
      if (referenceExamples) {
        lines.push(`【family 参考例】\n${referenceExamples}`);
      }
      if (brief.requiredMainDishFamily) {
        lines.push(`主菜 family: ${mainDishFamilyToJa(brief.requiredMainDishFamily)}`);
      }
      if (mealType === "breakfast" && brief.requiredBreakfastTemplate) {
        lines.push(`朝食 template: ${breakfastTemplateToJa(brief.requiredBreakfastTemplate)}`);
      }
      const structureRules = buildStructureRuleText({
        mealType,
        requiredMainDishFamily: brief.requiredMainDishFamily,
        requiredBreakfastTemplate: brief.requiredBreakfastTemplate,
      });
      if (structureRules) {
        lines.push(`【構成ルール】\n${structureRules}`);
      }
      const portionRules = buildPortionRuleText({
        mealType,
        requiredMainDishFamily: brief.requiredMainDishFamily,
        requiredBreakfastTemplate: brief.requiredBreakfastTemplate,
      });
      if (portionRules) {
        lines.push(`【量感ルール】\n${portionRules}`);
      }
      const forbiddenText = buildForbiddenDishNamesText(brief.forbiddenDishNames);
      if (forbiddenText) lines.push(forbiddenText);
      const forbiddenFamilyText = buildForbiddenFamiliesText(brief.forbiddenMainDishFamilies);
      if (forbiddenFamilyText) lines.push(forbiddenFamilyText);
      const forbiddenBreakfastText = buildForbiddenBreakfastTemplatesText(brief.forbiddenBreakfastTemplates);
      if (forbiddenBreakfastText) lines.push(forbiddenBreakfastText);
      const sodiumText = buildSodiumModeText(brief.sodiumMode);
      if (sodiumText) lines.push(sodiumText);
      return lines.filter(Boolean).join("\n");
    })
    .filter(Boolean);

  return sections.join("\n\n");
}

function buildBaseSingleMealSystemPrompt(mealType: MealType): string {
  const mealTypeJa = mealTypeToJa(mealType);
  return (
    `あなたは日本の国家資格「管理栄養士」兼 料理研究家です。\n` +
    `このタスクは「${mealTypeJa}の献立を創造する」ことです。\n` +
    `\n` +
    `【絶対ルール】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- ingredients[].amount_g は必ず g 単位（大さじ/小さじ/個/本などは料理として自然なgに換算）\n` +
    `${SINGLE_SERVING_PROMPT_GUIDANCE}\n` +
    `- ingredients[].name は **食材名のみ**（括弧・分量・用途・状態は入れない）\n` +
    `- instructions は手順ごとに分割し、番号なしで配列に入れる\n` +
    `- アレルギー/禁忌食材は絶対に使わない\n` +
    `\n` +
    `【V5 固有ルール】\n` +
    `- sample seed は強く参考にしてよいが、献立の完全コピーは禁止\n` +
      `- forbiddenDishNames に含まれる料理名はそのまま再出力しない\n` +
      `- requiredMainDishFamily が指定されたら、その family の主菜に合わせる\n` +
      `- forbiddenMainDishFamilies に含まれる主菜 family は絶対に使わない\n` +
      `- 朝食で requiredBreakfastTemplate が指定されたら、その template に合わせる\n` +
      `- forbiddenBreakfastTemplates に含まれる朝食 template は使わない\n` +
      `- sodiumMode が low の場合は減塩を優先し、濃い味の汁物やタレを重ねない\n` +
      `- 最もボリュームのあるたんぱく質おかず1品だけを role="main" にし、汁物や主食に role="main" を付けない\n` +
      `- 朝食は昼食や夕食のような重い主菜にしない。炒め物・カレー・グラタンより、主食 + 卵/魚/豆腐/ヨーグルト/サラダ/汁物の軽い構成を優先する\n` +
      `- 同じ meal の中で味の軸や主食を重ねない。味噌主菜 + 味噌汁、パン + サンドイッチ + トーストのような重複は避ける\n` +
      `- ご飯・パン・麺・パスタ・丼・カレーなどの主食は1食につき1種類まで。重複させない\n` +
      `- パスタ・麺・丼・カレーを主食にした場合、別のご飯やパンを追加しない\n` +
      `- 朝食の塩分は2g前後、昼食は3g前後、夕食は4g前後を目安にする\n` +
      `- 朝食は 350〜550kcal、昼食は 500〜800kcal、夕食は 550〜850kcal を目安にし、朝食を軽すぎず昼夕を重すぎない量感にする\n` +
      `- パン系朝食はパンと卵/ヨーグルトだけで終わらせず、果物・サラダ・スープのいずれかを追加する\n` +
      `- カレー・ドリア・グラタン・丼・麺類の日は 2〜3品に抑え、追加の主食や重い副菜を入れない\n` +
      `\n` +
    `【献立の構成】\n` +
    `- 昼食・夕食は主菜 + 副菜 + 汁物 + ご飯を基本にしつつ、重い主菜の日は 2〜3品に抑える\n` +
    `- 朝食は2品以上（主食 + 汁物 or おかず）\n` +
    `- 間食/夜食は1〜2品\n` +
    `\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "mealType": "${mealType}",\n` +
    `  "dishes": [\n` +
    `    {\n` +
    `      "name": "料理名",\n` +
    `      "role": "main" | "side" | "soup" | "rice" | "other",\n` +
    `      "ingredients": [{ "name": "食材名", "amount_g": 数値, "note": "任意" }],\n` +
    `      "instructions": ["手順1", "手順2", ...]\n` +
    `    }\n` +
    `  ],\n` +
    `  "advice": "簡単な一言アドバイス（任意）"\n` +
    `}\n`
  );
}

function buildBaseDaySystemPrompt(date: string): string {
  return (
    `あなたは日本の国家資格「管理栄養士」兼 料理研究家です。\n` +
    `このタスクは「1日分の献立を創造する」ことです。\n` +
    `\n` +
    `【絶対ルール】\n` +
    `- 出力は **厳密なJSONのみ**（Markdown/説明文/コードブロック禁止）\n` +
    `- ingredients[].amount_g は必ず g 単位（大さじ/小さじ/個/本などは料理として自然なgに換算）\n` +
    `${SINGLE_SERVING_PROMPT_GUIDANCE}\n` +
    `- ingredients[].name は **食材名のみ**（括弧・分量・用途・状態は入れない）\n` +
    `- instructions は手順ごとに分割し、番号なしで配列に入れる\n` +
    `- アレルギー/禁忌食材は絶対に使わない\n` +
    `\n` +
    `【V5 固有ルール】\n` +
      `- 各 mealType ごとに与えられた sample seed / main dish family / breakfast template / forbidden names を守る\n` +
      `- sample seed は参考にできるが、同じ献立のコピーは禁止\n` +
      `- 前日と近接 slot の重複を避け、V5 brief の family/template を優先する\n` +
      `- 禁止された主菜 family や朝食 template を再利用しない\n` +
      `- 各 meal で、最もボリュームのあるたんぱく質おかず1品だけを role="main" にする\n` +
      `- 朝食は軽く整った構成を優先し、回鍋肉・カレー・グラタンなど昼夕向けの重い main は避ける\n` +
      `- 同じ meal で味噌の重ね、パンの重ね、主食の二重化を避ける\n` +
      `- ご飯・パン・麺・パスタ・丼・カレーなどの主食は1食につき1種類まで。重複させない\n` +
      `- パスタ・麺・丼・カレーを主食にした meal では、別のご飯やパンを追加しない\n` +
      `- 朝食の塩分は2g前後、昼食は3g前後、夕食は4g前後を目安にする\n` +
      `- 朝食は 350〜550kcal、昼食は 500〜800kcal、夕食は 550〜850kcal を目安にし、朝食を軽すぎず昼夕を重すぎない量感にする\n` +
      `- パン系朝食はパンと卵/ヨーグルトだけで終わらせず、果物・サラダ・スープのいずれかを追加する\n` +
      `- カレー・ドリア・グラタン・丼・麺類の日は 2〜3品に抑え、追加の主食や重い副菜を入れない\n` +
      `\n` +
    `【献立の構成】\n` +
    `- 昼食・夕食は 3〜4品を基本とし、重い主菜の日は 2〜3品に抑える\n` +
    `- 朝食は 3品前後を基本（主食 + 主たんぱく + 補助1品）\n` +
    `\n` +
    `出力JSONスキーマ:\n` +
    `{\n` +
    `  "date": "${date}",\n` +
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
    `}\n`
  );
}

export async function generateMealWithLLM_V5(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  mealType: MealType;
  currentDishName: string | null;
  referenceMenus: MenuReference[];
  referenceSummary?: string | null;
  sampleSeed?: MenuReference | null;
  forbiddenDishNames?: string[];
  forbiddenMainDishFamilies?: MainDishFamily[];
  forbiddenBreakfastTemplates?: BreakfastTemplate[];
  requiredMainDishFamily?: MainDishFamily | null;
  requiredBreakfastTemplate?: BreakfastTemplate | null;
  sodiumMode?: SodiumMode | null;
}): Promise<GeneratedMeal> {
  const mealTypeJa = mealTypeToJa(input.mealType);
  const systemPrompt = buildBaseSingleMealSystemPrompt(input.mealType);
  const v5Brief = buildV5SingleMealBrief({
    mealType: input.mealType,
    sampleSeed: input.sampleSeed,
    forbiddenDishNames: input.forbiddenDishNames,
    forbiddenMainDishFamilies: input.forbiddenMainDishFamilies,
    forbiddenBreakfastTemplates: input.forbiddenBreakfastTemplates,
    requiredMainDishFamily: input.requiredMainDishFamily,
    requiredBreakfastTemplate: input.requiredBreakfastTemplate,
    sodiumMode: input.sodiumMode,
  });
  const referenceText = renderReferenceExamples(input.referenceMenus, 3);

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${buildCompactUserContextText(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【食事タイプ】\n${mealTypeJa}\n\n` +
    `${input.currentDishName ? `【現在の献立（これとは異なるものを）】\n${input.currentDishName}\n\n` : ""}` +
    `${v5Brief ? `${v5Brief}\n\n` : ""}` +
    `${input.referenceSummary ? `【参考献立の要約】\n${input.referenceSummary}\n\n` : ""}` +
    `${referenceText ? `【参考にできる献立例】\n${referenceText}\n\n` : ""}` +
    `上記を参考に、${mealTypeJa}の献立を創造してください。`;

  return await callStructuredV5LLM({
    section: "generateMealWithLLM",
    systemPrompt,
    userPrompt,
    maxCompletionTokens: 2600,
    schema: GeneratedMealSchema,
  });
}

export async function generateDayMealsWithLLM_V5(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  date: string;
  mealTypes: MealType[];
  referenceMenus: MenuReference[];
  referenceSummary?: string | null;
  previousDayMeals?: string[];
  briefByMealType?: V5BriefByMealType;
}): Promise<DailyGeneratedMeals> {
  const systemPrompt = buildBaseDaySystemPrompt(input.date);
  const mealTypesJa = input.mealTypes.map((mealType) => mealTypeToJa(mealType)).join("、");
  const previousDayText = input.previousDayMeals?.length
    ? `【前日の献立（これらとは異なるものを）】\n${input.previousDayMeals.join("、")}\n\n`
    : "";
  const dayBrief = buildV5DayBrief(input.briefByMealType, input.mealTypes);
  const referenceText = renderReferenceExamples(input.referenceMenus, 5);

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${buildCompactUserContextText(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【日付】\n${input.date}\n\n` +
    `【生成する食事タイプ】\n${mealTypesJa}\n\n` +
    `${previousDayText}` +
    `${dayBrief ? `${dayBrief}\n\n` : ""}` +
    `${input.referenceSummary ? `【参考献立の要約】\n${input.referenceSummary}\n\n` : ""}` +
    `${referenceText ? `【参考にできる献立例】\n${referenceText}\n\n` : ""}` +
    `上記を参考に、${input.date}の1日分の献立（${mealTypesJa}）を創造してください。各 mealType の V5 brief を優先してください。`;

  return await callStructuredV5LLM({
    section: "generateDayMealsWithLLM",
    systemPrompt,
    userPrompt,
    maxCompletionTokens: 3200,
    schema: DailyGeneratedMealsSchema,
  });
}

export async function regenerateMealForIssue_V5(input: {
  userSummary: string;
  userContext: unknown;
  note: string | null;
  date: string;
  mealType: MealType;
  currentDishes: string[];
  issue: string;
  suggestion: string;
  referenceMenus: MenuReference[];
  referenceSummary?: string | null;
  sampleSeed?: MenuReference | null;
  forbiddenDishNames?: string[];
  forbiddenMainDishFamilies?: MainDishFamily[];
  forbiddenBreakfastTemplates?: BreakfastTemplate[];
  requiredMainDishFamily?: MainDishFamily | null;
  requiredBreakfastTemplate?: BreakfastTemplate | null;
  sodiumMode?: SodiumMode | null;
}): Promise<GeneratedMeal> {
  const mealTypeJa = mealTypeToJa(input.mealType);
  const systemPrompt = buildBaseSingleMealSystemPrompt(input.mealType);
  const v5Brief = buildV5SingleMealBrief({
    mealType: input.mealType,
    sampleSeed: input.sampleSeed,
    forbiddenDishNames: input.forbiddenDishNames,
    forbiddenMainDishFamilies: input.forbiddenMainDishFamilies,
    forbiddenBreakfastTemplates: input.forbiddenBreakfastTemplates,
    requiredMainDishFamily: input.requiredMainDishFamily,
    requiredBreakfastTemplate: input.requiredBreakfastTemplate,
    sodiumMode: input.sodiumMode,
  });
  const referenceText = renderReferenceExamples(input.referenceMenus, 3);

  const userPrompt =
    `【ユーザー情報】\n${input.userSummary}\n\n` +
    `【ユーザーコンテキスト(JSON)】\n${buildCompactUserContextText(input.userContext)}\n\n` +
    `${input.note ? `【要望】\n${input.note}\n\n` : ""}` +
    `【日付・食事タイプ】\n${input.date} ${mealTypeJa}\n\n` +
    `【現在の献立（問題あり）】\n${input.currentDishes.join("、")}\n\n` +
    `【問題点】\n${input.issue}\n\n` +
    `【改善案】\n${input.suggestion}\n\n` +
    `${v5Brief ? `${v5Brief}\n\n` : ""}` +
    `${input.referenceSummary ? `【参考献立の要約】\n${input.referenceSummary}\n\n` : ""}` +
    `${referenceText ? `【参考にできる献立例】\n${referenceText}\n\n` : ""}` +
    `上記の問題点を解決した新しい献立を創造してください。V5 brief がある場合は最優先してください。`;

  return await callStructuredV5LLM({
    section: "regenerateMealForIssue",
    systemPrompt,
    userPrompt,
    maxCompletionTokens: 2600,
    schema: GeneratedMealSchema,
  });
}
