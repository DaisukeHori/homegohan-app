import type { MealDiversityFingerprint } from "./diversity-fingerprint.ts";
import { isHighSodiumFamily, normalizeMenuText, type SodiumMode } from "./diversity-taxonomy.ts";
import { clusterMenuTemplates, type MealType, type MenuTemplate, type MenuTemplateCluster } from "./template-catalog.ts";

export type TargetSlotLike = {
  date: string;
  mealType: Exclude<MealType, "any">;
};

export type SlotPlan = {
  date: string;
  mealType: Exclude<MealType, "any">;
  seedTemplateId: string;
  seedClusterId: string;
  templateTitle: string;
  requiredMainDishFamily: MenuTemplate["mainDishFamily"];
  requiredProteinFamily: MenuTemplate["proteinFamily"];
  requiredBreakfastTemplate: MenuTemplate["breakfastTemplate"];
  sodiumMode: SodiumMode;
  forbiddenTemplateIds: string[];
  forbiddenClusterIds: string[];
  forbiddenDishNames: string[];
  themeTags: string[];
};

export type SlotPlanResult = {
  slotPlans: Record<string, SlotPlan>;
  orderedPlans: SlotPlan[];
  clusters: MenuTemplateCluster[];
};

const SYNTHETIC_BREAKFAST_VARIANTS = [
  {
    requiredBreakfastTemplate: "rice_miso_egg",
    requiredMainDishFamily: "egg_main",
    requiredProteinFamily: "egg",
  },
  {
    requiredBreakfastTemplate: "bread_egg",
    requiredMainDishFamily: "egg_main",
    requiredProteinFamily: "egg",
  },
  {
    requiredBreakfastTemplate: "rice_miso_grilled_fish",
    requiredMainDishFamily: "grilled_salmon",
    requiredProteinFamily: "salmon",
  },
  {
    requiredBreakfastTemplate: "rice_soup_tofu",
    requiredMainDishFamily: "tofu_main",
    requiredProteinFamily: "tofu",
  },
] as const;

function getSlotKey(date: string, mealType: string): string {
  return `${date}:${mealType}`;
}

function sortTargetSlots(slots: TargetSlotLike[]): TargetSlotLike[] {
  const order: Record<string, number> = {
    breakfast: 10,
    lunch: 20,
    dinner: 30,
    snack: 40,
    midnight_snack: 50,
  };
  return [...slots].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (order[a.mealType] ?? 999) - (order[b.mealType] ?? 999);
  });
}

function getDayDistance(a: string, b: string): number {
  const lhs = new Date(`${a}T00:00:00.000Z`).getTime();
  const rhs = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.abs(Math.round((lhs - rhs) / (1000 * 60 * 60 * 24)));
}

function getSyntheticBreakfastVariant(date: string) {
  const seed = Math.abs(new Date(`${date}T00:00:00.000Z`).getUTCDate());
  return SYNTHETIC_BREAKFAST_VARIANTS[seed % SYNTHETIC_BREAKFAST_VARIANTS.length];
}

function buildBuckets(templates: MenuTemplate[]): Record<MealType, MenuTemplate[]> {
  const buckets: Record<MealType, MenuTemplate[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snack: [],
    midnight_snack: [],
    any: [],
  };
  const breakfastFallback: MenuTemplate[] = [];
  for (const template of templates) {
    if (template.breakfastTemplate !== "other_breakfast") {
      buckets.breakfast.push(template);
    } else if (template.mealType === "breakfast" && isBreakfastFallbackCandidate(template)) {
      buckets.breakfast.push(template);
    } else if (isBreakfastFallbackCandidate(template)) {
      breakfastFallback.push(template);
    }

    if (template.mealType !== "breakfast") {
      buckets[template.mealType].push(template);
    }
    buckets.any.push(template);
  }
  if (buckets.breakfast.length === 0) {
    buckets.breakfast.push(...breakfastFallback);
  } else if (buckets.breakfast.length < 8) {
    const usedIds = new Set(buckets.breakfast.map((template) => template.id));
    buckets.breakfast.push(
      ...breakfastFallback.filter((template) => !usedIds.has(template.id)).slice(0, 8 - buckets.breakfast.length),
    );
  }
  return buckets;
}

function isHeavyBreakfastFamily(family: MenuTemplate["mainDishFamily"]): boolean {
  return family === "stir_fry_chicken"
    || family === "ginger_pork"
    || family === "stir_fry_pork"
    || family === "curry_main"
    || family === "gratin_main";
}

