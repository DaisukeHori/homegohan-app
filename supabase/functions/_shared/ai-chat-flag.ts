/**
 * AI 相談の緊急停止スイッチ (feature_flags の ai_chat_enabled) を、Edge Function で判定する (#1486)
 *
 * Next.js の AI 相談の API (/api/ai/consultation/**) は、src/lib/ai/ai-chat-gate.ts でこのスイッチを見る。
 * ところが Edge Function knowledge-gpt は、利用者の JWT で直接呼べる (#1153。config.toml の verify_jwt=false。
 * Supabase の URL と anon key は公開されている)。Next.js だけで止めても、knowledge-gpt を直接呼べば AI 相談を使えてしまうので、
 * JWT の経路でもここでスイッチを見る (service role の経路は、呼び出し元の Next.js が見たあと)。
 *
 * 判定は Next.js の isFeatureEnabled (src/lib/feature-flags.ts) と同じにする:
 *   - 行があれば、段階公開・条件まで含めて判定する (_shared/feature-flag-eval.ts。Next.js と共用)
 *   - 行が無い・読み出しに失敗した・待ちきれなかったときは ON (止めない側。FEATURE_FLAG_DEFAULTS.ai_chat_enabled と同じ)。
 *     読めないときに止めないのは、フラグの仕組みの不調で AI 相談を止めないため。同意の判定と 1 日の上限は、このあとで別に効く
 *   - 判定にユーザーの属性 (プラン・ロール・組織・作成日) が要るときだけ、user_profiles の本人の 1 行を読む
 *     (読めなければ ON。Next.js が属性の読み出しに失敗したときと同じ)
 * Next.js と違い、値をメモリに覚えない (呼ばれるたびに読む)。そのため、運営画面で切り替えると、次の呼び出しから効く。
 *
 * 止めたときの応答は Next.js と同じ: 503 { error: <文>, code: 'AI_CHAT_DISABLED', retryAfter } (Retry-After 付き)。
 * 文と code は packages/shared/src/service-unavailable.ts と同じ値 (Edge Functions は packages/shared を import しないので、ここにも置く。
 * 一致は tests/ai-chat-flag-edge.test.ts が確かめる)。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateFlagRule,
  requiredFlagContextFields,
  type FlagRuleRecord,
  type FlagUserContext,
} from "./feature-flag-eval.ts";

/** AI 相談の緊急停止スイッチの key (src/lib/ai/ai-chat-gate.ts の AI_CHAT_FLAG_KEY と同じ) */
export const AI_CHAT_FLAG_KEY = "ai_chat_enabled";
/** 行が無い・読めないときの値 (src/lib/feature-flags.ts の FEATURE_FLAG_DEFAULTS.ai_chat_enabled と同じ。止めない側) */
export const AI_CHAT_FLAG_FALLBACK = true;
/** 止めたときの code (packages/shared の AI_CHAT_DISABLED_CODE と同じ) */
export const AI_CHAT_DISABLED_CODE = "AI_CHAT_DISABLED";
/** 止めたときの文 (packages/shared の AI_CHAT_DISABLED_MESSAGE と同じ) */
export const AI_CHAT_DISABLED_MESSAGE =
  "AI相談は現在、一時的にご利用いただけません。しばらくしてから、もう一度お試しください。";
/** 止めたときの HTTP の状態 (packages/shared の SERVICE_UNAVAILABLE_STATUS と同じ) */
export const AI_CHAT_DISABLED_STATUS = 503;
/** クライアントに「このくらいあとで試して」と伝える目安 (秒。src/lib/ai/ai-chat-gate.ts の AI_CHAT_RETRY_AFTER_SECONDS と同じ) */
export const AI_CHAT_RETRY_AFTER_SECONDS = 60;
/**
 * フラグ (と、要るときのユーザーの属性) の読み出しを待つ上限 (ms)。超えたら ON として通す。
 * src/lib/feature-flags.ts の FEATURE_FLAG_READ_TIMEOUT_MS と同じ値 (DB が遅いときに、AI 相談の応答を待たせ続けない)
 */
export const AI_CHAT_FLAG_READ_TIMEOUT_MS = 1_500;

/** 判定に使うクライアント (service role。feature_flags は super_admin 限定の RLS なので、利用者の JWT では読めない) */
export type AiChatFlagDb = Pick<SupabaseClient, "from">;

const FLAG_COLUMNS = "key, enabled, rollout_strategy, constraints";
const PROFILE_COLUMNS = "roles, organization_id, plan_key_cached, created_at";
/** plan_key_cached が空のユーザーのプラン (src/lib/feature-flags.ts の loadUserContext と同じ) */
const DEFAULT_PLAN_KEY = "free";

