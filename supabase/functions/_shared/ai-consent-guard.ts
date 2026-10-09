/**
 * 外国の AI 事業者への提供の同意: Edge Functions 側の「送る手前で止める」部品 (T15 / #1154)
 *
 * Edge Functions は、利用者の JWT で直接呼ばれることがある (Supabase の URL と anon key は公開されている)。
 * Next.js の API Route だけで止めても、Edge Function を直接呼べば AI へ送れてしまうので、
 * 利用者のデータを AI へ送る Edge Function は、送る手前でここを呼ぶ。
 * 判定の本体は Next.js と共用の ./ai-consent.ts (runAiConsentCheck / decideAiConsent)。ここはクエリと、止めたときの応答を作るだけ。
 *
 * client には、その Edge Function が持っている service role のクライアントを渡す
 * (userId で絞って読む。userId は JWT から確かめた本人か、service role の呼び出し元が渡した本人)。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AI_CONSENT_DECISION_COLUMNS,
  AI_CONSENT_TABLE,
  aiConsentDeniedPayload,
  runAiConsentCheck,
  type AiConsentDecision,
} from "./ai-consent.ts";

export type { AiConsentDecision };

/** 判定に使うクライアント (その Edge Function の service role のクライアント) */
export type AiConsentEdgeDb = Pick<SupabaseClient, "from">;

/**
 * 利用者のデータを AI へ送ってよいかを判定する。例外は投げない (失敗は check_failed)。
 * 読む表・列・条件は Next.js 側 (src/lib/ai/consent-guard.ts の checkUserAiConsent) と同じ。
 */
export function checkAiConsent(client: AiConsentEdgeDb, userId: string | null | undefined): Promise<AiConsentDecision> {
  return runAiConsentCheck(userId, (id) =>
    client.from(AI_CONSENT_TABLE).select(AI_CONSENT_DECISION_COLUMNS).eq("user_id", id).is("revoked_at", null),
  );
}

/** 止めたときの応答 (403 AI_CONSENT_REQUIRED / 503 AI_CONSENT_CHECK_FAILED) */
export function aiConsentDeniedResponse(
  decision: Extract<AiConsentDecision, { allowed: false }>,
  headers: Record<string, string> = {},
): Response {
  const { status, body } = aiConsentDeniedPayload(decision);
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

/**
 * 送る手前で呼ぶ。送ってよければ null、止めるなら応答を返す。
 *
 *   const denied = await requireAiConsent(supabaseAdmin, userId, corsHeaders);
 *   if (denied) return denied;
 */
export async function requireAiConsent(
  client: AiConsentEdgeDb,
  userId: string | null | undefined,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const decision = await checkAiConsent(client, userId);
  return decision.allowed ? null : aiConsentDeniedResponse(decision, headers);
}

/**
 * service role のクライアントを持っていない Edge Function (requireAuth で本人を確かめるだけのもの) のための形。
 * 判定のためだけに service role のクライアントを作り、userId (requireAuth が JWT から確かめた本人) で絞って読む。
 * 環境変数が無いときは判定できないので止める (check_failed)。
 */
export function requireAiConsentForUser(
  userId: string | null | undefined,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    return Promise.resolve(aiConsentDeniedResponse({ allowed: false, reason: "check_failed" }, headers));
  }
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return requireAiConsent(client, userId, headers);
}
