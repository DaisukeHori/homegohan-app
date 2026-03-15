import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function getServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createServiceClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET() {
  try {
    const userClient = await createClient();
    const { data: { user }, error: userError } = await userClient.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await userClient
      .from("user_profiles")
      .select("roles")
      .eq("id", user.id)
      .single();

    if (!profile?.roles?.includes("super_admin")) {
      return NextResponse.json({ error: "Forbidden: Super admin access required" }, { status: 403 });
    }

    const serviceClient = getServiceClient();
    if (!serviceClient) {
      return NextResponse.json({
        status: "idle",
        message: "SUPABASE_SERVICE_ROLE_KEY が未設定のため進捗を取得できません",
      });
    }
    
    // 最新のジョブを取得
    const { data, error } = await serviceClient
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
