import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import {
  DATASET_EMBEDDING_API_KEY_ENV,
  DATASET_EMBEDDING_DIMENSIONS,
  DATASET_EMBEDDING_MODEL,
  buildMenuSetEmbeddingText,
  fetchDatasetEmbeddings,
  isDatasetEmbeddingConfig,
} from "../../../shared/dataset-embedding.mjs";

/**
 * 埋め込みベクトル再生成 Edge Function
 * 
 * 使い方:
 * POST /functions/v1/regenerate-embeddings
 * Body: { "table": "dataset_ingredients" | "dataset_recipes" | "dataset_menu_sets", "offset": 0, "limit": 100 }
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// SERVICE_ROLE_JWT を優先し、なければ SUPABASE_SERVICE_ROLE_KEY を使用
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const DATASET_EMBEDDING_API_KEY = Deno.env.get(DATASET_EMBEDDING_API_KEY_ENV) ?? "";

const DEFAULT_DIMENSIONS = DATASET_EMBEDDING_DIMENSIONS;
const DEFAULT_MODEL = DATASET_EMBEDDING_MODEL;
const BATCH_SIZE = 50;

interface TableConfig {
  embeddingColumn: string;
  selectColumns: string;
  buildText(row: Record<string, unknown>): string;
}

const TABLE_CONFIGS: Record<string, TableConfig> = {
  dataset_ingredients: {
    embeddingColumn: "name_embedding",
    selectColumns: "id, name",
    buildText: (row) => String(row.name ?? ""),
  },
  dataset_recipes: {
    embeddingColumn: "name_embedding",
    selectColumns: "id, name",
    buildText: (row) => String(row.name ?? ""),
  },
  dataset_menu_sets: {
    embeddingColumn: "content_embedding",
    selectColumns: "id, title, theme_tags, dishes, calories_kcal, protein_g, fat_g, carbs_g, sodium_g",
    buildText: (row) => buildMenuSetEmbeddingText(row),
  },
};

async function embedBatch(texts: string[], model: string, dimensions: number): Promise<number[][]> {
  if (!DATASET_EMBEDDING_API_KEY) {
    throw new Error(`Missing ${DATASET_EMBEDDING_API_KEY_ENV}`);
  }
  if (!isDatasetEmbeddingConfig(model, dimensions)) {
    throw new Error(`Invalid embedding config. Use ${DATASET_EMBEDDING_MODEL} with ${DATASET_EMBEDDING_DIMENSIONS} dimensions.`);
  }
  return await fetchDatasetEmbeddings(texts, {
    apiKey: DATASET_EMBEDDING_API_KEY,
    inputType: "document",
  }) as number[][];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const tableName = body.table as string;
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 100;
    const model = body.model ?? DEFAULT_MODEL;
    const dimensions = body.dimensions ?? DEFAULT_DIMENSIONS;

    if (!isDatasetEmbeddingConfig(model, dimensions)) {
      return new Response(
        JSON.stringify({
          error: `Invalid embedding config. Use ${DATASET_EMBEDDING_MODEL} with ${DATASET_EMBEDDING_DIMENSIONS} dimensions.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!tableName || !TABLE_CONFIGS[tableName]) {
      return new Response(
        JSON.stringify({
          error: "Invalid table. Use: dataset_ingredients, dataset_recipes, or dataset_menu_sets",
          tables: Object.keys(TABLE_CONFIGS),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const config = TABLE_CONFIGS[tableName];
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const onlyMissing = body.onlyMissing ?? false;

    // 総数を取得（onlyMissingがtrueの場合はNULLのレコード数）
    let countQuery = supabase
      .from(tableName)
      .select("*", { count: "exact", head: true });
    
    if (onlyMissing) {
      countQuery = countQuery.is(config.embeddingColumn, null);
    }
    
    const { count: totalCount } = await countQuery;

    // 埋め込みベクトルがNULLのレコードのみを取得（offset指定がある場合は従来通り）
    let query = supabase
      .from(tableName)
      .select(config.selectColumns);
    
    // onlyMissingパラメータがtrueの場合、NULLのレコードのみを取得
    if (onlyMissing) {
      query = query.is(config.embeddingColumn, null);
    }
    
    // offset指定がある場合はrangeを使用
    const { data: rows, error: fetchError } = await query
      .range(offset, offset + limit - 1);

    if (fetchError) {
      throw new Error(`Fetch error: ${fetchError.message}`);
    }

    // onlyMissing=trueの場合、rows.length === 0でも実際にNULLレコードが残っているか確認
    if (!rows || rows.length === 0) {
      // onlyMissingモードの場合、実際にNULLレコードが残っているか再確認
      if (onlyMissing) {
        const { count: remainingCount } = await supabase
          .from(tableName)
          .select("*", { count: "exact", head: true })
          .is(config.embeddingColumn, null);
        
        if (remainingCount && remainingCount > 0) {
          // NULLレコードが残っている場合は、offset=0から再開
          return new Response(
            JSON.stringify({
              success: true,
              table: tableName,
              processed: 0,
              offset: 0,
              nextOffset: 0,
              totalCount: remainingCount,
              hasMore: true,
              model,
              dimensions,
              message: `No rows fetched at offset ${offset}, but ${remainingCount} NULL records remain. Restart from offset=0.`,
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
      }
      
      return new Response(
        JSON.stringify({
          success: true,
          message: "No more rows to process",
          processed: 0,
          offset,
          totalCount: totalCount ?? 0,
          hasMore: false,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // バッチで埋め込み生成・更新
    let processed = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const texts = batch.map((r: any) => config.buildText(r));

      const embeddings = await embedBatch(texts, model, dimensions);

      // 更新
      for (let j = 0; j < batch.length; j++) {
        const { error: updateError } = await supabase
          .from(tableName)
          .update({ [config.embeddingColumn]: embeddings[j] })
          .eq("id", batch[j].id);

        if (updateError) {
          console.error(`Update error for ${batch[j].id}:`, updateError.message);
        } else {
          processed++;
        }
      }
    }

    // onlyMissing=trueの場合、処理後に実際のNULLレコード数を再取得してhasMoreを判定
    let actualRemainingCount = totalCount;
    if (onlyMissing) {
      const { count: remainingCount } = await supabase
        .from(tableName)
        .select("*", { count: "exact", head: true })
        .is(config.embeddingColumn, null);
      actualRemainingCount = remainingCount ?? 0;
    }

    const nextOffset = offset + rows.length;
    // hasMoreの判定を改善：rows.length > 0 かつ (nextOffset < totalCount または onlyMissingで実際にNULLレコードが残っている)
    const hasMore = rows.length > 0 && (
      (totalCount !== null && nextOffset < totalCount) ||
      (onlyMissing && actualRemainingCount > 0)
    );

    return new Response(
      JSON.stringify({
        success: true,
        table: tableName,
        processed,
        offset,
        nextOffset,
        totalCount,
        hasMore,
        model,
        dimensions,
        message: hasMore
          ? `Processed ${processed} rows. Call again with offset=${nextOffset}`
          : `Completed! All ${totalCount} rows processed.`,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("Error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
