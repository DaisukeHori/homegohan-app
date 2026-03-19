import type { GeneratedMeal, MealType } from "../_shared/meal-generator.ts";
import type { SlotPlan } from "./diversity-scheduler.ts";
import type { MealDiversityFingerprint } from "./diversity-fingerprint.ts";
import { fingerprintGeneratedMeal } from "./diversity-fingerprint.ts";

type TargetSlotLike = {
  date: string;
  mealType: MealType;
};

export type ViolationCode =
  | "exact_duplicate_signature"
  | "exact_duplicate_dish_name"
  | "duplicate_bread_staples"
  | "breakfast_structure_too_light"
  | "heavy_main_overbuilt"
  | "stacked_salty_items"
  | "same_day_main_family_duplicate"
  | "adjacent_main_family_duplicate"
  | "adjacent_breakfast_template_duplicate"
  | "seed_template_reused"
  | "cluster_reuse_nearby"
  | "weekly_family_overuse"
  | "weekly_breakfast_template_overuse"
  | "brief_mismatch";

export type ViolationSeverity = "hard" | "soft";

export type DiversityViolation = {
  code: ViolationCode;
  severity: ViolationSeverity;
  date: string;
  mealType: MealType;
  slotKey: string;
  message: string;
  relatedSlotKeys: string[];
};

export function getSlotKey(date: string, mealType: MealType): string {
  return `${date}:${mealType}`;
}

