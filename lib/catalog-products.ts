import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogDishMatch, CatalogProductSummary } from "../types/catalog";

const SEARCH_FETCH_LIMIT = 40;

type CatalogProductRow = {
  id: string;
  source_id: string;
  name: string;
  brand_name: string;
  category_code: string | null;
  description: string | null;
  main_image_url: string | null;
  canonical_url: string;
  price_yen: number | null;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  sodium_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  availability_status: string;
  updated_at?: string | null;
  catalog_sources?: {
    code: string;
    brand_name: string;
  } | {
    code: string;
    brand_name: string;
  }[] | null;
};

type PlannedMealCatalogOptions = {
  mode?: string;
  imageUrl?: string | null;
  description?: string | null;
};

type CatalogSelectionUpdateOptions = {
  supabase: SupabaseClient;
  catalogProductId: string;
  existingMetadata?: Record<string, any> | null;
  mode?: string;
  imageUrl?: string | null;
  description?: string | null;
  selectedFrom: "manual_search" | "photo_match";
};

const normalizeText = (value: string): string => (
  value
    .toLowerCase()
    .replace(/[\\s　]+/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[・･]/g, "")
    .trim()
);

const unique = <T,>(items: T[]): T[] => Array.from(new Set(items));

const tokenize = (query: string): string[] => {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const spaceTokens = trimmed
    .split(/[\s　]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return unique([trimmed, ...spaceTokens]).slice(0, 4);
};

const toNumberOrNull = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toCatalogProductSummary = (row: CatalogProductRow): CatalogProductSummary => {
  const source = Array.isArray(row.catalog_sources) ? row.catalog_sources[0] : row.catalog_sources;

  return {
    id: row.id,
    sourceId: row.source_id,
    sourceCode: source?.code ?? "",
    brandName: row.brand_name || source?.brand_name || "",
    name: row.name,
    categoryCode: row.category_code,
    description: row.description,
    imageUrl: row.main_image_url,
    canonicalUrl: row.canonical_url,
    priceYen: toNumberOrNull(row.price_yen),
    caloriesKcal: toNumberOrNull(row.calories_kcal),
    proteinG: toNumberOrNull(row.protein_g),
    fatG: toNumberOrNull(row.fat_g),
    carbsG: toNumberOrNull(row.carbs_g),
    sodiumG: toNumberOrNull(row.sodium_g),
    fiberG: toNumberOrNull(row.fiber_g),
    sugarG: toNumberOrNull(row.sugar_g),
    availabilityStatus: row.availability_status,
  };
};

const scoreCatalogProduct = (product: CatalogProductSummary, query: string): number => {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;

  const normalizedName = normalizeText(product.name);
  const normalizedBrand = normalizeText(product.brandName);
  const normalizedCategory = normalizeText(product.categoryCode ?? "");

  let score = 0;

  if (normalizedName === normalizedQuery) score += 120;
  if (normalizedName.startsWith(normalizedQuery)) score += 60;
  if (normalizedName.includes(normalizedQuery)) score += 40;
  if (normalizedBrand && normalizedBrand.includes(normalizedQuery)) score += 18;
  if (normalizedCategory && normalizedCategory.includes(normalizedQuery)) score += 12;

  const queryTokens = tokenize(query).map(normalizeText).filter(Boolean);
  for (const token of queryTokens) {
    if (token.length < 2) continue;
    if (normalizedName.includes(token)) score += 10;
    if (normalizedBrand.includes(token)) score += 4;
  }

  if (product.availabilityStatus === "active") score += 2;
  if (product.imageUrl) score += 1;

  return score;
};

const buildSearchClauses = (query: string): string[] => {
  const terms = tokenize(query).slice(0, 3);
  const escapedTerms = unique(
    terms
      .map((term) => term.replace(/[%*,'";\\]/g, "").trim())
      .filter((term) => term.length >= 2),
  );

  const clauses: string[] = [];
  for (const term of escapedTerms) {
    clauses.push(`name.ilike.%${term}%`);
    clauses.push(`brand_name.ilike.%${term}%`);
  }

  return unique(clauses);
};

export async function searchCatalogProducts(
  supabase: SupabaseClient,
  query: string,
  options?: { limit?: number },
): Promise<CatalogProductSummary[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length < 2) return [];

  let request = supabase
    .from("catalog_products")
    .select(`
      id,
      source_id,
      name,
      brand_name,
      category_code,
      description,
      main_image_url,
      canonical_url,
      price_yen,
      calories_kcal,
      protein_g,
      fat_g,
      carbs_g,
      sodium_g,
      fiber_g,
      sugar_g,
      availability_status,
      updated_at,
      catalog_sources!inner(
        code,
        brand_name
      )
    `)
    .neq("availability_status", "discontinued")
    .order("updated_at", { ascending: false })
    .limit(SEARCH_FETCH_LIMIT);

  const clauses = buildSearchClauses(trimmedQuery);
  if (clauses.length > 0) {
    request = request.or(clauses.join(","));
  }

  const { data, error } = await request;
  if (error) {
    throw new Error(`Failed to search catalog products: ${error.message}`);
  }

  const candidates = ((data ?? []) as unknown as CatalogProductRow[])
    .map(toCatalogProductSummary)
    .map((product) => ({ ...product, matchScore: scoreCatalogProduct(product, trimmedQuery) }))
    .filter((product) => (product.matchScore ?? 0) > 0)
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

  return candidates.slice(0, options?.limit ?? 12);
}

export async function getCatalogProductById(
  supabase: SupabaseClient,
  productId: string,
): Promise<CatalogProductSummary | null> {
  const { data, error } = await supabase
    .from("catalog_products")
    .select(`
      id,
      source_id,
      name,
      brand_name,
      category_code,
      description,
      main_image_url,
      canonical_url,
      price_yen,
      calories_kcal,
      protein_g,
      fat_g,
      carbs_g,
      sodium_g,
      fiber_g,
      sugar_g,
      availability_status,
      catalog_sources!inner(
        code,
        brand_name
      )
    `)
    .eq("id", productId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load catalog product: ${error.message}`);
  }

  if (!data) return null;
  return toCatalogProductSummary(data as unknown as CatalogProductRow);
}

export async function buildCatalogSelectionUpdate({
  supabase,
  catalogProductId,
  existingMetadata,
  mode,
  imageUrl,
  description,
  selectedFrom,
}: CatalogSelectionUpdateOptions): Promise<{
  product: CatalogProductSummary;
  fields: Record<string, any>;
}> {
  const product = await getCatalogProductById(supabase, catalogProductId);
  if (!product) {
    throw new Error("Catalog product not found");
  }

  return {
    product,
    fields: {
      ...buildCatalogMealFields(product, {
        mode,
        imageUrl,
        description,
      }),
      generation_metadata: mergeCatalogSelectionMetadata(existingMetadata, product, selectedFrom),
    },
  };
}

export function buildCatalogMealFields(
  product: CatalogProductSummary,
  options?: PlannedMealCatalogOptions,
) {
  return {
    catalog_product_id: product.id,
    source_type: "catalog_product",
    dish_name: product.name,
    mode: options?.mode ?? "buy",
    description: options?.description ?? product.description ?? null,
    image_url: options?.imageUrl ?? product.imageUrl ?? null,
    calories_kcal: product.caloriesKcal,
    protein_g: product.proteinG,
    fat_g: product.fatG,
    carbs_g: product.carbsG,
    sodium_g: product.sodiumG,
    fiber_g: product.fiberG,
    sugar_g: product.sugarG,
    is_simple: true,
    dishes: [
      {
        name: product.name,
        role: "main",
        calories_kcal: product.caloriesKcal ?? 0,
        protein_g: product.proteinG ?? undefined,
        fat_g: product.fatG ?? undefined,
        carbs_g: product.carbsG ?? undefined,
        sodium_g: product.sodiumG ?? undefined,
        fiber_g: product.fiberG ?? undefined,
        sugar_g: product.sugarG ?? undefined,
      },
    ],
  };
}

export function mergeCatalogSelectionMetadata(
  existingMetadata: Record<string, any> | null | undefined,
  product: CatalogProductSummary,
  selectedFrom: "manual_search" | "photo_match",
): Record<string, any> {
  return {
    ...(existingMetadata ?? {}),
    catalog_selection: {
      active: true,
      selectedFrom,
      selectedAt: new Date().toISOString(),
      productId: product.id,
      sourceCode: product.sourceCode,
      brandName: product.brandName,
      name: product.name,
      categoryCode: product.categoryCode,
      imageUrl: product.imageUrl,
      canonicalUrl: product.canonicalUrl,
      priceYen: product.priceYen,
      caloriesKcal: product.caloriesKcal,
      proteinG: product.proteinG,
      fatG: product.fatG,
      carbsG: product.carbsG,
      sodiumG: product.sodiumG,
      fiberG: product.fiberG,
      sugarG: product.sugarG,
      availabilityStatus: product.availabilityStatus,
    },
  };
}

export function clearCatalogSelectionMetadata(
  existingMetadata: Record<string, any> | null | undefined,
  reason: string,
): Record<string, any> {
  const next = { ...(existingMetadata ?? {}) };
  next.catalog_selection = {
    ...(typeof next.catalog_selection === "object" && next.catalog_selection ? next.catalog_selection : {}),
    active: false,
    clearedAt: new Date().toISOString(),
    clearReason: reason,
  };
  return next;
}

export function extractCatalogProductFromMetadata(
  metadata: Record<string, any> | null | undefined,
): CatalogProductSummary | null {
  const selection = metadata?.catalog_selection;
  if (!selection?.productId || !selection?.active) return null;

  return {
    id: selection.productId,
    sourceId: "",
    sourceCode: selection.sourceCode ?? "",
    brandName: selection.brandName ?? "",
    name: selection.name ?? "",
    categoryCode: selection.categoryCode ?? null,
    description: null,
    imageUrl: selection.imageUrl ?? null,
    canonicalUrl: selection.canonicalUrl ?? "",
    priceYen: toNumberOrNull(selection.priceYen),
    caloriesKcal: toNumberOrNull(selection.caloriesKcal),
    proteinG: toNumberOrNull(selection.proteinG),
    fatG: toNumberOrNull(selection.fatG),
    carbsG: toNumberOrNull(selection.carbsG),
    sodiumG: toNumberOrNull(selection.sodiumG),
    fiberG: toNumberOrNull(selection.fiberG),
    sugarG: toNumberOrNull(selection.sugarG),
    availabilityStatus: selection.availabilityStatus ?? "unknown",
  };
}

export async function findCatalogCandidatesForDishes(
  supabase: SupabaseClient,
  dishNames: string[],
  options?: { limitPerDish?: number },
): Promise<CatalogDishMatch[]> {
  const uniqueDishNames = unique(
    dishNames
      .map((name) => name.trim())
      .filter((name) => name.length >= 2),
  );

  const matches: CatalogDishMatch[] = [];

  for (const dishName of uniqueDishNames) {
    const candidates = await searchCatalogProducts(supabase, dishName, {
      limit: options?.limitPerDish ?? 3,
    });

    if (candidates.length === 0) continue;

    matches.push({
      dishName,
      candidates,
    });
  }

  return matches;
}
