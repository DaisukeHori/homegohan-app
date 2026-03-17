import OpenAI from "npm:openai@6.9.1";
import { createFastLLMClient, getFastLLMModel } from "./fast-llm.ts";
import {
  firecrawlDiscoverySchema,
  type FirecrawlDiscoveryExtract,
  FirecrawlProductExtract,
  firecrawlProductSchema,
  CleanedCatalogProduct,
  cleanedCatalogProductSchema,
  buildCatalogContentHash,
  deriveExternalId,
  extractCatalogObservedRegionCode,
  isPlaceholderImageUrl,
  normalizeCatalogName,
  normalizeCategoryCode,
  normalizeCatalogProductUrl,
  normalizeUrl,
  toFiniteNumber,
} from "./catalog-utils.ts";

function getOpenAI(): OpenAI | null {
  const apiKey = Deno.env.get("XAI_API_KEY");
  if (!apiKey) return null;
  return createFastLLMClient();
}

export async function cleanupCatalogExtract(
  extract: FirecrawlProductExtract,
  context: {
    sourceCode: string;
    brandName: string;
    fallbackCategoryCode?: string | null;
  },
): Promise<CleanedCatalogProduct> {
  const fallback = await deterministicCleanup(extract, context);
  if (!shouldUseCleanupLlmFallback(extract, fallback)) {
    return fallback;
  }

  const openai = getOpenAI();
  if (!openai) {
    return fallback;
  }

  const prompt = [
    "あなたはコンビニ・市販商品の商品情報を正規化するアシスタントです。",
    "与えられた抽出結果を、欠損を補いすぎず、確実に読み取れる値だけで JSON に整形してください。",
    "数値は number または null。",
    "availabilityStatus は active / limited / discontinued / unknown のいずれか。",
    "categoryCode は onigiri / bento / men / sandwich のいずれか。判定不能なら null。",
    "canonicalUrl と externalId は変更しないこと。",
    "brandName は変更しないこと。",
    "",
    "抽出結果:",
    JSON.stringify(extract),
    "",
    "決定済みフォールバック:",
    JSON.stringify(fallback),
  ].join("\n");

  const parsed = await callOpenAiJson(openai, prompt, 900);
  if (!parsed) {
    return fallback;
  }

  try {
    const merged = cleanedCatalogProductSchema.parse({
      ...fallback,
      ...parsed,
      nutritionJson: {
        ...fallback.nutritionJson,
        ...(parsed?.nutritionJson ?? {}),
      },
      allergensJson: Array.isArray(parsed?.allergensJson) ? parsed.allergensJson : fallback.allergensJson,
      metadataJson: {
        ...fallback.metadataJson,
        ...(parsed?.metadataJson ?? {}),
        llmNormalized: true,
      },
    });

    const contentHash = await buildCatalogContentHash(hashInput(merged));
    return {
      ...merged,
      contentHash,
    };
  } catch {
    return fallback;
  }
}

export async function rescueDiscoveryFromMarkdown(
  markdown: string | null | undefined,
  context: {
    categoryCode: string;
    pageType: "root" | "category" | "subcategory";
  },
): Promise<FirecrawlDiscoveryExtract | null> {
  const openai = getOpenAI();
  if (!openai || !markdown?.trim()) return null;

  const prompt = [
    "あなたはコンビニ商品一覧ページからリンクを構造化抽出するアシスタントです。",
    "与えられた markdown から URL を JSON へ整理してください。",
    "itemUrls には商品詳細URLのみ。",
    "categoryUrls にはカテゴリ、サブカテゴリ、地域一覧、ラインナップ一覧など次に辿る一覧URLを入れてください。",
    "重複を除き、絶対URLで返してください。",
    `pageType=${context.pageType}`,
    `categoryCode=${context.categoryCode}`,
    "",
    markdown.slice(0, 12000),
  ].join("\n");

  const parsed = await callOpenAiJson(openai, prompt, 1200);
  if (!parsed) return null;

  try {
    return firecrawlDiscoverySchema.parse(parsed);
  } catch {
    return null;
  }
}

export async function rescueProductExtractFromMarkdown(
  markdown: string | null | undefined,
  context: {
    url: string;
  },
): Promise<FirecrawlProductExtract | null> {
  const openai = getOpenAI();
  if (!openai || !markdown?.trim()) return null;

  const prompt = [
    "あなたはコンビニ商品の詳細ページから商品情報を抽出するアシスタントです。",
    "与えられた markdown から、読める値だけを JSON で返してください。",
    "数値は number または null。",
    "name が読めない場合は null を返さず、そのまま失敗させてください。",
    `url=${context.url}`,
    "",
    markdown.slice(0, 12000),
  ].join("\n");

  const parsed = await callOpenAiJson(openai, prompt, 1200);
  if (!parsed || typeof parsed !== "object") return null;

  try {
    return firecrawlProductSchema.parse({
      ...parsed,
      url: context.url,
    });
  } catch {
    return null;
  }
}

