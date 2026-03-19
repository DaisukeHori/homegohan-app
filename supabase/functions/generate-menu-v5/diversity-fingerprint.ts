import type { GeneratedMeal, MealType } from "../_shared/meal-generator.ts";
import {
  classifyMainDishFamily,
  classifyProteinFamily,
  inferBreakfastTemplate,
  inferSoupKind,
  normalizeMenuText,
  type BreakfastTemplate,
  type MainDishFamily,
  type ProteinFamily,
  type SodiumMode,
  type SoupKind,
} from "./diversity-taxonomy.ts";
import type { MenuTemplate } from "./template-catalog.ts";

type MinimalDish = {
  name?: string | null;
  role?: string | null;
};

type MinimalExistingMenu = {
  date: string;
  mealType: MealType;
  dishName: string;
};

export type MealSignature = {
  normalizedDishName: string;
  mainDishName: string;
  sideDishNamesSorted: string[];
  soupDishNamesSorted: string[];
  signature: string;
};

export type MealDiversityFingerprint = {
  date: string;
  mealType: MealType;
  mainDishName: string;
  mainDishFamily: MainDishFamily;
  proteinFamily: ProteinFamily;
  breakfastTemplate: BreakfastTemplate;
  soupKind: SoupKind;
  dishNames: string[];
  signature: string;
  templateId?: string;
  clusterId?: string;
  sodiumMode?: SodiumMode;
};

function normalizeDishNames(dishes: MinimalDish[]): string[] {
  return dishes
    .map((dish) => String(dish?.name ?? "").trim())
    .filter(Boolean);
}

function scoreDishAsMain(dish: MinimalDish, index: number): number {
  const role = String(dish?.role ?? "").trim();
  const name = String(dish?.name ?? "").trim();
  const family = classifyMainDishFamily(name);
  const protein = classifyProteinFamily(name);

  let score = 0;
  if (role === "main") score += 1000;
  if (role === "side") score += 120;
  if (role === "other") score += 80;
  if (role === "rice") score -= 140;
  if (role === "soup") score -= 220;
  if (family !== "other_main") score += 220;
  if (family === "rice_bowl" || family === "noodle_soup") score += 160;
  if (protein !== "other") score += 110;
  if (name.includes("ご飯") || name.includes("ごはん") || name.includes("パン")) score -= 60;
  if (name.includes("汁") || name.includes("スープ")) score -= 140;
  return score - index;
}

function pickMainDishName(dishes: MinimalDish[]): string {
  const mainDish = dishes.find((dish) => String(dish?.role ?? "") === "main");
  if (mainDish?.name) return String(mainDish.name).trim();
  const ranked = dishes
    .map((dish, index) => ({ dish, index, score: scoreDishAsMain(dish, index) }))
    .sort((lhs, rhs) => rhs.score - lhs.score || lhs.index - rhs.index);
  const inferred = ranked[0]?.dish?.name;
  if (inferred) return String(inferred).trim();
  return normalizeDishNames(dishes)[0] ?? "";
}

export function buildMealSignatureFromDishes(dishes: MinimalDish[]): MealSignature {
  const mainDishName = pickMainDishName(dishes);
  const sideDishNamesSorted = dishes
    .filter((dish) => String(dish?.role ?? "") === "side")
    .map((dish) => String(dish?.name ?? "").trim())
    .filter(Boolean)
    .sort();
  const soupDishNamesSorted = dishes
    .filter((dish) => String(dish?.role ?? "") === "soup")
    .map((dish) => String(dish?.name ?? "").trim())
    .filter(Boolean)
    .sort();
  const normalizedDishName = normalizeMenuText(mainDishName);
  return {
    normalizedDishName,
    mainDishName,
    sideDishNamesSorted,
    soupDishNamesSorted,
    signature: [
      normalizedDishName,
      sideDishNamesSorted.map(normalizeMenuText).join(","),
      soupDishNamesSorted.map(normalizeMenuText).join(","),
    ].join("|"),
  };
}

export function fingerprintGeneratedMeal(params: {
  date: string;
  mealType: MealType;
  meal: GeneratedMeal;
  templateId?: string;
  clusterId?: string;
  sodiumMode?: SodiumMode;
}): MealDiversityFingerprint {
  const dishes = (params.meal?.dishes ?? []) as MinimalDish[];
  const dishNames = normalizeDishNames(dishes);
  const mainDishName = pickMainDishName(dishes);
  const signature = buildMealSignatureFromDishes(dishes);
  return {
    date: params.date,
    mealType: params.mealType,
    mainDishName,
    mainDishFamily: classifyMainDishFamily(mainDishName),
    proteinFamily: classifyProteinFamily(mainDishName),
    breakfastTemplate: params.mealType === "breakfast" ? inferBreakfastTemplate(dishNames) : "other_breakfast",
    soupKind: inferSoupKind(dishNames),
    dishNames,
    signature: signature.signature,
    templateId: params.templateId,
    clusterId: params.clusterId,
    sodiumMode: params.sodiumMode,
  };
}

export function fingerprintTemplate(params: {
  date: string;
  mealType: MealType;
  template: MenuTemplate;
  sodiumMode?: SodiumMode;
}): MealDiversityFingerprint {
  const dishNames = normalizeDishNames(params.template.dishes);
  const signature = buildMealSignatureFromDishes(params.template.dishes);
  return {
    date: params.date,
    mealType: params.mealType,
    mainDishName: params.template.mainDishName,
    mainDishFamily: params.template.mainDishFamily,
    proteinFamily: params.template.proteinFamily,
    breakfastTemplate: params.template.breakfastTemplate,
    soupKind: params.template.soupKind,
    dishNames,
    signature: signature.signature,
    templateId: params.template.id,
    clusterId: params.template.clusterId,
    sodiumMode: params.sodiumMode,
  };
}

export function fingerprintExistingMenu(menu: MinimalExistingMenu): MealDiversityFingerprint {
  const normalizedName = String(menu.dishName ?? "").trim();
  return {
    date: menu.date,
    mealType: menu.mealType,
    mainDishName: normalizedName,
    mainDishFamily: classifyMainDishFamily(normalizedName),
    proteinFamily: classifyProteinFamily(normalizedName),
    breakfastTemplate: menu.mealType === "breakfast" ? inferBreakfastTemplate([normalizedName]) : "other_breakfast",
    soupKind: inferSoupKind([normalizedName]),
    dishNames: normalizedName ? [normalizedName] : [],
    signature: normalizeMenuText(normalizedName),
  };
}
