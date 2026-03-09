#!/usr/bin/env node

/**
 * 埋め込みベクトル再生成スクリプト
 * dataset embeddings で全テーブルを更新
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  DATASET_EMBEDDING_API_KEY_ENV,
  DATASET_EMBEDDING_DIMENSIONS,
  DATASET_EMBEDDING_MODEL,
  buildMenuSetEmbeddingText,
  fetchDatasetEmbeddings,
} from "../shared/dataset-embedding.mjs";
import { buildProgressSnapshot } from "../shared/progress-reporting.mjs";

// .env.local を読み込む
config({ path: ".env.local" });
config({ path: "data/raw/edge-secrets.env" });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.DATASET_SERVICE_ROLE_KEY;
const DATASET_EMBEDDING_API_KEY = process.env[DATASET_EMBEDDING_API_KEY_ENV];

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !DATASET_EMBEDDING_API_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const BATCH_SIZE = Math.max(1, Math.min(1000, Number(process.env.EMBEDDING_BATCH_SIZE || 100) || 100));
const UPDATE_CONCURRENCY = Math.max(1, Math.min(50, Number(process.env.EMBEDDING_UPDATE_CONCURRENCY || 10) || 10));
const TARGET_ROWS_PER_MIN = Math.max(0, Number(process.env.EMBEDDING_TARGET_ROWS_PER_MIN || 500) || 500);
const TEMP_RETRY_DELAY_MS = Math.max(1000, Number(process.env.TEMP_RETRY_DELAY_MS || 3000) || 3000);
const MIN_BATCH_INTERVAL_MS =
  TARGET_ROWS_PER_MIN > 0 ? Math.ceil((BATCH_SIZE / TARGET_ROWS_PER_MIN) * 60_000) : 0;
const DIMENSIONS = DATASET_EMBEDDING_DIMENSIONS;
const MODEL = DATASET_EMBEDDING_MODEL;
const TABLE_CONFIGS = {
  dataset_ingredients: {
    selectColumns: "id, name, name_norm",
    embeddingColumn: "name_embedding",
    writeMode: "upsert",
    buildText: (row) => row.name || "",
    buildUpsertRow: (row, embedding) => ({
      id: row.id,
      name_embedding: embedding,
    }),
  },
  dataset_recipes: {
    selectColumns: "id, external_id, name, name_norm",
    embeddingColumn: "name_embedding",
    writeMode: "upsert",
    buildText: (row) => row.name || "",
    buildUpsertRow: (row, embedding) => ({
      id: row.id,
      name_embedding: embedding,
    }),
  },
  dataset_menu_sets: {
    selectColumns: "id, external_id, title, dish_count, dishes, theme_tags, calories_kcal, protein_g, fat_g, carbs_g, sodium_g",
    embeddingColumn: "content_embedding",
    writeMode: "row_update",
    buildText: (row) => buildMenuSetEmbeddingText(row),
    buildUpsertRow: (row, embedding) => ({
      id: row.id,
      external_id: row.external_id,
      title: row.title,
      dish_count: row.dish_count,
      content_embedding: embedding,
    }),
  },
};

async function embedBatch(texts) {
  return retryOperation(
    () =>
      fetchDatasetEmbeddings(texts, {
        apiKey: DATASET_EMBEDDING_API_KEY,
        inputType: "document",
      }),
    "embedding-batch",
    { baseDelayMs: TEMP_RETRY_DELAY_MS },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOperation(fn, label, { retries = Infinity, baseDelayMs = TEMP_RETRY_DELAY_MS } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      const canRetry = isTemporaryError(error);
      if (!canRetry) {
        throw error;
      }

      if (Number.isFinite(retries) && attempt >= retries) {
        throw error;
      }

      attempt += 1;
      console.warn(`   retry ${label} in ${baseDelayMs}ms (${attempt})`);
      await sleep(baseDelayMs);
    }
  }
}

function isTemporaryError(error) {
  const message = String(error?.message ?? error ?? "");
  return [
    /fetch failed/i,
    /timeout/i,
    /network/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /503/i,
    /502/i,
    /504/i,
    /service unavailable/i,
  ].some((pattern) => pattern.test(message));
}

async function writeRows(tableName, config, payload) {
  if (config.writeMode !== "row_update") {
    await retryOperation(async () => {
      const { error: upsertError } = await supabase
        .from(tableName)
        .upsert(payload, { onConflict: "id", ignoreDuplicates: false });

      if (upsertError) {
        throw new Error(`Error upserting ${tableName}: ${upsertError.message}`);
      }
    }, `${tableName}:upsert`);
    return;
  }

  for (let i = 0; i < payload.length; i += UPDATE_CONCURRENCY) {
    const chunk = payload.slice(i, i + UPDATE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (row) => {
        await retryOperation(async () => {
          const { error } = await supabase
            .from(tableName)
            .update({ [config.embeddingColumn]: row[config.embeddingColumn] })
            .eq("id", row.id);

          if (error) {
            throw new Error(`Error updating ${tableName}:${row.id}: ${error.message}`);
          }
        }, `${tableName}:${row.id}`);
      }),
    );
    void results;
  }
}

async function processTable(tableName) {
  console.log(`\n📊 Processing ${tableName}...`);
  const startedAt = Date.now();
  const config = TABLE_CONFIGS[tableName];
  if (!config) {
    throw new Error(`Unknown table: ${tableName}`);
  }

  // NULL件数を取得
  const { count } = await supabase
    .from(tableName)
    .select("*", { count: "exact", head: true });
  const { count: missingCount } = await supabase
    .from(tableName)
    .select("*", { count: "exact", head: true })
    .is(config.embeddingColumn, null);

  console.log(`   Total rows: ${count}`);
  console.log(`   Missing embeddings: ${missingCount}`);

  let processed = 0;

  while (true) {
    const batchStartedAt = Date.now();
    try {
      const { data: rows, error } = await supabase
        .from(tableName)
        .select(config.selectColumns)
        .is(config.embeddingColumn, null)
        .limit(BATCH_SIZE);

      if (error) {
        throw new Error(`Error fetching ${tableName}: ${error.message}`);
      }

      if (!rows || rows.length === 0) break;

      const texts = rows.map((r) => config.buildText(r));
      const embeddings = await embedBatch(texts);

      const payload = rows.map((row, index) => config.buildUpsertRow(row, embeddings[index]));
      await writeRows(tableName, config, payload);

      processed += rows.length;
      console.log(
        `   ${buildProgressSnapshot({
          label: "Progress",
          processed,
          total: missingCount,
          startedAt,
        })}`,
      );

      if (MIN_BATCH_INTERVAL_MS > 0) {
        const elapsed = Date.now() - batchStartedAt;
        const waitMs = MIN_BATCH_INTERVAL_MS - elapsed;
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
    } catch (error) {
      if (!isTemporaryError(error)) {
        throw error;
      }

      console.warn(`   temporary failure on ${tableName}: ${error?.message ?? error}`);
      console.warn(`   waiting ${TEMP_RETRY_DELAY_MS}ms and resuming from remaining NULL rows...`);
      await sleep(TEMP_RETRY_DELAY_MS);
    }
  }

  console.log(`\n   ✅ Completed ${tableName}`);
  return { tableName, processed, total: missingCount ?? processed };
}

async function main() {
  console.log("🚀 Starting embedding regeneration");
  console.log(`   Model: ${MODEL}`);
  console.log(`   Dimensions: ${DIMENSIONS}`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log(`   Update concurrency: ${UPDATE_CONCURRENCY}`);
  console.log(`   Target rows/min: ${TARGET_ROWS_PER_MIN}`);
  console.log(`   Retry delay: ${TEMP_RETRY_DELAY_MS}ms`);

  const startTime = Date.now();
  const tables = String(process.env.EMBEDDING_TABLES || "dataset_ingredients,dataset_recipes,dataset_menu_sets")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const table of tables) {
    await processTable(table);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n🎉 All done! Total time: ${elapsed} minutes`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