/** 待ちきれなかったことを表す値 */
const TIMED_OUT = Symbol("timed-out");

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 止めない側に倒したことをログに残す (利用者の ID や DB のエラー文は出さない) */
function warnFallback(reason: string): void {
  console.warn(`[ai-chat-flag] AI 相談の緊急停止スイッチを判定できなかったため、ON として扱いました (${reason})`);
}

/** userId 本人の属性 (判定に要るときだけ読む)。読めなければ null */
async function loadUserContext(
  client: AiChatFlagDb,
  userId: string,
  timeoutMs: number,
): Promise<FlagUserContext | null> {
  const read = await withTimeout(
    client.from("user_profiles").select(PROFILE_COLUMNS).eq("id", userId).maybeSingle(),
    timeoutMs,
  );
  if (read === TIMED_OUT) {
    warnFallback("ユーザーの属性の読み出しの待ちきれず");
    return null;
  }
  if (read.error) {
    warnFallback("ユーザーの属性の読み出しの失敗");
    return null;
  }
  const row = (read.data ?? null) as {
    roles?: unknown;
    organization_id?: string | null;
    plan_key_cached?: string | null;
    created_at?: string | null;
  } | null;
  return {
    userId,
    roles: Array.isArray(row?.roles) ? (row.roles as string[]) : [],
    organizationId: row?.organization_id ?? null,
    planKey: row?.plan_key_cached ?? DEFAULT_PLAN_KEY,
    accountCreatedAt: row?.created_at ?? null,
  };
}

/**
 * ai_chat_enabled が、このユーザーにとって ON か。例外は投げない (読めないときは ON)。
 * @param client service role のクライアント
 * @param userId JWT から確かめた本人の ID
 */
export async function isAiChatEnabledForUser(
  client: AiChatFlagDb,
  userId: string,
  timeoutMs: number = AI_CHAT_FLAG_READ_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const read = await withTimeout(
      client.from("feature_flags").select(FLAG_COLUMNS).eq("key", AI_CHAT_FLAG_KEY).maybeSingle(),
      timeoutMs,
    );
    if (read === TIMED_OUT) {
      warnFallback("フラグの読み出しの待ちきれず");
      return AI_CHAT_FLAG_FALLBACK;
    }
    if (read.error) {
      warnFallback("フラグの読み出しの失敗");
      return AI_CHAT_FLAG_FALLBACK;
    }
    const record = (read.data ?? null) as FlagRuleRecord | null;
    // 行が無いときは既定値 (ON)。evaluateFlagRule は行が無いと OFF と答えるので、ここで先に分ける
    if (record === null) return AI_CHAT_FLAG_FALLBACK;

    if (requiredFlagContextFields(record).length === 0) {
      return evaluateFlagRule(record, { userId });
    }
    const context = await loadUserContext(client, userId, timeoutMs);
    if (context === null) return AI_CHAT_FLAG_FALLBACK;
    return evaluateFlagRule(record, context);
  } catch {
    warnFallback("判定の例外");
    return AI_CHAT_FLAG_FALLBACK;
  }
}

/** 止めたときの応答 (503 AI_CHAT_DISABLED。Next.js の aiChatDisabledResponse と同じ本文とヘッダー) */
export function aiChatDisabledEdgeResponse(headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      error: AI_CHAT_DISABLED_MESSAGE,
      code: AI_CHAT_DISABLED_CODE,
      retryAfter: AI_CHAT_RETRY_AFTER_SECONDS,
    }),
    {
      status: AI_CHAT_DISABLED_STATUS,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Retry-After": String(AI_CHAT_RETRY_AFTER_SECONDS),
        "Cache-Control": "private, no-store",
      },
    },
  );
}

/**
 * 利用者の JWT で直接呼ばれた経路で、認証の直後 (同意の判定の前) に呼ぶ。止めるなら応答、通すなら null。
 * 判定のためだけに service role のクライアントを作り、feature_flags (と、要るときは本人の user_profiles) を読む。
 * 環境変数が無いときは判定できないので、止めない (ON。同意の判定がこのあとで fail-closed に止める)。
 *
 *   const aiChatDisabled = await aiChatDisabledResponseForUser(user.id, corsHeaders);
 *   if (aiChatDisabled) return aiChatDisabled;
 */
export async function aiChatDisabledResponseForUser(
  userId: string,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    warnFallback("環境変数が無い");
    return null;
  }
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return (await isAiChatEnabledForUser(client, userId)) ? null : aiChatDisabledEdgeResponse(headers);
}
