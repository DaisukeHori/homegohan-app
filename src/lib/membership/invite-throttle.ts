/**
 * #1163 ユーザー操作で外部へメールが出る API の送信回数制限 (招待メール・参加リクエスト・譲渡提案)
 *
 * 利用者が指定した宛先へメールを送る API は、そのまま放っておくと「迷惑メールの踏み台」になる
 * (招待者は任意のアドレスと自由文を指定できる)。この API の件数制限を一か所に集める。
 * 【規約】利用者が指定したアドレスへメールを送る処理は、必ずこのモジュールの判定を通すこと
 * (tests/email-send-throttle-contract.test.ts が `sendEmail(` を呼ぶファイルを走査して確認する)。
 *
 * 判定は「試行回数」を数える。メールが実際に出たかどうかではなく、副作用 (RPC) の直前に数える。
 * 判定の順序は 招待者(user) → 組織(scope, org のみ) → 宛先(target)。どれかが超過した時点で打ち切る。
 *
 * 【key の信頼性】
 * - user  : 認証で確定した user.id
 * - scope : プロフィールから取った organization_id (リクエストの body から取らない)
 * - target: `${flow}:${scopeId}:${宛先メールのハッシュ}`。scopeId は検証済みの family_id /
 *           プロフィールの organization_id / 昇格では user.id
 * リクエストの body / URL にある未検証の ID を key にしてはならない。他テナントの ID を指定して
 * その枠を使い切らせる攻撃 (他人の招待を止める) ができてしまうため。
 * 宛先メールアドレスは SHA-256 のハッシュにして、Redis のキーやログに個人情報を残さない。
 *
 * 【失敗時の挙動】
 * 判定に使うバックエンド (Upstash Redis) が例外を投げたときは、握りつぶさず呼び出し元へ伝播させる
 * (fail-closed。route は 500 を返し、メールは出ない。src/lib/rate-limit.ts と同じ方針)。
 *
 * 【本番の前提】
 * 日次の上限は Upstash Redis (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) が設定されている
 * ときだけ、サーバーインスタンスをまたいで共有される。未設定の in-memory フォールバックでは
 * インスタンスごとのベストエフォートになる。
 *
 * 【DB 側の 24 時間上限 (#1163)】
 * Upstash が未設定でも日次の上限が効くよう、招待・昇格リクエスト・譲渡提案を作る RPC は、
 * DB の enforce_membership_daily_cap (membership_audit の件数) でも 24 時間の上限を確かめ、超過したら
 * `RATE_LIMITED` (HINT = 'retry_after_sec=<秒>') で失敗する。RPC のエラーをこのモジュールの
 * inviteThrottleFailureFromRpcError で受け、アプリ層の上限と同じ形の 429 にする。
 */
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/db-logger';
import { ErrorStatusMap, MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import {
  checkRateLimit,
  getRetryAfterSec,
  type RateLimitCategory,
  type RateLimitResult,
} from '@/lib/rate-limit';

/** 宛先メールアドレスを指定してメールを送る流れ */
export type InviteFlow = 'family-invite' | 'org-invite' | 'child-promotion';

/** どの判定で止まったか (ログ用)。'db' は DB の 24 時間上限 (RPC が返す RATE_LIMITED) */
type ThrottleLayer = 'user' | 'scope' | 'target' | 'db';

export interface InviteThrottleFailure {
  /** 何秒後に再試行できるか (Retry-After ヘッダーと body.error.retryAfter の値) */
  retryAfterSec: number;
  /** 超過したルールのウィンドウ秒数。分あたり (60) と日次 (86400) で文言を出し分ける */
  windowSec: number | undefined;
  /** 利用者に見せる文言 (日本語) */
  message: string;
}

export interface CheckInviteEmailLimitsParams {
  flow: InviteFlow;
  /** 認証で確定したログインユーザーの ID */
  userId: string;
  /**
   * 検証済みの範囲 ID。family-invite は所属確認後の family_id、org-invite はプロフィールの
   * organization_id、child-promotion は user.id。リクエストの body / URL の値をそのまま渡さない。
   */
  scopeId: string;
  recipientEmail: string;
}

// flow ごとの判定対象。user は必須、scope は組織のみ。
const FLOW_CONFIG: Record<InviteFlow, { userCategory: RateLimitCategory; scopeCategory?: RateLimitCategory }> = {
  'family-invite': { userCategory: 'family-invite' },
  'org-invite': { userCategory: 'org-invite', scopeCategory: 'org-invite-scope' },
  'child-promotion': { userCategory: 'child-promotion' },
};

const BURST_WINDOW_SEC = 60;

const BURST_MESSAGE = '短時間に操作が集中しています。1分ほど待ってからお試しください。';
// 宛先ごとの上限も同じ文言にする。宛先がアカウント登録済みかどうかを推測させない
// (request_child_promotion の列挙オラクル対策を崩さない)。
const DAILY_MESSAGE = '本日の送信上限に達しました。しばらく時間をおいてからお試しください。';

/** 超過したウィンドウに合わせた文言を返す */
export function throttleMessageForWindow(windowSec: number | undefined): string {
  return windowSec !== undefined && windowSec <= BURST_WINDOW_SEC ? BURST_MESSAGE : DAILY_MESSAGE;
}

/** 宛先メールアドレスのハッシュ (前後の空白除去 + 小文字化 → SHA-256 の先頭 32 文字) */
export function hashRecipientEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

function assertTrustedKey(name: string, value: string): void {
  // 空の key は全員が同じ枠を共有してしまう。呼び出し側の不具合は拒否 (fail-closed) にする
  if (!value) {
    throw new Error(`invite-throttle: ${name} が空です`);
  }
}

interface ThrottleCheck {
  layer: ThrottleLayer;
  category: RateLimitCategory;
  key: string;
}

interface ThrottleContext {
  flow: string;
  userId: string;
  /** ログ用: 宛先ハッシュの先頭 (メールアドレスそのものは出さない) */
  recipientHashPrefix?: string;
}

/** 1 件の判定を行い、超過していれば失敗情報 (と warn ログ) を返す */
async function evaluate(check: ThrottleCheck, context: ThrottleContext): Promise<InviteThrottleFailure | null> {
  let result: RateLimitResult;
  try {
    result = await checkRateLimit(check.key, check.category);
  } catch (err) {
    // fail-closed: 判定できないときは通さない。構造化ログに残したうえで同じ例外を呼び出し元へ伝播させる
    createLogger('invite-throttle')
      .withUser(context.userId)
      .error('レート制限の判定に失敗しました (fail-closed)', err, {
        flow: context.flow,
        layer: check.layer,
      });
    throw err;
  }
  if (result.success) return null;

  const failure: InviteThrottleFailure = {
    retryAfterSec: getRetryAfterSec(result),
    windowSec: result.windowSec,
    message: throttleMessageForWindow(result.windowSec),
  };
  createLogger('invite-throttle').withUser(context.userId).warn('メール送信の上限に達しました', {
    flow: context.flow,
    layer: check.layer,
    window_sec: failure.windowSec,
    retry_after_sec: failure.retryAfterSec,
    ...(context.recipientHashPrefix ? { recipient_hash: context.recipientHashPrefix } : {}),
  });
  return failure;
}

/**
 * 招待メール・参加リクエストメールを送る前に呼ぶ。超過していなければ null、超過していれば失敗情報を返す。
 * 副作用 (RPC) より前に呼ぶこと。判定は試行回数を数えるので、RPC が失敗しても 1 回と数える。
 */
export async function checkInviteEmailLimits(
  params: CheckInviteEmailLimitsParams,
): Promise<InviteThrottleFailure | null> {
  const { flow, userId, scopeId, recipientEmail } = params;
  assertTrustedKey('userId', userId);
  assertTrustedKey('scopeId', scopeId);

  const config = FLOW_CONFIG[flow];
  const recipientHash = hashRecipientEmail(recipientEmail);
  const context: ThrottleContext = { flow, userId, recipientHashPrefix: recipientHash.slice(0, 8) };

  const checks: ThrottleCheck[] = [{ layer: 'user', category: config.userCategory, key: userId }];
  if (config.scopeCategory) {
    // 管理者が複数いても組織全体で送れる量を抑える
    checks.push({ layer: 'scope', category: config.scopeCategory, key: scopeId });
  }
  // 同じ範囲から同じ宛先への連続送信を止める
  checks.push({ layer: 'target', category: 'invite-target', key: `${flow}:${scopeId}:${recipientHash}` });

  for (const check of checks) {
    const failure = await evaluate(check, context);
    if (failure) return failure;
  }
  return null;
}

/**
 * 譲渡提案メール(オーナー譲渡・代表者譲渡)を出す前に呼ぶ。宛先は既存メンバーなので、提案者単位だけで数える。
 */
export async function checkTransferProposeLimit(userId: string): Promise<InviteThrottleFailure | null> {
  assertTrustedKey('userId', userId);
  return evaluate(
    { layer: 'user', category: 'transfer-propose', key: userId },
    { flow: 'transfer-propose', userId },
  );
}

// DB 側の 24 時間上限 (enforce_membership_daily_cap) はローリング 24 時間
const DB_DAILY_WINDOW_SEC = 24 * 60 * 60;
// HINT から再試行までの秒数を読めないときの代わりの値 (1 時間)。上限は最長 24 時間で解ける
const DB_RETRY_AFTER_FALLBACK_SEC = 60 * 60;

/** DB の上限名 (DETAIL。例: 'org_invite:per_target')。想定外の文字列をログに残さないための形 */
const DB_RULE_NAME_PATTERN = /^[a-z_]{1,32}:[a-z_]{1,32}$/;

/** PostgREST が返す RPC のエラーのうち、判定に使う項目 (supabase-js の PostgrestError と同じ名前) */
export interface RpcErrorLike {
  message?: string | null;
  code?: string | null;
  /** RAISE の DETAIL。DB の上限名 (例: 'family_invite:per_actor') */
  details?: string | null;
  /** RAISE の HINT。DB の上限では 'retry_after_sec=<秒>' */
  hint?: string | null;
}

/**
 * RPC のエラーが DB の 24 時間上限 (enforce_membership_daily_cap の RATE_LIMITED) なら、
 * アプリ層の上限と同じ 429 にするための失敗情報を返す。それ以外のエラーなら null (呼び出し側が従来どおり処理する)。
 *
 * - retryAfterSec は HINT の `retry_after_sec=<秒>` (最古の対象行が 24 時間の窓から出るまでの秒数)。
 *   読めない・1 未満のときは 1 時間にする。
 * - 文言は日次の超過と同じ (宛先の登録状況を推測させない)。
 * - 上限名 (DETAIL) と秒数だけをログに残す。宛先のメールアドレスは残さない。
 */
export function inviteThrottleFailureFromRpcError(
  error: RpcErrorLike,
  context: { flow: InviteFlow | 'transfer-propose'; userId: string },
): InviteThrottleFailure | null {
  if (mapPgErrorToHttp(error.message ?? '', error.code ?? undefined).code !== MembershipErrorCode.RATE_LIMITED) {
    return null;
  }

  const hinted = Number(/\bretry_after_sec=(\d+)\b/.exec(error.hint ?? '')?.[1]);
  const failure: InviteThrottleFailure = {
    retryAfterSec: Number.isSafeInteger(hinted) && hinted >= 1 ? hinted : DB_RETRY_AFTER_FALLBACK_SEC,
    windowSec: DB_DAILY_WINDOW_SEC,
    message: throttleMessageForWindow(DB_DAILY_WINDOW_SEC),
  };
  const rule = error.details && DB_RULE_NAME_PATTERN.test(error.details) ? error.details : undefined;
  const layer: ThrottleLayer = 'db';
  createLogger('invite-throttle').withUser(context.userId).warn('DB の 24 時間上限に達しました', {
    flow: context.flow,
    layer,
    window_sec: failure.windowSec,
    retry_after_sec: failure.retryAfterSec,
    ...(rule ? { rule } : {}),
  });
  return failure;
}

/**
 * 超過時の 429 レスポンス。membership 系 UI は json.error.message を読むので、
 * AI 系の平らな形式ではなく `{ error: { code, message, retryAfter } }` で返す。
 */
export function inviteThrottleResponse(failure: InviteThrottleFailure): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: MembershipErrorCode.RATE_LIMITED,
        message: failure.message,
        retryAfter: failure.retryAfterSec,
      },
    },
    {
      status: ErrorStatusMap[MembershipErrorCode.RATE_LIMITED],
      headers: { 'Retry-After': String(failure.retryAfterSec) },
    },
  );
}
