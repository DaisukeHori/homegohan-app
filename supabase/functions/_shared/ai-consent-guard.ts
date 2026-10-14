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
  aiConsentDeniedStoredMessageOfResponse,
  runAiConsentCheck,
  type AiConsentDecision,
} from "./ai-consent.ts";
import { fetchWithRetry, getErrorStatus, isRetryableError, type FetchRetryOptions } from "./network-retry.ts";

export type { AiConsentDecision };

/** 判定に使うクライアント (その Edge Function の service role のクライアント) */
export type AiConsentEdgeDb = Pick<SupabaseClient, "from">;

/**
 * 利用者のデータを AI へ送ってよいかを判定する。例外は投げない (失敗は check_failed)。
 * 読む表・列・条件は Next.js 側 (src/lib/ai/consent-guard.ts の checkUserAiConsent) と同じ。
 */
export async function checkAiConsent(
  client: AiConsentEdgeDb,
  userId: string | null | undefined,
): Promise<AiConsentDecision> {
  const decision = await runAiConsentCheck(userId, (id) =>
    client.from(AI_CONSENT_TABLE).select(AI_CONSENT_DECISION_COLUMNS).eq("user_id", id).is("revoked_at", null),
  );
  if (!decision.allowed && decision.reason === "check_failed") {
    // 読めずに止めたことは Edge Function のログで気づけるよう残す (利用者の ID や DB のエラー文は出さない)
    console.warn("[ai-consent-guard] 外国の AI 事業者への提供の同意を読めなかったため、AI へ送らずに止めました");
  }
  return decision;
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

/**
 * fetchWithRetry の失敗 (状態コードと本文を持つ例外) が、呼んだ先の Edge Function が同意の判定で止めたもの
 * (403 AI_CONSENT_REQUIRED / 503 AI_CONSENT_CHECK_FAILED の応答) か。
 */
export function isAiConsentDeniedFetchError(error: unknown): boolean {
  const body = (error as { body?: unknown } | null | undefined)?.body;
  return aiConsentDeniedStoredMessageOfResponse(getErrorStatus(error), body) !== null;
}

/**
 * 献立生成の続きの工程 (generate-menu-v4 / v5 を _continue: true で呼び直す) を呼ぶ。中身は fetchWithRetry と同じ。
 * 続きの工程も送る手前で同意を確かめる (生成の途中で撤回したら、次の工程から止まる) ので、呼んだ先が同意の判定で止めたとき
 * (403 AI_CONSENT_REQUIRED / 503 AI_CONSENT_CHECK_FAILED) は:
 *   - 再試行しない (呼んだ先はリクエストの行をもう失敗にしている。再試行で判定が通ると、失敗にした行のまま生成が進む)
 *   - 例外を投げずに false を返す (呼んだ先が error_message に人向けの文を書いている。投げると、呼ぶ側の catch が
 *     error_message を内部の文 (状態コードや応答の本文) で上書きし、画面にそれが出る)
 * 呼べたら true を返す。それ以外の失敗は fetchWithRetry と同じく例外を投げる。
 */
export async function invokeMenuContinuation(
  input: RequestInfo | URL,
  init: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<boolean> {
  const shouldRetry = opts.shouldRetry ?? isRetryableError;
  try {
    await fetchWithRetry(input, init, {
      ...opts,
      shouldRetry: (error) => !isAiConsentDeniedFetchError(error) && shouldRetry(error),
    });
    return true;
  } catch (error) {
    if (isAiConsentDeniedFetchError(error)) {
      console.warn(
        `[ai-consent-guard] ${opts.label ?? "continuation"}: 続きの工程が同意の判定で止まりました (リクエストは続きの工程が失敗にしています)`,
      );
      return false;
    }
    throw error;
  }
}
