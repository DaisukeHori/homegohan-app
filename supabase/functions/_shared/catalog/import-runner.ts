import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../cors.ts";
import { createLogger, generateRequestId } from "../db-logger.ts";
import { firecrawlScrapeStructured } from "../firecrawl-client.ts";
import {
  cleanupCatalogExtract,
  rescueDiscoveryFromMarkdown,
  rescueProductExtractFromMarkdown,
} from "../catalog-llm.ts";
import {
  firecrawlDiscoverySchema,
  firecrawlProductSchema,
  type CleanedCatalogProduct,
  normalizeCatalogName,
  normalizeCatalogProductUrl,
  normalizeUrl,
  sha256Hex,
} from "../catalog-utils.ts";
import { getCatalogSourceAdapter } from "./source-adapters.ts";

export type ImportRequest = {
  sourceCode?: string;
  categoryCode?: string | null;
  triggerType?: "manual" | "scheduled" | "backfill";
  dryRun?: boolean;
  maxCategories?: number;
  maxProductsPerCategory?: number;
  storeRawDocuments?: boolean;
};

type DiscoveryPage = {
  url: string;
  payload: unknown;
};

type HandlerOptions = {
  defaultSourceCode?: string;
  lockSourceCode?: boolean;
  functionName: string;
};

const DISCOVERY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    itemUrls: {
      type: "array",
      items: { type: "string" },
    },
    categoryUrls: {
      type: "array",
      items: { type: "string" },
    },
  },
};

const DETAIL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    imageUrl: { type: "string" },
    category: { type: "string" },
    subcategory: { type: "string" },
    description: { type: "string" },
    priceYen: { type: "number" },
    salesRegion: { type: "string" },
    availabilityStatus: { type: "string" },
    allergens: {
      type: "array",
      items: { type: "string" },
    },
    nutrition: {
      type: "object",
      additionalProperties: false,
      properties: {
        caloriesKcal: { type: "number" },
        proteinG: { type: "number" },
        fatG: { type: "number" },
        carbsG: { type: "number" },
        fiberG: { type: "number" },
        sodiumG: { type: "number" },
        sugarG: { type: "number" },
      },
    },
    nutritionText: { type: "string" },
    rawText: { type: "string" },
  },
  required: ["name"],
};

