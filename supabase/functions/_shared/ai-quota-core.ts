/**
 * AI 利用回数の記録 (#1177 / T26) の共通部分 - Next.js API Routes / Supabase Edge Functions 共用
 *
 * 使うのは次の 2 か所で、どちらもこのファイルの定義を読む (二つに分かれて食い違わないようにするため)。
 *  - Next.js:        src/lib/plan/entitlements.ts (API ルートが consumeAiQuota を呼ぶ)
 *  - Edge Functions: supabase/functions/_shared/quota.ts (ユーザーの JWT で直接呼ばれたときに数える)
 *
 * ここにあるのは次の 4 つ。
 *  1. 回数を数える機能の一覧 (AI_FEATURES)。DB の ai_usage_counters.feature に入る名前
 *  2. DB の consume_ai_quota の戻り値 (jsonb) の読み取り (parseAiQuotaResult)
 *  3. 上限を超えたときの 429 の本文 (aiQuotaErrorBody)
 *  4. 「Next.js が数え済み」であることを示す署名つきの印 (signAiQuotaCounted / verifyAiQuotaCounted)
 *
 * 【数え済みの印】
 * Next.js の API ルートが 1 回と数えたあとに、Edge Function をユーザー自身の JWT で呼ぶ処理がある
 * (写真解析・AI 相談の献立生成)。Edge Function 側も「ユーザーの JWT で直接呼ばれたとき」に数えるので、
 * 何もしないと同じ操作を 2 回数えてしまう。それを避けるため、Next.js は Edge Function を呼ぶときに、
 * 数え済みであることを示す署名つきのヘッダーを付ける。
 *   x-hg-ai-quota-counted: v1.<UNIX 秒>.<HMAC-SHA256 (hex)>
 *   署名の対象は `v1.<ユーザー ID>.<UNIX 秒>`。鍵は service role key (Next.js と Edge Function だけが持つ)。
 * Edge Function は同じ鍵で署名を確かめ (5 分以内・ユーザー ID が JWT のものと一致)、合えば数えない。
 * ブラウザやモバイルアプリはこの鍵を持たないので、自分でこのヘッダーを付けて数えさせないことはできない
 * (付けても署名が合わず、数えられる)。署名を確かめられなかった場合は数える側に倒す (二重に数えるだけで、AI の利用は止まらない)。
 * service role key で Edge Function を呼ぶ処理 (献立生成のキュー・AI 相談・買い物リスト) は、
 * Edge Function 側がそもそも数えない (ユーザーの JWT のときだけ数える) ので、印は要らない。
 *
 * このファイルが守る制約 (崩すと Edge Functions か Next.js のどちらかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node 固有の API なし (環境変数は呼び出し側が読んで渡す)。
 *    使うのは Web 標準の crypto.subtle と TextEncoder だけ (cron-secret.ts と同じ)。
 *    Next.js 側は src/lib/plan/entitlements.ts が相対パスで import する。
 */

/**
 * 回数を数える機能 (ai_usage_counters.feature)。内訳の集計用で、上限は機能ごとには持たない。
 * 名前は DB の CHECK (小文字の英字で始まり、小文字・数字・アンダースコアだけ、64 文字まで) に合わせる。
 */
