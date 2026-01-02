import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * 埋め込みベクトル再生成 Edge Function
 * 
 * 使い方:
 * POST /functions/v1/regenerate-embeddings
 * Body: { "table": "dataset_ingredients" | "dataset_recipes" | "dataset_menu_sets", "offset": 0, "limit": 100 }
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_MODEL = "text-embedding-3-large";
const BATCH_SIZE = 50; // OpenAI API に送るバッチサイズ

interface TableConfig {
  textColumn: string;
  embeddingColumn: string;
}

const TABLE_CONFIGS: Record<string, TableConfig> = {
  dataset_ingredients: { textColumn: "name", embeddingColumn: "name_embedding" },
  dataset_recipes: { textColumn: "name", embeddingColumn: "name_embedding" },
  dataset_menu_sets: { textColumn: "title", embeddingColumn: "content_embedding" },
};

async function embedBatch(texts: string[], model: string, dimensions: number): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: texts,
      dimensions,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error: ${err}`);
  }

  const json = await res.json();
  return json.data.map((d: any) => d.embedding);
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

    // 総数を取得
    const { count: totalCount } = await supabase
      .from(tableName)
      .select("*", { count: "exact", head: true });

    // レコード取得
    const { data: rows, error: fetchError } = await supabase
      .from(tableName)
      .select(`id, ${config.textColumn}`)
      .range(offset, offset + limit - 1);

    if (fetchError) {
      throw new Error(`Fetch error: ${fetchError.message}`);
    }

    if (!rows || rows.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "No more rows to process",
          processed: 0,
          offset,
          totalCount,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // バッチで埋め込み生成・更新
    let processed = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const texts = batch.map((r: any) => r[config.textColumn] || "");

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

    const nextOffset = offset + rows.length;
    const hasMore = nextOffset < (totalCount ?? 0);

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
