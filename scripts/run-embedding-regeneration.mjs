#!/usr/bin/env node

/**
 * Edge Function を繰り返し呼び出して全テーブルの埋め込みを再生成
 */

import { DATASET_EMBEDDING_DIMENSIONS, DATASET_EMBEDDING_MODEL } from "../shared/dataset-embedding.mjs";
import { buildProgressSnapshot } from "../shared/progress-reporting.mjs";

const SUPABASE_URL = "https://flmeolcfutuwwbjmzyoz.supabase.co";
// regenerate-embeddings は service role key（または CRON_SECRET/SERVICE_ROLE_SECRET）以外を拒否するため、
// anon key ではなく service role key を使用する。
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_SERVICE_ROLE_KEY environment variable is required");
  process.exit(1);
}

const TABLES = [
  "dataset_ingredients",
  "dataset_recipes", 
  "dataset_menu_sets",
];

const BATCH_LIMIT = 100;

async function processTable(tableName) {
  console.log(`\n📊 Processing ${tableName}...`);
  const startedAt = Date.now();
  
  let offset = 0;
  let hasMore = true;
  let totalProcessed = 0;
  
  while (hasMore) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/regenerate-embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        table: tableName,
        offset,
        limit: BATCH_LIMIT,
      }),
    });
    
    if (!res.ok) {
      const err = await res.text();
      console.error(`   ❌ Error: ${err}`);
      break;
    }
    
    const data = await res.json();
    
    if (data.error) {
      console.error(`   ❌ Error: ${data.error}`);
      break;
    }
    
    totalProcessed += data.processed;
    offset = data.nextOffset;
    hasMore = data.hasMore;

    console.log(
      `   ${buildProgressSnapshot({
        label: "Progress",
        processed: totalProcessed,
        total: data.totalCount,
        startedAt,
        cursor: `${offset}/${data.totalCount}`,
      })}`,
    );
    
    // レート制限を避けるため少し待つ
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`\n   ✅ Completed ${tableName}: ${totalProcessed} rows`);
}

async function main() {
  console.log("🚀 Starting embedding regeneration via Edge Function");
  console.log(`   Model: ${DATASET_EMBEDDING_MODEL}`);
  console.log(`   Dimensions: ${DATASET_EMBEDDING_DIMENSIONS}`);
  
  const startTime = Date.now();
  
  for (const table of TABLES) {
    await processTable(table);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n🎉 All done! Total time: ${elapsed} minutes`);
}

main().catch(console.error);
