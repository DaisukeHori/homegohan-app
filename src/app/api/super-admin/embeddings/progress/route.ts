import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function getServiceClient() {
  return createServiceClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

export async function GET() {
  try {
    const supabase = getServiceClient();
    
    // 最新のジョブを取得
    const { data, error } = await supabase
      .from("embedding_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    
    if (error) {
      if (error.code === "PGRST116") {
        // レコードが見つからない
        return NextResponse.json({
          status: "idle",
          message: "処理が実行されていません",
        });
      }
      throw error;
    }
    
    // データベースの形式をAPIレスポンス形式に変換
    return NextResponse.json({
      jobId: data.job_id,
      status: data.status,
      table: data.table_name,
      model: data.model,
      dimensions: data.dimensions,
      startOffset: data.start_offset,
      currentOffset: data.current_offset,
      totalProcessed: data.total_processed,
      totalCount: data.total_count,
      percentage: data.percentage,
      startTime: data.start_time ? new Date(data.start_time).getTime() : undefined,
      elapsedMinutes: data.elapsed_minutes?.toString(),
      error: data.error_message,
      completedAt: data.completed_at,
    });
  } catch (error: any) {
    console.error("Failed to fetch progress:", error);
    return NextResponse.json(
      { error: error.message || "Failed to read progress" },
      { status: 500 }
    );
  }
}
