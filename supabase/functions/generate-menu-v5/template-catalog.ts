import {
  classifyMainDishFamily,
  classifyProteinFamily,
  inferBreakfastTemplate,
  inferSoupKind,
  type BreakfastTemplate,
  type MainDishFamily,
  type ProteinFamily,
  type SoupKind,
} from "./diversity-taxonomy.ts";

// Pure utilities for converting dataset_menu_sets rows into MenuTemplate objects.
export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "midnight_snack" | "any";

export interface DatasetMenuSetRaw {
  id: string;
  external_id: string;
  source_url?: string;
  title: string;
  theme_raw?: string;
  theme_tags?: string[];
  meal_type_hint?: string;
  dish_count?: number;
  dishes?: Array<{ name: string; role?: string }>;
  calories_kcal?: number | null;
  sodium_g?: number | null;
  protein_g?: number | null;
  fat_g?: number | null;
  carbs_g?: number | null;
  sugar_g?: number | null;
  fiber_g?: number | null;
  potassium_mg?: number | null;
  calcium_mg?: number | null;
  magnesium_mg?: number | null;
  phosphorus_mg?: number | null;
  iron_mg?: number | null;
  zinc_mg?: number | null;
  iodine_ug?: number | null;
  vitamin_b1_mg?: number | null;
  vitamin_b2_mg?: number | null;
  vitamin_b6_mg?: number | null;
  vitamin_b12_ug?: number | null;
  vitamin_c_mg?: number | null;
  vitamin_a_ug?: number | null;
  vitamin_d_ug?: number | null;
  vitamin_k_ug?: number | null;
  vitamin_e_mg?: number | null;
  saturated_fat_g?: number | null;
  monounsaturated_fat_g?: number | null;
  polyunsaturated_fat_g?: number | null;
  content_embedding?: number[];
}

export interface MenuTemplate {
  id: string;
  title: string;
  mealType: MealType;
  themeTags: string[];
  dishCount: number;
  dishes: Array<{ name: string; role?: string }>;
  mainDishName: string;
  mainDishFamily: MainDishFamily;
  proteinFamily: ProteinFamily;
  breakfastTemplate: BreakfastTemplate;
  soupKind: SoupKind;
  clusterId: string;
  signature: string;
  nutrients: Record<string, number | null>;
  source: { externalId: string; sourceUrl?: string; rawTheme?: string };
  embedding?: number[];
}

function getNumericNutrient(value: number | null | undefined): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

const VALID_MEAL_TYPES: Record<string, MealType> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  snack: 'snack',
  midnight_snack: 'midnight_snack',
};

export type MenuTemplateCluster = {
  clusterId: string;
  mainDishFamily: MainDishFamily;
  proteinFamily: ProteinFamily;
  breakfastTemplate: BreakfastTemplate;
  templateIds: string[];
};

export function normalizeMealTypeHint(value?: string): MealType {
  if (!value) return 'any';
  const normalized = value.trim().toLowerCase();
  return VALID_MEAL_TYPES[normalized] ?? 'any';
}

export function buildNutrientMap(row: DatasetMenuSetRaw): Record<string, number | null> {
  return {
    calories_kcal: row.calories_kcal ?? null,
    sodium_g: row.sodium_g ?? null,
    protein_g: row.protein_g ?? null,
    fat_g: row.fat_g ?? null,
    carbs_g: row.carbs_g ?? null,
    sugar_g: row.sugar_g ?? null,
    fiber_g: row.fiber_g ?? null,
    potassium_mg: row.potassium_mg ?? null,
    calcium_mg: row.calcium_mg ?? null,
    magnesium_mg: row.magnesium_mg ?? null,
    phosphorus_mg: row.phosphorus_mg ?? null,
    iron_mg: row.iron_mg ?? null,
    zinc_mg: row.zinc_mg ?? null,
    iodine_ug: row.iodine_ug ?? null,
    vitamin_b1_mg: row.vitamin_b1_mg ?? null,
    vitamin_b2_mg: row.vitamin_b2_mg ?? null,
    vitamin_b6_mg: row.vitamin_b6_mg ?? null,
    vitamin_b12_ug: row.vitamin_b12_ug ?? null,
    vitamin_c_mg: row.vitamin_c_mg ?? null,
    vitamin_a_ug: row.vitamin_a_ug ?? null,
    vitamin_d_ug: row.vitamin_d_ug ?? null,
    vitamin_k_ug: row.vitamin_k_ug ?? null,
    vitamin_e_mg: row.vitamin_e_mg ?? null,
    saturated_fat_g: row.saturated_fat_g ?? null,
    monounsaturated_fat_g: row.monounsaturated_fat_g ?? null,
    polyunsaturated_fat_g: row.polyunsaturated_fat_g ?? null,
  };
}