export async function handleCatalogImportRequest(req: Request, options: HandlerOptions) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = generateRequestId();
  const logger = createLogger(options.functionName, requestId);

  try {
    const body = (await req.json().catch(() => ({}))) as ImportRequest;
    const requestedSourceCode = body.sourceCode?.trim() || options.defaultSourceCode || "seven_eleven_jp";
    const sourceCode = options.lockSourceCode ? options.defaultSourceCode || requestedSourceCode : requestedSourceCode;
    const categoryCode = body.categoryCode?.trim() || null;
    const triggerType = body.triggerType || "manual";
    const dryRun = Boolean(body.dryRun);
    const defaultMaxCategories = dryRun ? 4 : 1;
    const defaultMaxProductsPerCategory = dryRun ? 10 : 3;
    const maxCategories = Math.max(1, Math.min(body.maxCategories ?? defaultMaxCategories, 10));
    const maxProductsPerCategory = Math.max(1, Math.min(body.maxProductsPerCategory ?? defaultMaxProductsPerCategory, 30));
    const storeRawDocuments = body.storeRawDocuments ?? true;

    const adapter = getCatalogSourceAdapter(sourceCode);
    if (!adapter) {
      return jsonResponse({ error: `catalog source adapter not found: ${sourceCode}` }, 404);
    }

    const supabase = getSupabaseAdmin();
    const { data: source, error: sourceError } = await supabase
      .from("catalog_sources")
      .select("id, code, brand_name, is_active, metadata_json")
      .eq("code", sourceCode)
      .maybeSingle();

    if (sourceError) throw sourceError;
    if (!source) {
      return jsonResponse({ error: `catalog source not found: ${sourceCode}` }, 404);
    }
    if (!source.is_active) {
      return jsonResponse({ error: `catalog source is disabled: ${sourceCode}` }, 409);
    }

    let categoryQuery = supabase
      .from("catalog_source_categories")
      .select("id, category_code, category_name, list_url, crawl_priority")
      .eq("source_id", source.id)
      .eq("is_active", true)
      .order("crawl_priority", { ascending: true })
      .limit(maxCategories);

    if (categoryCode) {
      categoryQuery = categoryQuery.eq("category_code", categoryCode);
    }

    const { data: categories, error: categoriesError } = await categoryQuery;
    if (categoriesError) throw categoriesError;
    if (!categories?.length) {
      return jsonResponse({ error: "No active categories found" }, 404);
    }

    const runPayload = {
      source_id: source.id,
      source_code: source.code,
      category_code: categoryCode,
      trigger_type: triggerType,
      status: "running",
      categories_total: categories.length,
      metadata_json: {
        dryRun,
        maxProductsPerCategory,
        requestId,
        strategy: adapter.config.strategy,
        supportsFullNutrition: adapter.config.supportsFullNutrition,
      },
    };

    let importRunId: string | null = null;
    if (!dryRun) {
      const { data: insertedRun, error: runError } = await supabase
        .from("catalog_import_runs")
        .insert(runPayload)
        .select("id")
        .single();
      if (runError) throw runError;
      importRunId = insertedRun.id;
    }

    const stats = {
      pagesTotal: 0,
      productsSeen: 0,
      productsInserted: 0,
      productsUpdated: 0,
      productsUnchanged: 0,
      productsDiscontinued: 0,
      productErrors: [] as Array<{ categoryCode: string; url: string; error: string }>,
    };

    for (const category of categories) {
      logger.info("Scraping category", {
        sourceCode: source.code,
        categoryCode: category.category_code,
        listUrl: category.list_url,
        strategy: adapter.config.strategy,
      });

      const discovery = await collectCategoryTargets({
        adapter,
        categoryCode: category.category_code,
        listUrl: category.list_url,
        maxItems: maxProductsPerCategory,
      });
      stats.pagesTotal += discovery.pages.length;

      const uniqueItems = dedupeProductUrls(
        discovery.itemUrls.map((url) => normalizeCatalogProductUrl(url, source.code)),
      ).slice(0, maxProductsPerCategory);

      if (!dryRun) {
        await supabase
          .from("catalog_source_categories")
          .update({ last_crawled_at: new Date().toISOString() })
          .eq("id", category.id);
      }

      if (!dryRun && storeRawDocuments && importRunId) {
        for (const page of discovery.pages) {
          await saveRawDocument(supabase, {
            sourceId: source.id,
            importRunId,
            categoryCode: category.category_code,
            documentType: "list",
            url: page.url,
            httpStatus: 200,
            payload: page.payload,
          });
        }
      }

      for (const itemUrl of uniqueItems) {
        stats.productsSeen += 1;

        try {
          const { json: detailJson, markdown: detailMarkdown, raw: detailRaw } = await firecrawlScrapeStructured<unknown>(itemUrl, {
            prompt: adapter.buildDetailPrompt({
              categoryCode: category.category_code,
              brandName: source.brand_name,
            }),
            schema: DETAIL_SCHEMA,
            includeMarkdown: true,
          });

          let detailExtract = parseProductExtract(detailJson, itemUrl);
          if (!detailExtract) {
            detailExtract = await rescueProductExtractFromMarkdown(detailMarkdown, { url: itemUrl });
          }
          if (!detailExtract) {
            throw new Error(`Failed to extract product detail for ${itemUrl}`);
          }

          const cleanedBase = await cleanupCatalogExtract(detailExtract, {
            sourceCode: source.code,
            brandName: source.brand_name,
            fallbackCategoryCode: category.category_code,
          });
          const cleaned: CleanedCatalogProduct = {
            ...cleanedBase,
            metadataJson: {
              ...cleanedBase.metadataJson,
              sourceStrategy: adapter.config.strategy,
              supportsFullNutrition: adapter.config.supportsFullNutrition,
            },
          };

          if (!dryRun && storeRawDocuments && importRunId) {
            await saveRawDocument(supabase, {
              sourceId: source.id,
              importRunId,
              categoryCode: category.category_code,
              documentType: "detail",
              url: itemUrl,
              httpStatus: 200,
              payload: detailRaw,
            });
          }

          if (dryRun) {
            continue;
          }

          const result = await upsertCatalogProduct(supabase, {
            sourceId: source.id,
            importRunId,
            categoryCode: category.category_code,
            cleaned,
          });

          if (result === "inserted") stats.productsInserted += 1;
          else if (result === "updated") stats.productsUpdated += 1;
          else stats.productsUnchanged += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("Failed to import product", error, {
            categoryCode: category.category_code,
            url: itemUrl,
          });
          stats.productErrors.push({
            categoryCode: category.category_code,
            url: itemUrl,
            error: message,
          });
        }
      }
    }

    if (!dryRun && importRunId) {
      await supabase
        .from("catalog_import_runs")
        .update({
          status: stats.productErrors.length > 0 ? "partial" : "completed",
          completed_at: new Date().toISOString(),
          pages_total: stats.pagesTotal,
          products_seen: stats.productsSeen,
          products_inserted: stats.productsInserted,
          products_updated: stats.productsUpdated,
          products_unchanged: stats.productsUnchanged,
          products_discontinued: stats.productsDiscontinued,
          error_log: stats.productErrors.length > 0 ? JSON.stringify(stats.productErrors.slice(0, 20)) : null,
        })
        .eq("id", importRunId);
    }

    return jsonResponse({
      success: true,
      dryRun,
      importRunId,
      sourceCode: source.code,
      categoryCode,
      stats,
    });
  } catch (error) {
    logger.error("Convenience catalog import failed", error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}

function getSupabaseAdmin() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_JWT") ?? "";
  if (!supabaseUrl || !serviceRole) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function collectCategoryTargets(input: {
  adapter: NonNullable<ReturnType<typeof getCatalogSourceAdapter>>;
  categoryCode: string;
  listUrl: string;
  maxItems?: number;
}): Promise<{ itemUrls: string[]; pages: DiscoveryPage[] }> {
  const pages: DiscoveryPage[] = [];
  const itemUrls = new Set<string>();
  const seenListUrls = new Set<string>();
  const queue: Array<{
    url: string;
    depth: number;
    pageType: "root" | "category" | "subcategory";
  }> = [{
    url: input.listUrl,
    depth: 0,
    pageType: "root",
  }];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const normalizedPageUrl = normalizeUrl(next.url);
    if (!normalizedPageUrl || seenListUrls.has(normalizedPageUrl)) continue;
    if (next.depth > input.adapter.maxDiscoveryDepth) continue;

    seenListUrls.add(normalizedPageUrl);

    const page = await scrapeDiscoveryPage({
      adapter: input.adapter,
      url: normalizedPageUrl,
      categoryCode: input.categoryCode,
      pageType: next.pageType,
    });
    pages.push({ url: normalizedPageUrl, payload: page.raw });

    for (const url of normalizeProductTargets(page.extract.itemUrls, input.adapter.config.code)) {
      itemUrls.add(url);
    }

    if (input.maxItems && itemUrls.size >= input.maxItems) {
      break;
    }

    for (const childUrl of normalizeChildListUrls(input.adapter, page.extract)) {
      if (seenListUrls.has(childUrl)) continue;
      queue.push({
        url: childUrl,
        depth: next.depth + 1,
        pageType: next.depth === 0 ? "category" : "subcategory",
      });
    }
  }

  return {
    itemUrls: Array.from(itemUrls),
    pages,
  };
}