function sortSlots(slots: TargetSlotLike[]): TargetSlotLike[] {
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

function hasHardViolation(existing: DiversityViolation[], code: ViolationCode, slotKey: string): boolean {
  return existing.some((violation) => violation.code === code && violation.slotKey === slotKey);
}

function getDayDistance(a: string, b: string): number {
  const lhs = new Date(`${a}T00:00:00.000Z`).getTime();
  const rhs = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.abs(Math.round((lhs - rhs) / (1000 * 60 * 60 * 24)));
}

function countBreadLikeDishes(names: string[]): number {
  return names.filter((name) => {
    const text = String(name ?? "");
    return text.includes("パン")
      || text.includes("トースト")
      || text.includes("サンド")
      || text.includes("ホットドッグ")
      || text.includes("バーガー");
  }).length;
}

function countStapleLikeDishes(dishes: Array<{ name?: string; role?: string }>): number {
  return dishes.filter((dish) => {
    const name = String(dish?.name ?? "");
    const role = String(dish?.role ?? "");
    return role === "rice"
      || name.includes("ご飯")
      || name.includes("ごはん")
      || name.includes("丼")
      || name.includes("カレー")
      || name.includes("チャーハン")
      || name.includes("パン")
      || name.includes("トースト")
      || name.includes("サンド")
      || name.includes("うどん")
      || name.includes("そば")
      || name.includes("パスタ")
      || name.includes("スパゲッティ")
      || name.includes("麺");
  }).length;
}

function countSoupLikeDishes(dishes: Array<{ name?: string; role?: string }>): number {
  return dishes.filter((dish) => {
    const name = String(dish?.name ?? "");
    const role = String(dish?.role ?? "");
    return role === "soup"
      || name.includes("汁")
      || name.includes("スープ")
      || name.includes("みそ")
      || name.includes("味噌");
  }).length;
}

function countSupportDishes(dishes: Array<{ name?: string; role?: string }>): number {
  return dishes.filter((dish) => {
    const role = String(dish?.role ?? "");
    return role === "side" || role === "soup" || role === "other";
  }).length;
}

function sumIngredientAmountByKeywords(
  dishes: Array<{ ingredients?: Array<{ name?: string; amount_g?: number | null }> }>,
  keywords: string[],
): number {
  return dishes.reduce((sum, dish) =>
    sum + (dish.ingredients ?? []).reduce((dishSum, ingredient) => {
      const name = String(ingredient?.name ?? "");
      const amount = Number(ingredient?.amount_g);
      if (!Number.isFinite(amount)) return dishSum;
      return keywords.some((keyword) => name.includes(keyword)) ? dishSum + amount : dishSum;
    }, 0), 0);
}

function sumDishIngredientAmount(dishes: Array<{ ingredients?: Array<{ amount_g?: number | null }> }>, role?: string): number {
  return dishes.reduce((sum, dish: any) => {
    if (role && String(dish?.role ?? "") !== role) return sum;
    return sum + (dish.ingredients ?? []).reduce((dishSum: number, ingredient: any) => {
      const amount = Number(ingredient?.amount_g);
      return Number.isFinite(amount) ? dishSum + amount : dishSum;
    }, 0);
  }, 0);
}

function countSaltyTaggedDishes(dishes: Array<{ name?: string; role?: string }>): number {
  return dishes.filter((dish) => {
    const name = String(dish?.name ?? "");
    return name.includes("味噌")
      || name.includes("みそ")
      || name.includes("照り焼")
      || name.includes("煮付")
      || name.includes("生姜煮")
      || name.includes("回鍋肉")
      || name.includes("ポン酢")
      || name.includes("塩焼")
      || name.includes("キムチ")
      || name.includes("漬");
  }).length;
}

function isHeavyMainFamily(family: MealDiversityFingerprint["mainDishFamily"]): boolean {
  return family === "curry_main"
    || family === "gratin_main"
    || family === "rice_bowl"
    || family === "noodle_soup";
}

function isBreakfastTooLight(meal: GeneratedMeal, fingerprint: MealDiversityFingerprint): boolean {
  const dishes = meal.dishes ?? [];
  const totalDishWeight = sumDishIngredientAmount(dishes);
  const riceGrams = sumIngredientAmountByKeywords(dishes, ["ご飯", "ごはん", "米"]);
  const breadGrams = sumIngredientAmountByKeywords(dishes, ["食パン", "パン", "トースト", "ロールパン", "バゲット", "マフィン"]);
  const eggGrams = sumIngredientAmountByKeywords(dishes, ["卵", "玉子", "たまご", "エッグ"]);
  const yogurtGrams = sumIngredientAmountByKeywords(dishes, ["ヨーグルト"]);
  const fruitVegSupportGrams = sumIngredientAmountByKeywords(dishes, [
    "バナナ",
    "りんご",
    "いちご",
    "キウイ",
    "みかん",
    "オレンジ",
    "トマト",
    "レタス",
    "ほうれん草",
    "サラダ",
  ]);
  const soupWeight = sumDishIngredientAmount(dishes, "soup");
  const supportCount = countSupportDishes(dishes);

  if (fingerprint.breakfastTemplate === "bread_egg") {
    return breadGrams < 60 || eggGrams < 80 || (yogurtGrams + fruitVegSupportGrams + soupWeight) < 70;
  }
  if (fingerprint.breakfastTemplate === "bread_yogurt") {
    return breadGrams < 60 || yogurtGrams < 100 || fruitVegSupportGrams < 50;
  }
  if (fingerprint.breakfastTemplate === "rice_miso_egg" || fingerprint.breakfastTemplate === "rice_miso_grilled_fish" || fingerprint.breakfastTemplate === "rice_soup_tofu") {
    const proteinWeight = Math.max(eggGrams, yogurtGrams, sumDishIngredientAmount(dishes, "main"));
    return riceGrams < 100 || soupWeight < 100 || proteinWeight < 60;
  }

  return fingerprint.proteinFamily === "other"
    || totalDishWeight < 220
    || ((meal.dishes?.length ?? 0) <= 2 && countSoupLikeDishes(dishes) === 0)
    || supportCount < 1;
}

export function validateGeneratedMeals(params: {
  targetSlots: TargetSlotLike[];
  generatedMeals: Record<string, GeneratedMeal>;
  slotPlans?: Record<string, SlotPlan>;
  existingFingerprints?: MealDiversityFingerprint[];
}): {
  fingerprints: Record<string, MealDiversityFingerprint>;
  violations: DiversityViolation[];
} {
  const orderedSlots = sortSlots(params.targetSlots);
  const fingerprints: Record<string, MealDiversityFingerprint> = {};
  const violations: DiversityViolation[] = [];
  const existingFingerprints = params.existingFingerprints ?? [];
  const bySignature = new Map<string, string>();
  const byDishName = new Map<string, string>();
  const mainFamilyWindow = new Map<string, string[]>();
  const breakfastTemplateWindow = new Map<string, string[]>();

  for (const existing of existingFingerprints) {
    if (existing.signature) bySignature.set(existing.signature, getSlotKey(existing.date, existing.mealType));
    if (existing.mainDishName) byDishName.set(existing.mainDishName.trim(), getSlotKey(existing.date, existing.mealType));
  }

  for (const slot of orderedSlots) {
    const slotKey = getSlotKey(slot.date, slot.mealType);
    const meal = params.generatedMeals[slotKey];
    if (!meal) continue;
    const plan = params.slotPlans?.[slotKey];
    const fingerprint = fingerprintGeneratedMeal({
      date: slot.date,
      mealType: slot.mealType,
      meal,
      templateId: plan?.seedTemplateId,
      clusterId: plan?.seedClusterId,
      sodiumMode: plan?.sodiumMode,
    });
    fingerprints[slotKey] = fingerprint;

    const priorSignatureSlot = bySignature.get(fingerprint.signature);
    if (fingerprint.signature && priorSignatureSlot) {
      violations.push({
        code: "exact_duplicate_signature",
        severity: "hard",
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "献立構成が既存または同リクエストの他スロットと完全一致しています。",
        relatedSlotKeys: [priorSignatureSlot],
      });
    } else if (fingerprint.signature) {
      bySignature.set(fingerprint.signature, slotKey);
    }

    const priorDishNameSlot = byDishName.get(fingerprint.mainDishName);
    if (fingerprint.mainDishName && priorDishNameSlot) {
      violations.push({
        code: "exact_duplicate_dish_name",
        severity: "hard",
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "主菜名が既存または同リクエストの他スロットと完全一致しています。",
        relatedSlotKeys: [priorDishNameSlot],
      });
    } else if (fingerprint.mainDishName) {
      byDishName.set(fingerprint.mainDishName, slotKey);
    }

    if (slot.mealType === "breakfast" && countBreadLikeDishes(fingerprint.dishNames) >= 2) {
      violations.push({
        code: "duplicate_bread_staples",
        severity: "hard",
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "朝食でパン系主食が重複しています。",
        relatedSlotKeys: [],
      });
    }

    if (slot.mealType === "breakfast") {
      if (isBreakfastTooLight(meal, fingerprint)) {
        violations.push({
          code: "breakfast_structure_too_light",
          severity: "hard",
          date: slot.date,
          mealType: slot.mealType,
          slotKey,
          message: "朝食が軽すぎる構成で、主食・主たんぱく・補助1品の形になっていません。",
          relatedSlotKeys: [],
        });
      }
    }

    if ((slot.mealType === "lunch" || slot.mealType === "dinner") && isHeavyMainFamily(fingerprint.mainDishFamily)) {
      const stapleCount = countStapleLikeDishes(meal.dishes ?? []);
      const tooHeavyStructure = stapleCount >= 2 || (meal.dishes?.length ?? 0) >= 4;
      if (tooHeavyStructure) {
        violations.push({
          code: "heavy_main_overbuilt",
          severity: "hard",
          date: slot.date,
          mealType: slot.mealType,
          slotKey,
          message: "主食一体型または重い主菜なのに、追加主食や品数過多で重すぎる構成です。",
          relatedSlotKeys: [],
        });
      }
    }

    if (countSaltyTaggedDishes(meal.dishes ?? []) >= 2) {
      violations.push({
        code: "stacked_salty_items",
        severity: "hard",
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "味噌・照り焼き・煮付け・ポン酢など濃い味の要素が同一 meal 内で重なっています。",
        relatedSlotKeys: [],
      });
    }

    const familySlots = mainFamilyWindow.get(fingerprint.mainDishFamily) ?? [];
    const nearbyFamilySlot = familySlots.find((otherSlotKey) => {
      const [otherDate] = otherSlotKey.split(":");
      return otherDate !== slot.date && getDayDistance(slot.date, otherDate) <= 1;
    });
    if (nearbyFamilySlot) {
      const severity = slot.mealType === "breakfast" ? "soft" : "hard";
      const code = slot.mealType === "breakfast" ? "weekly_family_overuse" : "adjacent_main_family_duplicate";
      violations.push({
        code,
        severity,
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "主菜 family が近接日で重複しています。",
        relatedSlotKeys: [nearbyFamilySlot],
      });
    }
    familySlots.push(slotKey);
    mainFamilyWindow.set(fingerprint.mainDishFamily, familySlots);

    if (slot.mealType === "breakfast" && fingerprint.breakfastTemplate !== "other_breakfast") {
      const breakfastSlots = breakfastTemplateWindow.get(fingerprint.breakfastTemplate) ?? [];
      const nearbyBreakfast = breakfastSlots.find((otherSlotKey) => {
        const [otherDate] = otherSlotKey.split(":");
        return getDayDistance(slot.date, otherDate) <= 1;
      });
      if (nearbyBreakfast) {
        violations.push({
          code: "adjacent_breakfast_template_duplicate",
          severity: "hard",
          date: slot.date,
          mealType: slot.mealType,
          slotKey,
          message: "朝食テンプレートが連日で重複しています。",
          relatedSlotKeys: [nearbyBreakfast],
        });
      }
      breakfastSlots.push(slotKey);
      breakfastTemplateWindow.set(fingerprint.breakfastTemplate, breakfastSlots);
    }

    const sameDaySibling = orderedSlots.find((other) => {
      if (other.date !== slot.date) return false;
      if (other.mealType === slot.mealType) return false;
      const otherKey = getSlotKey(other.date, other.mealType);
      const otherFingerprint = fingerprints[otherKey];
      return otherFingerprint?.mainDishFamily === fingerprint.mainDishFamily
        && ((slot.mealType === "lunch" && other.mealType === "dinner") || (slot.mealType === "dinner" && other.mealType === "lunch"));
    });
    if (sameDaySibling && !hasHardViolation(violations, "same_day_main_family_duplicate", slotKey)) {
      violations.push({
        code: "same_day_main_family_duplicate",
        severity: "hard",
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "同日の昼食と夕食で主菜 family が重複しています。",
        relatedSlotKeys: [getSlotKey(sameDaySibling.date, sameDaySibling.mealType)],
      });
    }

    if (plan?.requiredMainDishFamily && plan.requiredMainDishFamily !== fingerprint.mainDishFamily) {
      const briefMismatchSeverity: ViolationSeverity = slot.mealType === "breakfast"
        ? (plan.requiredProteinFamily
          && plan.requiredProteinFamily === fingerprint.proteinFamily
          && fingerprint.mainDishFamily !== "other_main"
          ? "soft"
          : "hard")
        : (fingerprint.mainDishFamily === "other_main" || fingerprint.proteinFamily === "other" ? "hard" : "soft");
      violations.push({
        code: "brief_mismatch",
        severity: briefMismatchSeverity,
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "planner が指定した主菜 family と実生成結果が一致していません。",
        relatedSlotKeys: [],
      });
    }

    if (plan?.seedTemplateId) {
      const reusedTemplate = orderedSlots.find((other) => {
        if (other.date === slot.date && other.mealType === slot.mealType) return false;
        const otherPlan = params.slotPlans?.[getSlotKey(other.date, other.mealType)];
        return otherPlan?.seedTemplateId === plan.seedTemplateId;
      });
      if (reusedTemplate) {
        violations.push({
          code: "seed_template_reused",
          severity: "hard",
          date: slot.date,
          mealType: slot.mealType,
          slotKey,
          message: "同じ sample template が同一リクエスト内で再利用されています。",
          relatedSlotKeys: [getSlotKey(reusedTemplate.date, reusedTemplate.mealType)],
        });
      }
    }

    if (plan?.seedClusterId) {
      const nearbyCluster = orderedSlots.find((other) => {
        if (other.date === slot.date && other.mealType === slot.mealType) return false;
        const otherKey = getSlotKey(other.date, other.mealType);
        const otherPlan = params.slotPlans?.[otherKey];
        return otherPlan?.seedClusterId === plan.seedClusterId && getDayDistance(slot.date, other.date) <= 2;
      });
      if (nearbyCluster) {
        violations.push({
          code: "cluster_reuse_nearby",
          severity: "soft",
          date: slot.date,
          mealType: slot.mealType,
          slotKey,
          message: "近い sample cluster が近接日で再利用されています。",
          relatedSlotKeys: [getSlotKey(nearbyCluster.date, nearbyCluster.mealType)],
        });
      }
    }

    const sameFamilyWindow = familySlots.filter((otherSlotKey) => {
      const [otherDate] = otherSlotKey.split(":");
      return getDayDistance(slot.date, otherDate) <= 6;
    });
    if (sameFamilyWindow.length >= 3) {
      violations.push({
        code: "weekly_family_overuse",
        severity: "soft",
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "7日窓で同じ主菜 family が過多です。",
        relatedSlotKeys: sameFamilyWindow.filter((other) => other !== slotKey),
      });
    }

    const sameBreakfastWindow = slot.mealType === "breakfast"
      ? (breakfastTemplateWindow.get(fingerprint.breakfastTemplate) ?? []).filter((otherSlotKey) => {
          const [otherDate] = otherSlotKey.split(":");
          return getDayDistance(slot.date, otherDate) <= 6;
        })
      : [];
    if (slot.mealType === "breakfast" && sameBreakfastWindow.length >= 3) {
      violations.push({
        code: "weekly_breakfast_template_overuse",
        severity: "soft",
        date: slot.date,
        mealType: slot.mealType,
        slotKey,
        message: "7日窓で同じ朝食テンプレートが過多です。",
        relatedSlotKeys: sameBreakfastWindow.filter((other) => other !== slotKey),
      });
    }
  }

  return { fingerprints, violations };
}
