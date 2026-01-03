#!/usr/bin/env node

/**
 * Edge Function を繰り返し呼び出して全テーブルの埋め込みを再生成
 */

const SUPABASE_URL = "https://flmeolcfutuwwbjmzyoz.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsbWVvbGNmdXR1d3diam16eW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NzAxODYsImV4cCI6MjA3OTU0NjE4Nn0.VVxUxKexNeN6dUiAMDkCNlnIoXa-F5rfBqHPBDcwdnU";

const TABLES = [
  "dataset_ingredients",
  "dataset_recipes", 
  "dataset_menu_sets",
];

const BATCH_LIMIT = 100;

async function processTable(tableName) {
  console.log(`\n📊 Processing ${tableName}...`);
  
  let offset = 0;
  let hasMore = true;
  let totalProcessed = 0;
  
  while (hasMore) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/regenerate-embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ANON_KEY}`,
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
    
    const pct = data.totalCount > 0 
      ? ((offset / data.totalCount) * 100).toFixed(1)
      : "100";
    
    process.stdout.write(`\r   Progress: ${offset}/${data.totalCount} (${pct}%)`);
    
    // レート制限を避けるため少し待つ
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`\n   ✅ Completed ${tableName}: ${totalProcessed} rows`);
}

async function main() {
  console.log("🚀 Starting embedding regeneration via Edge Function");
  console.log("   Model: text-embedding-3-large");
  console.log("   Dimensions: 1536");
  
  const startTime = Date.now();
  
  for (const table of TABLES) {
    await processTable(table);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n🎉 All done! Total time: ${elapsed} minutes`);
}

main().catch(console.error);
