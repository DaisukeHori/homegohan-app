import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// 静的生成を無効にして動的ルートとして扱う
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    
    // 認証チェック
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // super_admin権限チェック
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("roles")
      .eq("id", user.id)
      .single();

    const roles = profile?.roles || [];
    if (!roles.includes("super_admin")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d"; // 1d, 7d, 30d, 90d
    const groupBy = searchParams.get("groupBy") || "function"; // function, user, model, hour

    // 期間に応じた日付範囲を計算
    const now = new Date();
    let startDate: Date;
    switch (period) {
      case "1d":
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "30d":
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case "90d":
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default: // 7d
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // 総合統計
    const { data: totalStats, error: totalError } = await supabase
      .from("llm_usage_logs")
      .select("input_tokens, output_tokens, total_tokens, estimated_cost_usd, duration_ms")
      .gte("created_at", startDate.toISOString())
      .eq("is_summary", false);

    if (totalError) throw totalError;

    const summary = {
      totalCalls: totalStats?.length || 0,
      totalInputTokens: totalStats?.reduce((sum, r) => sum + (r.input_tokens || 0), 0) || 0,
      totalOutputTokens: totalStats?.reduce((sum, r) => sum + (r.output_tokens || 0), 0) || 0,
      totalTokens: totalStats?.reduce((sum, r) => sum + (r.total_tokens || 0), 0) || 0,
      totalCost: totalStats?.reduce((sum, r) => sum + Number(r.estimated_cost_usd || 0), 0) || 0,
      avgDuration: totalStats?.length 
        ? totalStats.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / totalStats.length 
        : 0,
    };

    // 関数別集計
    const { data: byFunction, error: funcError } = await supabase
      .rpc("aggregate_llm_usage_by_function", { start_date: startDate.toISOString() });

    // ユーザー別集計（上位20）
    const { data: byUser, error: userError } = await supabase
      .rpc("aggregate_llm_usage_by_user", { start_date: startDate.toISOString(), limit_count: 20 });

    // モデル別集計
    const { data: byModel, error: modelError } = await supabase
      .rpc("aggregate_llm_usage_by_model", { start_date: startDate.toISOString() });

    // 時系列データ（日別または時間別）
    const { data: timeSeries, error: timeError } = await supabase
      .rpc("aggregate_llm_usage_by_time", { 
        start_date: startDate.toISOString(),
        time_bucket: period === "1d" ? "hour" : "day"
      });

    // エラーがあればフォールバック（RPC未作成の場合）
    let functionData = byFunction;
    let userData = byUser;
    let modelData = byModel;
    let timeData = timeSeries;

    // RPCが未作成の場合のフォールバック処理
    if (funcError) {
      const { data: rawData } = await supabase
        .from("llm_usage_logs")
        .select("function_name, input_tokens, output_tokens, total_tokens, estimated_cost_usd, duration_ms")
        .gte("created_at", startDate.toISOString())
        .eq("is_summary", false);

      const grouped = new Map<string, { calls: number; input: number; output: number; total: number; cost: number; duration: number }>();
      rawData?.forEach(r => {
        const key = r.function_name;
        const existing = grouped.get(key) || { calls: 0, input: 0, output: 0, total: 0, cost: 0, duration: 0 };
        existing.calls++;
        existing.input += r.input_tokens || 0;
        existing.output += r.output_tokens || 0;
        existing.total += r.total_tokens || 0;
        existing.cost += Number(r.estimated_cost_usd || 0);
        existing.duration += r.duration_ms || 0;
        grouped.set(key, existing);
      });
      functionData = Array.from(grouped.entries()).map(([name, stats]) => ({
        function_name: name,
        call_count: stats.calls,
        total_input_tokens: stats.input,
        total_output_tokens: stats.output,
        total_tokens: stats.total,
        total_cost: stats.cost,
        avg_duration: stats.calls ? stats.duration / stats.calls : 0,
      })).sort((a, b) => b.total_tokens - a.total_tokens);
    }

    if (userError) {
      const { data: rawData } = await supabase
        .from("llm_usage_logs")
        .select("user_id, input_tokens, output_tokens, total_tokens, estimated_cost_usd")
        .gte("created_at", startDate.toISOString())
        .eq("is_summary", false)
        .not("user_id", "is", null);

      const grouped = new Map<string, { calls: number; total: number; cost: number }>();
      rawData?.forEach(r => {
        if (!r.user_id) return;
        const key = r.user_id;
        const existing = grouped.get(key) || { calls: 0, total: 0, cost: 0 };
        existing.calls++;
        existing.total += r.total_tokens || 0;
        existing.cost += Number(r.estimated_cost_usd || 0);
        grouped.set(key, existing);
      });
      userData = Array.from(grouped.entries())
        .map(([userId, stats]) => ({
          user_id: userId,
          call_count: stats.calls,
          total_tokens: stats.total,
          total_cost: stats.cost,
        }))
        .sort((a, b) => b.total_tokens - a.total_tokens)
        .slice(0, 20);
    }

    if (modelError) {
      const { data: rawData } = await supabase
        .from("llm_usage_logs")
        .select("model, input_tokens, output_tokens, total_tokens, estimated_cost_usd")
        .gte("created_at", startDate.toISOString())
        .eq("is_summary", false);

      const grouped = new Map<string, { calls: number; input: number; output: number; total: number; cost: number }>();
      rawData?.forEach(r => {
        const key = r.model;
        const existing = grouped.get(key) || { calls: 0, input: 0, output: 0, total: 0, cost: 0 };
        existing.calls++;
        existing.input += r.input_tokens || 0;
        existing.output += r.output_tokens || 0;
        existing.total += r.total_tokens || 0;
        existing.cost += Number(r.estimated_cost_usd || 0);
        grouped.set(key, existing);
      });
      modelData = Array.from(grouped.entries()).map(([name, stats]) => ({
        model: name,
        call_count: stats.calls,
        total_input_tokens: stats.input,
        total_output_tokens: stats.output,
        total_tokens: stats.total,
        total_cost: stats.cost,
      })).sort((a, b) => b.total_tokens - a.total_tokens);
    }

    if (timeError) {
      const { data: rawData } = await supabase
        .from("llm_usage_logs")
        .select("created_at, total_tokens, estimated_cost_usd")
        .gte("created_at", startDate.toISOString())
        .eq("is_summary", false)
        .order("created_at", { ascending: true });

      const bucket = period === "1d" ? "hour" : "day";
      const grouped = new Map<string, { tokens: number; cost: number; calls: number }>();
      
      rawData?.forEach(r => {
        const date = new Date(r.created_at);
        const key = bucket === "hour" 
          ? `${date.toISOString().slice(0, 13)}:00`
          : date.toISOString().slice(0, 10);
        const existing = grouped.get(key) || { tokens: 0, cost: 0, calls: 0 };
        existing.tokens += r.total_tokens || 0;
        existing.cost += Number(r.estimated_cost_usd || 0);
        existing.calls++;
        grouped.set(key, existing);
      });

      timeData = Array.from(grouped.entries()).map(([time, stats]) => ({
        time_bucket: time,
        total_tokens: stats.tokens,
        total_cost: stats.cost,
        call_count: stats.calls,
      }));
    }

    return NextResponse.json({
      period,
      summary,
      byFunction: functionData || [],
      byUser: userData || [],
      byModel: modelData || [],
      timeSeries: timeData || [],
    });
  } catch (error) {
    console.error("LLM usage API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
