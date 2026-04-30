/**
 * generate-hint Edge Function
 *
 * ユーザーの食事データを受け取り、AI がパーソナライズされたヒントを生成する。
 * 生成結果は user_hints テーブルに保存される（既存なら上書き）。
 *
 * 認証: Supabase JWT (Authorization: Bearer <token>)
 */

import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { createLogger, generateRequestId } from "../_shared/db-logger.ts";
import { createFastLLMClient, getFastLLMModel } from "../_shared/fast-llm.ts";

const openai = createFastLLMClient();

interface HintRequest {
  userId?: string;
  cookRate?: number;
  avgCal?: number;
  cookCount?: number;
  buyCount?: number;
  outCount?: number;
  expiringItems?: string[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // JWT 認証
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) {
    return new Response(authResult.body, {
      status: authResult.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { userId } = authResult;

  const requestId = generateRequestId();
  const logger = createLogger("generate-hint", requestId).withUser(userId);

  try {
    const body = (await req.json().catch(() => ({}))) as HintRequest;

    const cookRate = typeof body.cookRate === "number" ? body.cookRate : 0;
    const avgCal = typeof body.avgCal === "number" ? body.avgCal : 0;
    const cookCount = typeof body.cookCount === "number" ? body.cookCount : 0;
    const buyCount = typeof body.buyCount === "number" ? body.buyCount : 0;
    const outCount = typeof body.outCount === "number" ? body.outCount : 0;
    const expiringItems = Array.isArray(body.expiringItems) ? body.expiringItems : [];

    logger.info("Generating hint", {
      cookRate,
      avgCal,
      cookCount,
      buyCount,
      outCount,
      expiringCount: expiringItems.length,
    });

    const expiringText = expiringItems.length > 0
      ? `期限間近の食材: ${expiringItems.slice(0, 5).join("、")}`
      : "期限間近の食材: なし";

    const prompt = `あなたは健康的な食生活をサポートするアドバイザーです。
以下のユーザーの食事データを見て、短く（1〜2文）励ましと具体的なアドバイスを日本語で提供してください。

【今週の食事データ】
- 自炊率: ${cookRate}%
- 平均カロリー: ${avgCal > 0 ? `${avgCal}kcal/日` : "記録なし"}
- 自炊回数: ${cookCount}回
- 買い弁当/テイクアウト回数: ${buyCount}回
- 外食回数: ${outCount}回
- ${expiringText}

ヒントはポジティブなトーンで、具体的で実践しやすい内容にしてください。
JSON形式で {"hint": "..."} のみ出力してください。`;

    const response = await openai.chat.completions.create({
      model: getFastLLMModel(),
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      response_format: { type: "json_object" },
    } as any);

    const result = JSON.parse(response.choices[0].message.content || '{"hint": ""}');
    const hint = typeof result.hint === "string" && result.hint.trim()
      ? result.hint.trim()
      : getFallbackHint(cookRate, avgCal, expiringItems);

    // user_hints テーブルへ保存（テーブルが存在する場合のみ）
    try {
      const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_JWT") ?? "",
        { auth: { persistSession: false, autoRefreshToken: false } },
      );

      await supabaseAdmin
        .from("user_hints")
        .upsert(
          {
            user_id: userId,
            hint,
            generated_at: new Date().toISOString(),
            metadata_json: {
              cookRate,
              avgCal,
              cookCount,
              buyCount,
              outCount,
              expiringItemCount: expiringItems.length,
            },
          },
          { onConflict: "user_id" },
        );
    } catch (dbErr) {
      // DB 保存失敗はログのみ（レスポンスには影響しない）
      logger.warn("Failed to save hint to DB", { error: String(dbErr) });
    }

    logger.info("Hint generated successfully");

    return new Response(JSON.stringify({ hint }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error: any) {
    logger.error("Error generating hint", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});

function getFallbackHint(cookRate: number, avgCal: number, expiringItems: string[]): string {
  if (expiringItems.length > 0) {
    return `${expiringItems.slice(0, 2).join("・")}が期限間近です。今日の献立に取り入れてみましょう！`;
  }
  if (cookRate >= 80) return "自炊率80%以上！素晴らしいですね。引き続き健康的な食生活を続けましょう。";
  if (cookRate >= 60) return `自炊率${cookRate}%、好調です！週末の作り置きでさらに楽になりますよ。`;
  if (avgCal > 2500) return "カロリーが少し高めです。野菜を一品追加してバランスを整えましょう。";
  return "今週も健康的な食事を心がけましょう！小さな積み重ねが大切です。";
}