function inferMealTypeFromTitleAndDishes(row: DatasetMenuSetRaw): MealType {
  const hint = normalizeMealTypeHint(row.meal_type_hint);
  if (hint !== "any") return hint;
  const title = String(row.title ?? "");
  const dishNames = Array.isArray(row.dishes) ? row.dishes.map((dish) => String(dish?.name ?? "")) : [];
  const breakfastTemplate = inferBreakfastTemplate([title, ...dishNames]);
  if (breakfastTemplate !== "other_breakfast") return "breakfast";
  if (title.includes("おやつ") || title.includes("間食")) return "snack";
  return "any";
}

function getMainDishName(dishes: Array<{ name: string; role?: string }>): string {
  const mainDish = dishes.find((dish) => String(dish.role ?? "") === "main");
  if (mainDish?.name) return String(mainDish.name);
  const ranked = dishes
    .map((dish, index) => {
      const role = String(dish.role ?? "");
      const name = String(dish.name ?? "");
      let score = 0;
      if (role === "main") score += 1000;
      if (role === "rice") score += 220;
      if (role === "other") score += 140;
      if (role === "side") score += 60;
      if (role === "soup") score -= 120;
      if (name.includes("ご飯") || name.includes("ごはん") || name.includes("丼") || name.includes("チャーハン") || name.includes("カレー")) {
        score += 180;
      }
      if (name.includes("鮭") || name.includes("さば") || name.includes("鶏") || name.includes("豚") || name.includes("豆腐") || name.includes("卵")) {
        score += 90;
      }
      return { name, score, index };
    })
    .sort((lhs, rhs) => rhs.score - lhs.score || lhs.index - rhs.index);
  return ranked[0]?.name ?? "";
}

function buildTemplateSignature(dishes: Array<{ name: string; role?: string }>): string {
  const mainDishName = getMainDishName(dishes).trim().toLowerCase();
  const sideNames = dishes
    .filter((dish) => String(dish.role ?? "") === "side")
    .map((dish) => String(dish.name).trim().toLowerCase())
    .sort();
  const soupNames = dishes
    .filter((dish) => String(dish.role ?? "") === "soup")
    .map((dish) => String(dish.name).trim().toLowerCase())
    .sort();
  return [mainDishName, sideNames.join(","), soupNames.join(",")].join("|");
}

function getMealTypeCalorieSortScore(template: MenuTemplate): number {
  const calories = getNumericNutrient(template.nutrients.calories_kcal);
  if (calories == null) return 0;

  if (template.mealType === "breakfast") {
    if (calories >= 350 && calories <= 550) return 180;
    if (calories >= 300 && calories <= 620) return 90;
    if (calories < 250) return -220;
    if (calories > 700) return -200;
    return -60;
  }

  if (template.mealType === "lunch" || template.mealType === "dinner") {
    if (calories >= 520 && calories <= 820) return 160;
    if (calories >= 450 && calories <= 900) return 80;
    if (calories < 380) return -120;
    if (calories > 1000) return -220;
    return -50;
  }

  return 0;
}

function getDishCountSortScore(template: MenuTemplate): number {
  if (template.mealType === "breakfast") {
    if (template.dishCount >= 3 && template.dishCount <= 4) return 70;
    if (template.dishCount === 2) return 10;
    if (template.dishCount <= 1) return -160;
    return -60;
  }

  if (template.mealType === "lunch" || template.mealType === "dinner") {
    if (template.dishCount >= 3 && template.dishCount <= 4) return 80;
    if (template.dishCount === 2) return 20;
    if (template.dishCount >= 5) return -80;
    return -40;
  }

  return 0;
}