function getTemplateCalories(candidate: MenuTemplate): number | null {
  const calories = Number(candidate.nutrients?.calories_kcal);
  return Number.isFinite(calories) ? calories : null;
}

function getTemplateSodiumPenalty(slot: TargetSlotLike, candidate: MenuTemplate, sodiumMode: SodiumMode): number {
  const sodium = Number(candidate.nutrients?.sodium_g);
  if (!Number.isFinite(sodium) || sodium <= 0) {
    if (sodiumMode === "low" && isHighSodiumFamily(candidate.mainDishFamily)) return 520;
    if ((slot.mealType === "lunch" || slot.mealType === "dinner") && isHighSodiumFamily(candidate.mainDishFamily)) return 180;
    return 0;
  }

  if (slot.mealType === "breakfast") {
    if (sodium > 2.6) return 520 + Math.round((sodium - 2.6) * 70);
    if (sodium > 1.9) return 260 + Math.round((sodium - 1.9) * 50);
  } else if (slot.mealType === "lunch" || slot.mealType === "dinner") {
    if (sodium > 4.2) return 440 + Math.round((sodium - 4.2) * 55);
    if (sodium > 3.2) return 220 + Math.round((sodium - 3.2) * 40);
  }

  if (sodiumMode === "low" && isHighSodiumFamily(candidate.mainDishFamily)) return 520;
  if ((slot.mealType === "lunch" || slot.mealType === "dinner") && isHighSodiumFamily(candidate.mainDishFamily)) return 180;
  return 0;
}

function getHeavyFamilyPenalty(slot: TargetSlotLike, candidate: MenuTemplate): number {
  if (slot.mealType !== "lunch" && slot.mealType !== "dinner") return 0;
  if (candidate.mainDishFamily === "curry_main") return slot.mealType === "dinner" ? 220 : 140;
  if (candidate.mainDishFamily === "gratin_main") return slot.mealType === "dinner" ? 180 : 120;
  if (candidate.mainDishFamily === "rice_bowl") return 120;
  return 0;
}

function getTemplateCaloriePenalty(slot: TargetSlotLike, candidate: MenuTemplate): number {
  const calories = getTemplateCalories(candidate);
  if (slot.mealType === "breakfast") {
    if (calories == null) {
      if (candidate.dishCount <= 1) return 260;
      if (candidate.dishCount === 2) return 120;
      if (candidate.dishCount >= 5) return 120;
      return 0;
    }
    if (calories < 250) return 520 + Math.round((250 - calories) * 1.2);
    if (calories < 320) return 240 + Math.round((320 - calories) * 0.8);
    if (calories > 680) return 300 + Math.round((calories - 680) * 0.6);
    if (calories > 560) return 120 + Math.round((calories - 560) * 0.4);
    return 0;
  }

  if (slot.mealType === "lunch" || slot.mealType === "dinner") {
    if (calories == null) {
      if (candidate.dishCount >= 5) return 120;
      return 0;
    }
    if (calories < 420) return 180 + Math.round((420 - calories) * 0.5);
    if (calories > 1000) return 420 + Math.round((calories - 1000) * 0.8);
    if (calories > 880) return 220 + Math.round((calories - 880) * 0.5);
    return 0;
  }

  return 0;
}

function getDishCountAdjustment(slot: TargetSlotLike, candidate: MenuTemplate): number {
  if (slot.mealType === "breakfast") {
    if (candidate.dishCount >= 3 && candidate.dishCount <= 4) return 60;
    if (candidate.dishCount === 2) return -40;
    if (candidate.dishCount >= 5) return -80;
    return -120;
  }

  if (slot.mealType === "lunch" || slot.mealType === "dinner") {
    if (candidate.mainDishFamily === "curry_main"
      || candidate.mainDishFamily === "gratin_main"
      || candidate.mainDishFamily === "rice_bowl"
      || candidate.mainDishFamily === "noodle_soup") {
      if (candidate.dishCount <= 3) return 30;
      return -140;
    }
    if (candidate.dishCount >= 3 && candidate.dishCount <= 4) return 50;
    if (candidate.dishCount === 2) return 10;
    if (candidate.dishCount >= 5) return -110;
  }

  return 0;
}