async function deterministicCleanup(
  extract: FirecrawlProductExtract,
  context: {
    sourceCode: string;
    brandName: string;
    fallbackCategoryCode?: string | null;
  },
): Promise<CleanedCatalogProduct> {
  const observedUrl = normalizeUrl(extract.url);
  const canonicalUrl = normalizeCatalogProductUrl(extract.url, context.sourceCode);
  const availabilityStatus = normalizeAvailability(extract.availabilityStatus);

  const normalized: Omit<CleanedCatalogProduct, "contentHash"> = {
    name: extract.name.trim(),
    canonicalUrl,
    externalId: deriveExternalId(canonicalUrl, context.sourceCode),
    brandName: context.brandName,
    categoryCode: normalizeCategoryCode(extract.category, context.fallbackCategoryCode),
    subcategoryCode: normalizeCategoryCode(extract.subcategory, null),
    description: extract.description?.trim() || null,
    priceYen: toFiniteNumber(extract.priceYen),
    salesRegion: extract.salesRegion?.trim() || null,
    availabilityStatus,
    mainImageUrl: extract.imageUrl && !isPlaceholderImageUrl(extract.imageUrl)
      ? normalizeUrl(extract.imageUrl)
      : null,
    caloriesKcal: toFiniteNumber(extract.nutrition?.caloriesKcal),
    proteinG: toFiniteNumber(extract.nutrition?.proteinG),
    fatG: toFiniteNumber(extract.nutrition?.fatG),
    carbsG: toFiniteNumber(extract.nutrition?.carbsG),
    fiberG: toFiniteNumber(extract.nutrition?.fiberG),
    sodiumG: toFiniteNumber(extract.nutrition?.sodiumG),
    sugarG: toFiniteNumber(extract.nutrition?.sugarG),
    nutritionJson: {
      caloriesKcal: toFiniteNumber(extract.nutrition?.caloriesKcal),
      proteinG: toFiniteNumber(extract.nutrition?.proteinG),
      fatG: toFiniteNumber(extract.nutrition?.fatG),
      carbsG: toFiniteNumber(extract.nutrition?.carbsG),
      fiberG: toFiniteNumber(extract.nutrition?.fiberG),
      sodiumG: toFiniteNumber(extract.nutrition?.sodiumG),
      sugarG: toFiniteNumber(extract.nutrition?.sugarG),
      nutritionText: extract.nutritionText ?? null,
    },
    allergensJson: extract.allergens ?? [],
    metadataJson: {
      sourceCode: context.sourceCode,
      observedUrl,
      observedRegionCode: extractCatalogObservedRegionCode(observedUrl, context.sourceCode),
      rawCategory: extract.category ?? null,
      rawSubcategory: extract.subcategory ?? null,
      rawAvailabilityStatus: extract.availabilityStatus ?? null,
      nameNorm: normalizeCatalogName(extract.name),
      rawText: extract.rawText ?? null,
      llmNormalized: false,
    },
  };

  const validated = cleanedCatalogProductSchema.parse({
    ...normalized,
    contentHash: "pending",
  });
  const contentHash = await buildCatalogContentHash(hashInput(validated));
  return {
    ...validated,
    contentHash,
  };
}

function normalizeAvailability(input: string | null | undefined): "active" | "limited" | "discontinued" | "unknown" {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (/表示できません|情報を表示できません/.test(raw)) return "unknown";
  if (/終売|販売終了|discontinued/.test(raw)) return "discontinued";
  if (/限定|limited/.test(raw)) return "limited";
  if (/販売中|active|発売中/.test(raw)) return "active";
  return "unknown";
}

function shouldUseCleanupLlmFallback(
  extract: FirecrawlProductExtract,
  fallback: CleanedCatalogProduct,
) {
  let rescueSignals = 0;

  if (!fallback.categoryCode) rescueSignals += 1;
  if (fallback.priceYen == null) rescueSignals += 1;
  if (!fallback.salesRegion) rescueSignals += 1;

  const nutritionCount = [
    fallback.caloriesKcal,
    fallback.proteinG,
    fallback.fatG,
    fallback.carbsG,
    fallback.fiberG,
    fallback.sodiumG,
    fallback.sugarG,
  ].filter((value) => value != null).length;

  if (nutritionCount === 0 && (extract.nutritionText || extract.rawText)) rescueSignals += 1;
  if (!fallback.mainImageUrl && extract.imageUrl && !isPlaceholderImageUrl(extract.imageUrl)) rescueSignals += 1;

  return rescueSignals >= 2;
}

async function callOpenAiJson(
  openai: OpenAI,
  prompt: string,
  maxCompletionTokens: number,
) {
  const response = await openai.chat.completions.create({
    model: Deno.env.get("CONVENIENCE_CATALOG_LLM_MODEL") || getFastLLMModel(),
    messages: [
      {
        role: "system",
        content: "回答はJSONオブジェクトのみ。Markdownや説明文は不要。",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: maxCompletionTokens,
  } as any);

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function hashInput(product: Omit<CleanedCatalogProduct, "contentHash"> | CleanedCatalogProduct) {
  return {
    name: product.name,
    categoryCode: product.categoryCode,
    subcategoryCode: product.subcategoryCode,
    description: product.description,
    priceYen: product.priceYen,
    salesRegion: product.salesRegion,
    availabilityStatus: product.availabilityStatus,
    mainImageUrl: product.mainImageUrl,
    caloriesKcal: product.caloriesKcal,
    proteinG: product.proteinG,
    fatG: product.fatG,
    carbsG: product.carbsG,
    fiberG: product.fiberG,
    sodiumG: product.sodiumG,
    sugarG: product.sugarG,
    nutritionJson: product.nutritionJson,
    allergensJson: product.allergensJson,
  };
}
