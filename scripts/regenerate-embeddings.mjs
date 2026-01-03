#!/usr/bin/env node

/**
 * 埋め込みベクトル再生成スクリプト
 * text-embedding-3-large (1536次元) で全テーブルを更新
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// .env.local を読み込む
config({ path: ".env.local" });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const BATCH_SIZE = 100;
const DIMENSIONS = 1536;
const MODEL = "text-embedding-3-large";

async function embedBatch(texts) {
  const response = await openai.embeddings.create({
    model: MODEL,
    input: texts,
    dimensions: DIMENSIONS,
  });
  return response.data.map((d) => d.embedding);
}

async function processTable(tableName, textColumn, embeddingColumn) {
  console.log(`\n📊 Processing ${tableName}...`);

  // カウント取得
  const { count } = await supabase
    .from(tableName)
    .select("*", { count: "exact", head: true });

  console.log(`   Total rows: ${count}`);

  let processed = 0;
  let offset = 0;

  while (offset < count) {
    // バッチ取得
    const { data: rows, error } = await supabase
      .from(tableName)
      .select(`id, ${textColumn}`)
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error(`   Error fetching rows:`, error.message);
      break;
    }

    if (!rows || rows.length === 0) break;

    // テキスト抽出
    const texts = rows.map((r) => r[textColumn] || "");
    
    // 埋め込み生成
    const embeddings = await embedBatch(texts);

    // 更新
    for (let i = 0; i < rows.length; i++) {
      const { error: updateError } = await supabase
        .from(tableName)
        .update({ [embeddingColumn]: embeddings[i] })
        .eq("id", rows[i].id);

      if (updateError) {
        console.error(`   Error updating row ${rows[i].id}:`, updateError.message);
      }
    }

    processed += rows.length;
    offset += BATCH_SIZE;

    const pct = ((processed / count) * 100).toFixed(1);
    process.stdout.write(`\r   Progress: ${processed}/${count} (${pct}%)`);
  }

  console.log(`\n   ✅ Completed ${tableName}`);
}

async function main() {
  console.log("🚀 Starting embedding regeneration");
  console.log(`   Model: ${MODEL}`);
  console.log(`   Dimensions: ${DIMENSIONS}`);

  const startTime = Date.now();

  // 1. dataset_ingredients
  await processTable("dataset_ingredients", "name", "name_embedding");

  // 2. dataset_recipes
  await processTable("dataset_recipes", "name", "name_embedding");

  // 3. dataset_menu_sets (content カラムを使用)
  await processTable("dataset_menu_sets", "content", "content_embedding");

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n🎉 All done! Total time: ${elapsed} minutes`);
}

main().catch(console.error);