export const AI_FEATURES = [
  /** 献立生成 (週間・1 日・1 食・作り直し・キュー・栄養分析からの献立変更) */
  "menu_generation",
  /** AI 相談 (チャット・要約・アクションの実行) */
  "consultation",
  /** 写真の解析 (冷蔵庫・食事・健診・体重計・写真の判別・栄養の画像解析) */
  "photo_analysis",
  /** 栄養のアドバイス・フィードバック・ヒント */
  "nutrition_advice",
  /** 健康診断・血液検査のレビュー、健康インサイト */
  "health_review",
  /** 買い物リストの AI による再生成・正規化 */
  "shopping_list",
  /** 画像の生成 (料理画像を含む) */
  "image_generation",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

export type AiQuotaLimitKind = "daily" | "monthly";

export interface AiQuotaResult {
  /** 使ってよいか。上限が無い (いまは全プラン) か、記録に失敗したときは true */
  allowed: boolean;
  /** 残り回数。上限が無い (無制限) ときは null */
  remaining: number | null;
  /** 拒否のとき、超えた上限の種類 */
  limitKind?: AiQuotaLimitKind;
  /** 拒否のとき、超えた上限の値 */
  limit?: number;
  /** 拒否のとき、回数が戻る時刻 (UTC, ISO 8601) */
  resetAt?: string;
  planKey?: string;
  /** Edge Function だけ: Next.js が数え済みの呼び出しだったので数えなかった */
  skipped?: boolean;
}

/** 429 の本文の code。上限を超えたときだけ返る (いまは通らない)。レート制限の 429 (code: RATE_LIMITED) とは区別する */
export const AI_QUOTA_ERROR_CODES: Record<AiQuotaLimitKind, string> = {
  daily: "AI_DAILY_LIMIT",
  monthly: "AI_MONTHLY_LIMIT",
};

/** consume_ai_quota の応答を待つ上限 (ミリ秒)。超えたら、許可して先へ進む (止めない) */
export const AI_QUOTA_TIMEOUT_MS = 3000;

/**
 * consume_ai_quota の戻り値 (jsonb) を読む。想定外の形なら例外を投げる (呼び出し側が記録して許可にする)。
 *   許可: {allowed: true,  remaining: <数 | null>, plan_key}
 *   拒否: {allowed: false, remaining: 0, plan_key, limit_kind, limit, reset_at}
 */
export function parseAiQuotaResult(raw: unknown): AiQuotaResult {
  if (!raw || typeof raw !== "object") throw new Error("consume_ai_quota returned an unexpected value");
  const row = raw as Record<string, unknown>;
  if (typeof row.allowed !== "boolean") throw new Error("consume_ai_quota: allowed is missing");
  if (row.remaining !== null && row.remaining !== undefined && typeof row.remaining !== "number") {
    throw new Error("consume_ai_quota: remaining is invalid");
  }

  const result: AiQuotaResult = {
    allowed: row.allowed,
    remaining: typeof row.remaining === "number" ? row.remaining : null,
  };
  if (typeof row.plan_key === "string") result.planKey = row.plan_key;
  if (row.limit_kind === "daily" || row.limit_kind === "monthly") result.limitKind = row.limit_kind;
  if (typeof row.limit === "number") result.limit = row.limit;
  if (typeof row.reset_at === "string") result.resetAt = row.reset_at;
  return result;
}

export interface AiQuotaErrorBody {
  error: string;
  code: string;
  limit?: number;
  resetAt?: string;
  retryAfter?: number;
}

/**
 * 上限を超えたときの 429 の本文と、Retry-After の秒数 (回数が戻る時刻が分かるときだけ)。
 * Next.js (NextResponse) と Edge Function (Response) の両方が、これを使って同じ形の応答を返す。
 */
export function aiQuotaErrorBody(
  result: AiQuotaResult,
  nowMs: number = Date.now(),
): { body: AiQuotaErrorBody; retryAfterSec: number | undefined } {
  const kind: AiQuotaLimitKind = result.limitKind === "monthly" ? "monthly" : "daily";
  const error = kind === "monthly"
    ? "今月の AI の利用回数の上限に達しました。来月になるとまた使えます。"
    : "本日の AI の利用回数の上限に達しました。明日になるとまた使えます。";

  const resetAtMs = result.resetAt ? Date.parse(result.resetAt) : NaN;
  const retryAfterSec = Number.isFinite(resetAtMs) ? Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)) : undefined;

  const body: AiQuotaErrorBody = { error, code: AI_QUOTA_ERROR_CODES[kind] };
  if (result.limit !== undefined) body.limit = result.limit;
  if (result.resetAt) body.resetAt = result.resetAt;
  if (retryAfterSec !== undefined) body.retryAfter = retryAfterSec;
  return { body, retryAfterSec };
}

// ---------------------------------------------------------------
// 数え済みの印
// ---------------------------------------------------------------

export const AI_QUOTA_COUNTED_HEADER = "x-hg-ai-quota-counted";
export const AI_QUOTA_MARKER_VERSION = "v1";
/** 印が有効な秒数 (これより古い印は受け付けない) */
export const AI_QUOTA_MARKER_MAX_AGE_SEC = 300;
/** サーバー間の時計のずれを許す秒数 (これより未来の印は受け付けない) */
export const AI_QUOTA_MARKER_MAX_FUTURE_SEC = 60;

const encoder = new TextEncoder();

/** 署名する文字列 */
function markerPayload(userId: string, issuedAtSec: number): string {
  return `${AI_QUOTA_MARKER_VERSION}.${userId}.${issuedAtSec}`;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** 印の値 (ヘッダーの値) を作る。呼び出し側 (Next.js) が、数え終えた直後に作る */
export async function signAiQuotaCounted(secret: string, userId: string, nowMs: number = Date.now()): Promise<string> {
  const issuedAtSec = Math.floor(nowMs / 1000);
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(markerPayload(userId, issuedAtSec)));
  return `${AI_QUOTA_MARKER_VERSION}.${issuedAtSec}.${toHex(signature)}`;
}

/**
 * 印を確かめる。次をすべて満たしたときだけ true。
 *  - 形式が `v1.<UNIX 秒>.<64 桁の hex>`
 *  - 発行から 5 分以内 (未来すぎる印も不可)
 *  - secrets のどれかの鍵で、`v1.<userId>.<UNIX 秒>` の署名が合う (userId は、呼び出し側が JWT から確定したもの)
 * 署名の比較は crypto.subtle.verify (定数時間) で行う。
 */
export async function verifyAiQuotaCounted(
  headerValue: string | null | undefined,
  userId: string,
  secrets: ReadonlyArray<string | null | undefined>,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!headerValue || !userId) return false;
  const parts = headerValue.split(".");
  if (parts.length !== 3 || parts[0] !== AI_QUOTA_MARKER_VERSION) return false;
  if (!/^\d{1,12}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return false;

  const issuedAtSec = Number(parts[1]);
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec - issuedAtSec > AI_QUOTA_MARKER_MAX_AGE_SEC) return false;
  if (issuedAtSec - nowSec > AI_QUOTA_MARKER_MAX_FUTURE_SEC) return false;

  const signature = fromHex(parts[2]);
  const payload = encoder.encode(markerPayload(userId, issuedAtSec));
  for (const secret of secrets) {
    if (!secret) continue;
    if (await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, payload)) return true;
  }
  return false;
}