function isBreakfastFallbackCandidate(template: MenuTemplate): boolean {
  const joined = normalizeMenuText([
    template.title,
    ...template.dishes.map((dish) => String(dish.name ?? "")),
  ].join(" "));
  if (!joined) return false;
  const dinnerLikeKeywords = [
    "回鍋肉",
    "生姜焼",
    "照り焼",
    "ミートローフ",
    "ハンバーグ",
    "カレー",
    "キーマ",
    "炒",
    "揚",
    "唐揚",
    "麻婆",
    "青椒肉絲",
    "ポーク",
    "チキン",
  ].map((keyword) => normalizeMenuText(keyword));
  if (dinnerLikeKeywords.some((keyword) => joined.includes(keyword))) {
    return false;
  }
  const breakfastStaples = [
    "ご飯",
    "ごはん",
    "おにぎり",
    "パン",
    "トースト",
    "ヨーグルト",
    "グラノーラ",
    "シリアル",
    "納豆",
    "味噌汁",
    "みそ汁",
    "卵",
    "たまご",
    "鮭",
    "さけ",
    "サーモン",
    "さば",
    "サバ",
  ].map((keyword) => normalizeMenuText(keyword));
  return breakfastStaples.some((keyword) => joined.includes(keyword));
}

function needsSyntheticBreakfastPlan(plan: SlotPlan, template: MenuTemplate | undefined): boolean {
  if (plan.mealType !== "breakfast") return false;
  if (!template) return true;
  return template.mealType !== "breakfast" || template.breakfastTemplate === "other_breakfast";
}

export function normalizeSlotPlanForPrompt(plan: SlotPlan, template: MenuTemplate | undefined): SlotPlan {
  if (!needsSyntheticBreakfastPlan(plan, template)) {
    return plan;
  }

  const variant = getSyntheticBreakfastVariant(plan.date);
  return {
    ...plan,
    requiredBreakfastTemplate: variant.requiredBreakfastTemplate,
    requiredMainDishFamily: variant.requiredMainDishFamily,
    requiredProteinFamily: variant.requiredProteinFamily,
  };
}

export function normalizeSlotPlansForPrompt(
  slotPlans: Record<string, SlotPlan>,
  templatesById: Record<string, MenuTemplate>,
): Record<string, SlotPlan> {
  return Object.fromEntries(
    Object.entries(slotPlans).map(([slotKey, plan]) => [
      slotKey,
      normalizeSlotPlanForPrompt(plan, templatesById[plan.seedTemplateId]),
    ]),
  );
}

function countFamilyWithinWindow(fingerprints: MealDiversityFingerprint[], family: string, date: string, days: number): number {
  return fingerprints.filter((fingerprint) => fingerprint.mainDishFamily === family && getDayDistance(fingerprint.date, date) <= days).length;
}

function countProteinWithinWindow(fingerprints: MealDiversityFingerprint[], family: string, date: string, days: number): number {
  return fingerprints.filter((fingerprint) => fingerprint.proteinFamily === family && getDayDistance(fingerprint.date, date) <= days).length;
}

function selectBestTemplate(params: {
  slot: TargetSlotLike;
  candidates: MenuTemplate[];
  priorFingerprints: MealDiversityFingerprint[];
  usedTemplateIds: Set<string>;
  usedClusterIds: Set<string>;
  sodiumMode: SodiumMode;
  sameDaySelectedFamilies: Set<string>;
}): MenuTemplate | null {
  let best: MenuTemplate | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of params.candidates) {
    if (params.usedTemplateIds.has(candidate.id)) {
      continue;
    }

    const adjacentFamilyDuplicate = params.priorFingerprints.some((fingerprint) =>
      fingerprint.mainDishFamily === candidate.mainDishFamily && getDayDistance(fingerprint.date, params.slot.date) <= 1,
    );
    const adjacentBreakfastDuplicate = params.slot.mealType === "breakfast"
      && candidate.breakfastTemplate !== "other_breakfast"
      && params.priorFingerprints.some((fingerprint) =>
        fingerprint.mealType === "breakfast"
        && fingerprint.breakfastTemplate === candidate.breakfastTemplate
        && getDayDistance(fingerprint.date, params.slot.date) <= 1,
      );
    const sameDayFamilyDuplicate = (params.slot.mealType === "lunch" || params.slot.mealType === "dinner")
      && params.sameDaySelectedFamilies.has(candidate.mainDishFamily);

    if (adjacentFamilyDuplicate || adjacentBreakfastDuplicate || sameDayFamilyDuplicate) {
      continue;
    }

    let score = 1000;
    score -= countFamilyWithinWindow(params.priorFingerprints, candidate.mainDishFamily, params.slot.date, 6) * 120;
    score -= countProteinWithinWindow(params.priorFingerprints, candidate.proteinFamily, params.slot.date, 6) * 80;
    score -= params.usedClusterIds.has(candidate.clusterId) ? 240 : 0;
    score -= params.sameDaySelectedFamilies.has(candidate.mainDishFamily) ? 700 : 0;
    score -= params.slot.mealType === "breakfast" && candidate.breakfastTemplate === "other_breakfast" ? 40 : 0;
    score -= getTemplateSodiumPenalty(params.slot, candidate, params.sodiumMode);
    score -= getTemplateCaloriePenalty(params.slot, candidate);
    score -= getHeavyFamilyPenalty(params.slot, candidate);
    score -= candidate.mainDishFamily === "other_main" ? (params.slot.mealType === "breakfast" ? 220 : 120) : 0;
    score -= params.slot.mealType === "breakfast" && isHeavyBreakfastFamily(candidate.mainDishFamily) ? 420 : 0;
    score += params.slot.mealType === "breakfast" && candidate.breakfastTemplate !== "other_breakfast" ? 240 : 0;
    score += params.slot.mealType === "breakfast" && candidate.mealType === "breakfast" ? 80 : 0;
    score += getDishCountAdjustment(params.slot, candidate);
    score += Math.min(candidate.themeTags.length, 4) * 4;

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (best) return best;
  return params.candidates.find((candidate) => !params.usedTemplateIds.has(candidate.id)) ?? null;
}