async function scrapeDiscoveryPage(input: {
  adapter: NonNullable<ReturnType<typeof getCatalogSourceAdapter>>;
  url: string;
  categoryCode: string;
  pageType: "root" | "category" | "subcategory";
}): Promise<{ extract: ReturnType<typeof firecrawlDiscoverySchema.parse>; raw: unknown }> {
  const { json, markdown, raw } = await firecrawlScrapeStructured<unknown>(input.url, {
    prompt: input.adapter.buildDiscoveryPrompt({
      categoryCode: input.categoryCode,
      pageType: input.pageType,
    }),
    schema: DISCOVERY_SCHEMA,
    includeMarkdown: true,
  });

  let extract = parseDiscoveryExtract(json, input.adapter);
  if (!extract || shouldRescueDiscoveryExtract(extract)) {
    const rescued = await rescueDiscoveryFromMarkdown(markdown, {
      categoryCode: input.categoryCode,
      pageType: input.pageType,
    });
    if (rescued) {
      extract = parseDiscoveryExtract(rescued, input.adapter);
    }
  }
  if (!extract) {
    throw new Error(`Failed to extract discovery links for ${input.url}`);
  }

  return {
    extract,
    raw,
  };
}

function normalizeProductTargets(urls: string[], sourceCode: string) {
  return dedupeStringUrls(
    urls
      .map((url) => normalizeCatalogProductUrl(url, sourceCode))
      .filter(Boolean),
  );
}

