import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { spawn } from "child_process";
import { join } from "path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BATCH_LIMIT = 100;
const RETRY_DELAY = 5000; // リトライ間隔（5秒）

function getServiceClient() {
  return createServiceClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * エラーが一時的なものかどうかを判定
 */
function isTemporaryError(errorText: string): boolean {
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
 * 進捗情報をデータベースに保存
 */
async function saveProgress(progress: any) {
  try {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("embedding_jobs")
      .upsert(
        {
          job_id: progress.jobId,
          status: progress.status,
          table_name: progress.table,
          model: progress.model,
          dimensions: progress.dimensions,
          start_offset: progress.startOffset || 0,
          current_offset: progress.currentOffset || 0,
          total_processed: progress.totalProcessed || 0,
          total_count: progress.totalCount || 0,
          percentage: progress.percentage || 0,
          start_time: progress.startTime ? new Date(progress.startTime).toISOString() : null,
          elapsed_minutes: progress.elapsedMinutes ? parseFloat(progress.elapsedMinutes) : null,
          completed_at: progress.completedAt || null,
          error_message: progress.error || null,
          metadata: progress.metadata || {},
        },
        { onConflict: "job_id" }
      );
    
    if (error) {
      console.error("Failed to save progress to DB:", error);
    }
  } catch (error) {
    console.error("Failed to save progress:", error);
  }
}

/**
 * リトライ可能なリクエストを実行（無限リトライ）
 */
async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  let retryCount = 0;
  
  while (true) {
    try {
      const res = await fetch(url, options);
      
      if (!res.ok) {
        const errText = await res.text();
        
        // 一時的なエラーの場合、5秒待ってリトライ
        if (isTemporaryError(errText)) {
          console.error(`⚠️  一時的なエラー (リトライ ${retryCount + 1}回目): ${errText.substring(0, 100)}...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          retryCount++;
          continue; // 無限にリトライ
        }
        
        throw new Error(errText);
      }
      
      return res;
    } catch (error: any) {
      // ネットワークエラーの場合、5秒待ってリトライ
      if (error.message?.includes('fetch') || error.message?.includes('network') || error.message?.includes('ECONNREFUSED')) {
        retryCount++;
        console.error(`⚠️  ネットワークエラー (リトライ ${retryCount}回目): ${error.message}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        continue; // 無限にリトライ
      }
      
      throw error;
    }
  }
}

async function processTable(
  tableName: string,
  startOffset: number,
  model: string,
  dimensions: number,
  supabaseAnonKey: string,
  jobId: string
): Promise<void> {
  let offset = startOffset;
  let hasMore = true;
  let totalProcessed = 0;
  let totalCount = 0;
  const startTime = Date.now();
  
  // 初期進捗を保存
  await saveProgress({
    jobId,
    status: "running",
    table: tableName,
    model,
    dimensions,
    startOffset,
    startTime,
    currentOffset: offset,
    totalProcessed: 0,
    totalCount: 0,
    percentage: 0,
  });
  
  while (hasMore) {
    try {
      const res = await fetchWithRetry(`${SUPABASE_URL}/functions/v1/regenerate-embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({
          table: tableName,
          offset,
          limit: BATCH_LIMIT,
          model,
          dimensions,
        }),
      });
      
      const data = await res.json();
      
      if (data.error) {
        // APIからのエラーレスポンス
        if (isTemporaryError(data.error)) {
          console.error(`⚠️  一時的なエラー: ${data.error.substring(0, 100)}...`);
          await saveProgress({
            jobId,
            status: "running",
            table: tableName,
            model,
            dimensions,
            startTime,
            currentOffset: offset,
            totalProcessed,
            totalCount,
            percentage: totalCount > 0 ? (offset / totalCount) * 100 : 0,
            error: data.error.substring(0, 200),
          });
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue; // 同じoffsetでリトライ（無限）
        } else {
          // 永続的なエラーの場合も5秒待ってリトライ
          console.error(`⚠️  エラー: ${data.error.substring(0, 100)}...`);
          await saveProgress({
            jobId,
            status: "running",
            table: tableName,
            model,
            dimensions,
            startTime,
            currentOffset: offset,
            totalProcessed,
            totalCount,
            percentage: totalCount > 0 ? (offset / totalCount) * 100 : 0,
            error: data.error.substring(0, 200),
          });
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue; // 同じoffsetでリトライ（無限）
        }
      }
      
      totalProcessed += data.processed;
      offset = data.nextOffset;
      hasMore = data.hasMore;
      totalCount = data.totalCount || 0;
      
      // 進捗を保存
      await saveProgress({
        jobId,
        status: hasMore ? "running" : "completed",
        table: tableName,
        model,
        dimensions,
        startTime,
        currentOffset: offset,
        totalProcessed,
        totalCount,
        percentage: totalCount > 0 ? (offset / totalCount) * 100 : 100,
        elapsedMinutes: ((Date.now() - startTime) / 1000 / 60).toFixed(1),
      });
      
      // レート制限を避けるため少し待つ
      await new Promise(r => setTimeout(r, 500));
      
    } catch (error: any) {
      // すべてのエラーに対して5秒待ってリトライ（無限）
      console.error(`❌ エラー発生: ${error.message?.substring(0, 200)}`);
      await saveProgress({
        jobId,
        status: "running",
        table: tableName,
        model,
        dimensions,
        startTime,
        currentOffset: offset,
        totalProcessed,
        totalCount,
        percentage: totalCount > 0 ? (offset / totalCount) * 100 : 0,
        error: error.message?.substring(0, 200),
      });
      await new Promise(r => setTimeout(r, RETRY_DELAY));
      continue; // 同じoffsetでリトライ（無限）
    }
  }
  
  // 完了を保存
  await saveProgress({
    jobId,
    status: "completed",
    table: tableName,
    model,
    dimensions,
    startTime,
    currentOffset: offset,
    totalProcessed,
    totalCount,
    percentage: 100,
    elapsedMinutes: ((Date.now() - startTime) / 1000 / 60).toFixed(1),
    completedAt: new Date().toISOString(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    
    // 認証確認
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    // Super Admin権限確認
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("roles")
      .eq("id", user.id)
      .single();
    
    const roles = profile?.roles || [];
    if (!roles.includes("super_admin")) {
      return NextResponse.json({ error: "Forbidden: Super admin access required" }, { status: 403 });
    }
    
    const body = await request.json();
    const { table, startOffset = 0, model = "text-embedding-3-large", dimensions = 1536, onlyMissing = true } = body;
    
    if (!table || !["dataset_ingredients", "dataset_recipes", "dataset_menu_sets"].includes(table)) {
      return NextResponse.json(
        { error: "Invalid table. Use: dataset_ingredients, dataset_recipes, or dataset_menu_sets" },
        { status: 400 }
      );
    }
    
    // モデルと次元のバリデーション
    const validModels = ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"];
    if (!validModels.includes(model)) {
      return NextResponse.json(
        { error: `Invalid model. Use: ${validModels.join(", ")}` },
        { status: 400 }
      );
    }
    
    // モデルごとの有効な次元をチェック
    const modelDimensions: Record<string, number[]> = {
      "text-embedding-3-small": [512, 1536],
      "text-embedding-3-large": [256, 1024, 3072],
      "text-embedding-ada-002": [1536],
    };
    
    const validDimensions = modelDimensions[model] || [];
    if (!validDimensions.includes(dimensions)) {
      return NextResponse.json(
        { error: `Invalid dimensions for ${model}. Use: ${validDimensions.join(", ")}` },
        { status: 400 }
      );
    }
    
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const jobId = `embedding-${table}-${Date.now()}`;
    
    // スクリプトを別プロセスで実行
    const scriptPath = join(process.cwd(), "scripts", "resume-embedding-regeneration.mjs");
    const env = {
      ...process.env,
      EMBEDDING_TABLE: table,
      EMBEDDING_START_OFFSET: startOffset.toString(),
      EMBEDDING_MODEL: model,
      EMBEDDING_DIMENSIONS: dimensions.toString(),
      EMBEDDING_JOB_ID: jobId,
      EMBEDDING_ONLY_MISSING: onlyMissing ? "true" : "false",
      SUPABASE_URL: SUPABASE_URL,
      SUPABASE_ANON_KEY: supabaseAnonKey,
      SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_ROLE_KEY,
    };
    
    // バックグラウンドでスクリプトを実行
    const child = spawn("node", [scriptPath], {
      env,
      detached: true,
      stdio: "ignore",
    });
    
    child.unref(); // 親プロセスが終了しても子プロセスを続行
    
    // 初期進捗を保存
    await saveProgress({
      jobId,
      status: "running",
      table,
      model,
      dimensions,
      startOffset,
      startTime: Date.now(),
      currentOffset: startOffset,
      totalProcessed: 0,
      totalCount: 0,
      percentage: 0,
    });
    
    return NextResponse.json({
      success: true,
      message: `埋め込み再生成を開始しました`,
      jobId,
      table,
      model,
      dimensions,
      startOffset,
    });
    
  } catch (error: any) {
    console.error("Error starting embedding regeneration:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