function getTemplateCatalogSortScore(template: MenuTemplate): number {
  const sodium = getNumericNutrient(template.nutrients.sodium_g);
  let score = 0;
  score += template.mainDishFamily === "other_main" ? -120 : 80;
  score += template.proteinFamily === "other" ? -40 : 30;
  score += template.mealType === "breakfast" && template.breakfastTemplate !== "other_breakfast" ? 90 : 0;
  score += getMealTypeCalorieSortScore(template);
  score += getDishCountSortScore(template);

  if (template.mealType === "breakfast" && sodium != null) {
    if (sodium > 2.6) score -= 140;
    else if (sodium > 1.9) score -= 60;
  }
  if ((template.mealType === "lunch" || template.mealType === "dinner") && sodium != null) {
    if (sodium > 4.5) score -= 120;
    else if (sodium > 3.5) score -= 50;
  }

  return score;
}

export function buildTemplateClusterKey(template: {
  mealType: MealType;
  mainDishFamily: MainDishFamily;
  proteinFamily: ProteinFamily;
  breakfastTemplate: BreakfastTemplate;
  soupKind: SoupKind;
}): string {
  return [
    template.mealType,
    template.mainDishFamily,
    template.proteinFamily,
    template.breakfastTemplate,
    template.soupKind,
  ].join("|");
}

export function mapDatasetMenuSetToTemplate(row: DatasetMenuSetRaw): MenuTemplate {
  const dishCount = row.dish_count ?? (Array.isArray(row.dishes) ? row.dishes.length : 0);
  const dishes = Array.isArray(row.dishes) ? row.dishes : [];
  const mainDishName = getMainDishName(dishes);
  const mainDishFamily = classifyMainDishFamily(mainDishName);
  const proteinFamily = classifyProteinFamily(mainDishName);
  const breakfastTemplate = inferBreakfastTemplate(dishes.map((dish) => String(dish.name ?? "")));
  const soupKind = inferSoupKind(dishes.map((dish) => String(dish.name ?? "")));
  return {
    id: row.id,
    title: row.title ?? '献立例',
    mealType: inferMealTypeFromTitleAndDishes(row),
    themeTags: (row.theme_tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    dishCount,
    dishes,
    mainDishName,
    mainDishFamily,
    proteinFamily,
    breakfastTemplate,
    soupKind,
    clusterId: "",
    signature: buildTemplateSignature(dishes),
    nutrients: buildNutrientMap(row),
    source: {
      externalId: row.external_id,
      sourceUrl: row.source_url,
      rawTheme: row.theme_raw,
    },
    embedding: row.content_embedding ? [...row.content_embedding] : undefined,
  };
}

export function buildTemplateCatalog(rows: DatasetMenuSetRaw[]): MenuTemplate[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(mapDatasetMenuSetToTemplate)
    .map((template) => ({
      ...template,
      clusterId: buildTemplateClusterKey(template),
    }))
    .sort((a, b) =>
      getTemplateCatalogSortScore(b) - getTemplateCatalogSortScore(a)
      || b.dishCount - a.dishCount
      || (a.title ?? '').localeCompare(b.title));
}

export function clusterMenuTemplates(templates: MenuTemplate[]): MenuTemplateCluster[] {
  const clusters = new Map<string, MenuTemplateCluster>();
  for (const template of templates) {
    const clusterId = template.clusterId || buildTemplateClusterKey(template);
    const existing = clusters.get(clusterId);
    if (existing) {
      existing.templateIds.push(template.id);
      continue;
    }
    clusters.set(clusterId, {
      clusterId,
      mainDishFamily: template.mainDishFamily,
      proteinFamily: template.proteinFamily,
      breakfastTemplate: template.breakfastTemplate,
      templateIds: [template.id],
    });
  }
  return [...clusters.values()].sort((a, b) => b.templateIds.length - a.templateIds.length || a.clusterId.localeCompare(b.clusterId));
}
