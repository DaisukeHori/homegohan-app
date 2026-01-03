#!/usr/bin/env node

/**
 * 埋め込み再生成を途中から再開（エラー自動リトライ機能付き）
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "https://flmeolcfutuwwbjmzyoz.supabase.co";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsbWVvbGNmdXR1d3diam16eW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NzAxODYsImV4cCI6MjA3OTU0NjE4Nn0.VVxUxKexNeN6dUiAMDkCNlnIoXa-F5rfBqHPBDcwdnU";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const BATCH_LIMIT = 100;
const RETRY_DELAY = 5000; // リトライ間隔（5秒）

/**
 * エラーが一時的なものかどうかを判定
 */
function isTemporaryError(errorText) {
  const temporaryErrorPatterns = [
    /502/i,
    /503/i,
    /504/i,
    /timeout/i,
    /network/i,
    /connection/i,
    /cloudflare/i,
    /bad gateway/i,
    /service unavailable/i,
  ];
  
  return temporaryErrorPatterns.some(pattern => pattern.test(errorText));
}

/**
 * リトライ可能なリクエストを実行（無限リトライ）
 */
async function fetchWithRetry(url, options) {
  let retryCount = 0;
  
  while (true) {
    try {
      const res = await fetch(url, options);
      
      if (!res.ok) {
        const errText = await res.text();
        
        // 一時的なエラーの場合、5秒待ってリトライ
        if (isTemporaryError(errText)) {
          retryCount++;
          console.error(`\n   ⚠️  一時的なエラー (リトライ ${retryCount}回目): ${errText.substring(0, 100)}...`);
          console.error(`   ⏳ ${RETRY_DELAY / 1000}秒待機してからリトライします...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue; // 無限にリトライ
        }
        
        throw new Error(errText);
      }
      
      // 成功したらリトライカウンターをリセット
      if (retryCount > 0) {
        console.log(`\n   ✅ リトライ成功！処理を続行します。`);
        retryCount = 0;
      }
      
      return res;
    } catch (error) {
      // ネットワークエラーの場合、5秒待ってリトライ
      if (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('ECONNREFUSED')) {
        retryCount++;
        console.error(`\n   ⚠️  ネットワークエラー (リトライ ${retryCount}回目): ${error.message}`);
        console.error(`   ⏳ ${RETRY_DELAY / 1000}秒待機してからリトライします...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        continue; // 無限にリトライ
      }
      
      // 永続的なエラーの場合はスロー
      throw error;
    }
  }
}

async function processTable(tableName, startOffset = 0, model = "text-embedding-3-large", dimensions = 1536, jobId = null, onlyMissing = false) {
  console.log(`\n📊 Processing ${tableName} from offset ${startOffset}...`);
  if (onlyMissing) {
    console.log(`   Mode: 埋め込みベクトルがNULLのレコードのみを処理`);
  }
  console.log(`   Model: ${model}`);
  console.log(`   Dimensions: ${dimensions}`);
  if (jobId) {
    console.log(`   Job ID: ${jobId}`);
  }
  
  const startTime = Date.now();
  let offset = startOffset;
  let hasMore = true;
  let totalProcessed = 0;
  
  // 進捗を保存する関数
  const saveProgress = async (progress) => {
    if (!jobId || !SERVICE_ROLE_KEY) return;
    try {
      const progressData = {
        job_id: jobId,
        status: progress.status || "running",
        table_name: tableName,
        model,
        dimensions,
        start_offset: startOffset,
        current_offset: progress.currentOffset || offset,
        total_processed: progress.totalProcessed || totalProcessed,
        total_count: progress.totalCount || 0,
        percentage: progress.percentage || 0,
        start_time: progress.startTime ? new Date(progress.startTime).toISOString() : new Date(startTime).toISOString(),
        elapsed_minutes: progress.elapsedMinutes ? parseFloat(progress.elapsedMinutes) : null,
        error_message: progress.error || null,
        completed_at: progress.completedAt || null,
      };
      
      // 直接データベースに保存
      await fetch(`${SUPABASE_URL}/rest/v1/embedding_jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "apikey": SERVICE_ROLE_KEY,
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify(progressData),
      }).catch(() => {}); // 失敗しても無視
    } catch (e) {
      // 進捗保存の失敗は無視
    }
  };
  
  while (hasMore) {
    try {
      const res = await fetchWithRetry(`${SUPABASE_URL}/functions/v1/regenerate-embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ANON_KEY}`,
        },
        body: JSON.stringify({
          table: tableName,
          offset,
          limit: BATCH_LIMIT,
          model,
          dimensions,
          onlyMissing: onlyMissing,
        }),
      });
      
      const data = await res.json();
      
      if (data.error) {
        // APIからのエラーレスポンス
        if (isTemporaryError(data.error)) {
          console.error(`   ⚠️  一時的なエラー: ${data.error.substring(0, 100)}...`);
          console.error(`   ⏳ ${RETRY_DELAY / 1000}秒待機してからリトライします...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue; // 同じoffsetでリトライ（無限）
        } else {
          // 永続的なエラーの場合も5秒待ってリトライ
          console.error(`   ⚠️  エラー: ${data.error.substring(0, 100)}...`);
          console.error(`   ⏳ ${RETRY_DELAY / 1000}秒待機してからリトライします...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue; // 同じoffsetでリトライ（無限）
        }
      }
      
      totalProcessed += data.processed;
      // onlyMissingモードでoffset=0が返された場合はリセット
      if (onlyMissing && data.nextOffset === 0 && data.message?.includes("Restart from offset=0")) {
        offset = 0;
        console.log(`\n   🔄 NULLレコードが残っているため、offset=0から再開します`);
      } else {
        offset = data.nextOffset;
      }
      hasMore = data.hasMore;
      
      const pct = data.totalCount > 0 
        ? ((offset / data.totalCount) * 100).toFixed(1)
        : "100";
      
      process.stdout.write(`\r   Progress: ${offset}/${data.totalCount} (${pct}%)`);
      
      // 進捗を保存
      const elapsedMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      await saveProgress({
        status: hasMore ? "running" : "completed",
        startTime: startTime,
        currentOffset: offset,
        totalProcessed,
        totalCount: data.totalCount,
        percentage: parseFloat(pct),
        elapsedMinutes,
        completedAt: !hasMore ? new Date().toISOString() : undefined,
      });
      
      // レート制限を避けるため少し待つ
      await new Promise(r => setTimeout(r, 500));
      
    } catch (error) {
      // すべてのエラーに対して5秒待ってリトライ（無限）
      console.error(`\n   ❌ エラー発生: ${error.message.substring(0, 200)}`);
      console.error(`   ⏳ ${RETRY_DELAY / 1000}秒待機してからリトライします...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
      continue; // 同じoffsetでリトライ（無限）
    }
  }
  
  console.log(`\n   ✅ Completed ${tableName}: ${totalProcessed} rows`);
}

async function main() {
  // 環境変数からパラメータを取得
  const table = process.env.EMBEDDING_TABLE || "dataset_menu_sets";
  const startOffset = parseInt(process.env.EMBEDDING_START_OFFSET || "0", 10);
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-large";
  const dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10);
  const jobId = process.env.EMBEDDING_JOB_ID || null;
  const onlyMissing = process.env.EMBEDDING_ONLY_MISSING === "true";
  
  console.log("🔄 Resuming embedding regeneration");
  if (onlyMissing) {
    console.log("   Mode: 埋め込みベクトルがNULLのレコードのみを処理");
  }
  console.log("   Model: " + model);
  console.log("   Dimensions: " + dimensions);
  console.log("   Auto-retry: Enabled (無限リトライ、間隔: " + RETRY_DELAY / 1000 + "秒)");
  
  const startTime = Date.now();
  
  // 初期進捗を保存
  if (jobId && SERVICE_ROLE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/embedding_jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "apikey": SERVICE_ROLE_KEY,
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          job_id: jobId,
          status: "running",
          table_name: table,
          model,
          dimensions,
          start_offset: startOffset,
          current_offset: startOffset,
          total_processed: 0,
          total_count: 0,
          percentage: 0,
          start_time: new Date().toISOString(),
        }),
      }).catch(() => {});
    } catch (e) {
      // 無視
    }
  }
  
  await processTable(table, startOffset, model, dimensions, jobId, onlyMissing);
  
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n🎉 All done! Total time: ${elapsed} minutes`);
  
  // 完了を保存
  if (jobId && SERVICE_ROLE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/embedding_jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "apikey": SERVICE_ROLE_KEY,
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          job_id: jobId,
          status: "completed",
          completed_at: new Date().toISOString(),
          elapsed_minutes: parseFloat(elapsed),
        }),
      }).catch(() => {});
    } catch (e) {
      // 無視
    }
  }
}

main().catch((error) => {
  console.error("\n❌ 致命的なエラーが発生しました:");
  console.error(error);
  process.exit(1);
});