function dedupeStringUrls(urls: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function dedupeProductUrls(urls: string[]) {
  return dedupeStringUrls(urls.map(normalizeUrl));
}

function normalizeChildListUrls(
  adapter: NonNullable<ReturnType<typeof getCatalogSourceAdapter>>,
  extract: ReturnType<typeof firecrawlDiscoverySchema.parse>,
) {
  return adapter.filterCategoryUrls([
    ...extract.categoryUrls.map(normalizeUrl),
    ...extract.regionUrls.map(normalizeUrl),
    ...extract.lineupUrls.map(normalizeUrl),
  ]);
}

function parseDiscoveryExtract(
  input: unknown,
  adapter: NonNullable<ReturnType<typeof getCatalogSourceAdapter>>,
) {
  if (!input || typeof input !== "object") return null;
  try {
    const parsed = firecrawlDiscoverySchema.parse(input);
    return firecrawlDiscoverySchema.parse({
      ...parsed,
      itemUrls: adapter.filterItemUrls(parsed.itemUrls),
      categoryUrls: adapter.filterCategoryUrls(parsed.categoryUrls),
      regionUrls: adapter.filterCategoryUrls(parsed.regionUrls),
      lineupUrls: adapter.filterCategoryUrls(parsed.lineupUrls),
    });
  } catch {
    return null;
  }
}

function parseProductExtract(input: unknown, url: string) {
  if (!input || typeof input !== "object") return null;
  try {
    return firecrawlProductSchema.parse({
      ...(input as Record<string, unknown>),
      url,
    });
  } catch {
    return null;
  }
}

function shouldRescueDiscoveryExtract(
  extract: ReturnType<typeof firecrawlDiscoverySchema.parse>,
) {
  return extract.itemUrls.length === 0 && [
    ...extract.categoryUrls,
    ...extract.regionUrls,
    ...extract.lineupUrls,
  ].length === 0;
}

async function upsertCatalogProduct(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  input: {
    sourceId: string;
    importRunId: string | null;
    categoryCode: string;
    cleaned: CleanedCatalogProduct;
  },
): Promise<"inserted" | "updated" | "unchanged"> {
  const { data: existing, error: existingError } = await supabase
    .from("catalog_products")
    .select("id, content_hash")
    .eq("source_id", input.sourceId)
    .eq("external_id", input.cleaned.externalId)
    .maybeSingle();

  if (existingError) throw existingError;

  const baseRow = {
    source_id: input.sourceId,
    external_id: input.cleaned.externalId,
    canonical_url: input.cleaned.canonicalUrl,
    name: input.cleaned.name,
    name_norm: normalizeCatalogName(input.cleaned.name),
    brand_name: input.cleaned.brandName,
    category_code: input.cleaned.categoryCode ?? input.categoryCode,
    subcategory_code: input.cleaned.subcategoryCode ?? null,
    description: input.cleaned.description ?? null,
    price_yen: input.cleaned.priceYen ?? null,
    sales_region: input.cleaned.salesRegion ?? null,
    availability_status: input.cleaned.availabilityStatus,
    main_image_url: input.cleaned.mainImageUrl ?? null,
    calories_kcal: input.cleaned.caloriesKcal ?? null,
    protein_g: input.cleaned.proteinG ?? null,
    fat_g: input.cleaned.fatG ?? null,
    carbs_g: input.cleaned.carbsG ?? null,
    fiber_g: input.cleaned.fiberG ?? null,
    sodium_g: input.cleaned.sodiumG ?? null,
    sugar_g: input.cleaned.sugarG ?? null,
    nutrition_json: input.cleaned.nutritionJson,
    allergens_json: input.cleaned.allergensJson,
    metadata_json: input.cleaned.metadataJson,
    last_seen_at: new Date().toISOString(),
    discontinued_at: input.cleaned.availabilityStatus === "discontinued" ? new Date().toISOString() : null,
    content_hash: input.cleaned.contentHash,
  };

  if (!existing) {
    const { data: inserted, error: insertError } = await supabase
      .from("catalog_products")
      .insert({
        ...baseRow,
        first_seen_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    await insertSnapshot(supabase, inserted.id, input.importRunId, input.cleaned);
    return "inserted";
  }

  if (existing.content_hash === input.cleaned.contentHash) {
    return "unchanged";
  }

  const { error: updateError } = await supabase
    .from("catalog_products")
    .update(baseRow)
    .eq("id", existing.id);
  if (updateError) throw updateError;

  await insertSnapshot(supabase, existing.id, input.importRunId, input.cleaned);
  return "updated";
}

async function insertSnapshot(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  productId: string,
  importRunId: string | null,
  cleaned: CleanedCatalogProduct,
) {
  const { error } = await supabase
    .from("catalog_product_snapshots")
    .upsert({
      product_id: productId,
      import_run_id: importRunId,
      snapshot_hash: cleaned.contentHash,
      name: cleaned.name,
      price_yen: cleaned.priceYen ?? null,
      main_image_url: cleaned.mainImageUrl ?? null,
      availability_status: cleaned.availabilityStatus,
      calories_kcal: cleaned.caloriesKcal ?? null,
      protein_g: cleaned.proteinG ?? null,
      fat_g: cleaned.fatG ?? null,
      carbs_g: cleaned.carbsG ?? null,
      fiber_g: cleaned.fiberG ?? null,
      sodium_g: cleaned.sodiumG ?? null,
      sugar_g: cleaned.sugarG ?? null,
      nutrition_json: cleaned.nutritionJson,
      allergens_json: cleaned.allergensJson,
      metadata_json: cleaned.metadataJson,
    }, {
      onConflict: "product_id,snapshot_hash",
    });

  if (error) throw error;
}

async function saveRawDocument(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  input: {
    sourceId: string;
    importRunId: string;
    categoryCode: string;
    documentType: "list" | "detail";
    url: string;
    httpStatus: number;
    payload: unknown;
  },
) {
  const normalizedUrl = normalizeUrl(input.url);
  const payloadText = JSON.stringify(input.payload ?? {});
  const contentHash = await sha256Hex(payloadText);

  const { error } = await supabase
    .from("catalog_raw_documents")
    .insert({
      source_id: input.sourceId,
      import_run_id: input.importRunId,
      category_code: input.categoryCode,
      document_type: input.documentType,
      url: normalizedUrl,
      http_status: input.httpStatus,
      content_sha256: contentHash,
      payload: input.payload ?? {},
    });

  if (error) {
    console.warn("[catalog-import-runner] failed to save raw document", error.message);
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