export function planDiversityForRange(params: {
  targetSlots: TargetSlotLike[];
  templates: MenuTemplate[];
  existingFingerprints?: MealDiversityFingerprint[];
  sodiumMode?: SodiumMode;
}): SlotPlanResult {
  const orderedSlots = sortTargetSlots(params.targetSlots);
  const buckets = buildBuckets(params.templates);
  const existingFingerprints = [...(params.existingFingerprints ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const usedTemplateIds = new Set<string>();
  const usedClusterIds = new Set<string>();
  const slotPlans: Record<string, SlotPlan> = {};
  const orderedPlans: SlotPlan[] = [];
  const clusters = clusterMenuTemplates(params.templates);

  let currentDate = "";
  let sameDaySelectedFamilies = new Set<string>();

  for (const slot of orderedSlots) {
    if (slot.date !== currentDate) {
      currentDate = slot.date;
      sameDaySelectedFamilies = new Set<string>();
    }

    const candidates = (buckets[slot.mealType] ?? []).length > 0 ? buckets[slot.mealType] : buckets.any;
    const selected = selectBestTemplate({
      slot,
      candidates,
      priorFingerprints: existingFingerprints,
      usedTemplateIds,
      usedClusterIds,
      sodiumMode: params.sodiumMode ?? "normal",
      sameDaySelectedFamilies,
    });
    if (!selected) continue;

    const priorForbiddenDishNames = existingFingerprints
      .filter((fingerprint) => getDayDistance(fingerprint.date, slot.date) <= 14)
      .flatMap((fingerprint) => fingerprint.dishNames);

    const plan: SlotPlan = {
      date: slot.date,
      mealType: slot.mealType,
      seedTemplateId: selected.id,
      seedClusterId: selected.clusterId,
      templateTitle: selected.title,
      requiredMainDishFamily: selected.mainDishFamily,
      requiredProteinFamily: selected.proteinFamily,
      requiredBreakfastTemplate: selected.breakfastTemplate,
      sodiumMode: params.sodiumMode ?? "normal",
      forbiddenTemplateIds: [...usedTemplateIds],
      forbiddenClusterIds: [...usedClusterIds],
      forbiddenDishNames: [...new Set(priorForbiddenDishNames)],
      themeTags: selected.themeTags,
    };
    slotPlans[getSlotKey(slot.date, slot.mealType)] = plan;
    orderedPlans.push(plan);

    usedTemplateIds.add(selected.id);
    usedClusterIds.add(selected.clusterId);
    sameDaySelectedFamilies.add(selected.mainDishFamily);
    existingFingerprints.push({
      date: slot.date,
      mealType: slot.mealType,
      mainDishName: selected.mainDishName,
      mainDishFamily: selected.mainDishFamily,
      proteinFamily: selected.proteinFamily,
      breakfastTemplate: selected.breakfastTemplate,
      soupKind: selected.soupKind,
      dishNames: selected.dishes.map((dish) => String(dish.name ?? "")).filter(Boolean),
      signature: selected.signature,
      templateId: selected.id,
      clusterId: selected.clusterId,
      sodiumMode: params.sodiumMode ?? "normal",
    });
  }

  return { slotPlans, orderedPlans, clusters };
}
