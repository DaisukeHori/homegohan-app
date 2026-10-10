/**
 * ログイン失敗のロック (#1165)。サーバー専用。
 *
 * 設計書 docs/design/cross/01-auth-session.md §8 の表をそのまま実装する。
 *
 * | 連続失敗の回数 | アクション                                   |
 * |----------------|----------------------------------------------|
 * | 3 回           | ボットの確認 (Cloudflare Turnstile) を求める |
 * | 5 回           | 15 分ロック                                  |
 * | 10 回          | 1 時間ロック + 本人へメールで知らせる        |
 * | 20 回          | 24 時間ロック + 運営へ知らせる               |
 *
 * - ロック中は、正しいパスワードでも断る。期限より早く外せるのは、メールのリンクからのパスワードの再設定だけ
 *   (POST /api/auth/login-lock/clear。再設定の画面が、パスワードを更新できた直後に呼ぶ)。
 * - 回数は、ログインに成功したとき・パスワードの再設定を済ませたときに 0 へ戻す (記録の行を消す)。
 *   それ以外では減らさない (時間が経っても戻さない)。ロックの期限が切れたあとの失敗も数え続けるので、
 *   続けて失敗すると、より長いロックへ進む。
 * - ロックの段は「いまの回数で届いている、いちばん上の段」。その段に届いた後の失敗のたびに、その段の長さで期限を延ばす
 *   (5〜9 回目の失敗のたびに 15 分、10〜19 回目は 1 時間、20 回目以降は 24 時間)。
 *   通知 (本人へのメール・運営への通知) は、その段にちょうど届いた 1 回 (10 回目・20 回目) だけ送る。
 * - 数えるのはメールアドレス (小文字にして前後の空白を除いたもの) ごと。アカウントが存在しないメールアドレスも同じように数え、
 *   同じようにロックする (応答からアカウントの有無が分からないように)。記録は SHA-256 のハッシュだけ
 *   (supabase/migrations/20261010130000_auth_login_failures.sql)。
 * - 記録は DB (auth_login_failures)。Upstash Redis を使わないのは、未設定のときにメモリ内の数え方になり、
 *   サーバーのインスタンスをまたいでロックが残らないため。
 *
 * 表の値は設計で決まっているもので、運用で変える値ではない (変えるときは設計書と一緒に改める)。そのため環境変数では上書きしない。
 */
import { z } from 'zod';

const MINUTE_SEC = 60;
const HOUR_SEC = 60 * MINUTE_SEC;
const DAY_SEC = 24 * HOUR_SEC;
const MS_PER_SEC = 1000;

/** この回数以上続けて失敗しているメールアドレスでは、ボットの確認 (Turnstile) を求める (設計 §8 の 1 行目) */
export const CAPTCHA_REQUIRED_FAILURE_COUNT = 3;

/** 段に届いたときに知らせる相手。'none' は知らせない */
export type LoginLockNotice = 'none' | 'account-owner' | 'admin';

export interface LoginLockTier {
  /** この回数に届いたら、この段 */
  failures: number;
  /** ロックの長さ (秒) */
  lockSeconds: number;
  /** ちょうどこの回数に届いたときに知らせる相手 */
  notice: LoginLockNotice;
}

/** 設計 §8 の表の 2〜4 行目。failures の小さい順 */
export const LOGIN_LOCK_TIERS: readonly LoginLockTier[] = [
  { failures: 5, lockSeconds: 15 * MINUTE_SEC, notice: 'none' },
  { failures: 10, lockSeconds: HOUR_SEC, notice: 'account-owner' },
  { failures: 20, lockSeconds: DAY_SEC, notice: 'admin' },
];

/** いまの連続失敗の回数で届いている、いちばん上の段。どの段にも届いていなければ null */
export function lockTierFor(failureCount: number): LoginLockTier | null {
  let reached: LoginLockTier | null = null;
  for (const tier of LOGIN_LOCK_TIERS) {
    if (failureCount >= tier.failures) reached = tier;
  }
  return reached;
}

/** この回数の失敗で、ちょうど段に届いたときの通知の相手。届いていない・届いた後の失敗なら 'none' */
export function noticeFor(failureCount: number): LoginLockNotice {
  const tier = LOGIN_LOCK_TIERS.find((candidate) => candidate.failures === failureCount);
  return tier ? tier.notice : 'none';
}

/** ロックが外れるまでの秒数 (切り上げ。最低 1 秒)。ロックしていなければ 0 */
export function retryAfterSeconds(lockedUntil: Date | null, now: Date): number {
  if (!lockedUntil) return 0;
  const remainingMs = lockedUntil.getTime() - now.getTime();
  if (remainingMs <= 0) return 0;
  return Math.max(1, Math.ceil(remainingMs / MS_PER_SEC));
}

/** RPC を呼ぶ client (service_role の supabase-js client。テストでは偽物を渡す) */
export interface LoginLockRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** 記録の読み書きに失敗した (DB に届かない・関数が無いなど)。ロックを判定できないので、ログインは通さない */
export class LoginLockStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(`ログイン失敗の記録の ${operation} に失敗しました`);
    this.name = 'LoginLockStoreError';
  }
}

const LockRowSchema = z.object({
  failure_count: z.number().int().nonnegative(),
  locked_until: z.string().nullable(),
});
const LockRowsSchema = z.array(LockRowSchema);

function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function callRpc(client: LoginLockRpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: unknown };
  try {
    result = await client.rpc(fn, args);
  } catch (error) {
    throw new LoginLockStoreError(fn, error);
  }
  if (result.error) throw new LoginLockStoreError(fn, result.error);
  return result.data;
}

function parseLockRow(fn: string, data: unknown): { failureCount: number; lockedUntil: Date | null } {
  const parsed = LockRowsSchema.safeParse(data);
  if (!parsed.success) throw new LoginLockStoreError(fn, parsed.error);
  const row = parsed.data[0];
  if (!row) return { failureCount: 0, lockedUntil: null };
  return { failureCount: row.failure_count, lockedUntil: parseTimestamp(row.locked_until) };
}

export interface LoginLockState {
  failureCount: number;
  /** 期限が切れたロックも含めて、記録されている期限 */
  lockedUntil: Date | null;
  /** いま (now の時点で) ロック中か */
  locked: boolean;
  /** ロックが外れるまでの秒数。ロックしていなければ 0 */
  retryAfterSec: number;
  /** ボットの確認を求めるか (連続失敗が CAPTCHA_REQUIRED_FAILURE_COUNT 回以上) */
  captchaRequired: boolean;
}

function toState(failureCount: number, lockedUntil: Date | null, now: Date): LoginLockState {
  const retryAfterSec = retryAfterSeconds(lockedUntil, now);
  return {
    failureCount,
    lockedUntil,
    locked: retryAfterSec > 0,
    retryAfterSec,
    captchaRequired: failureCount >= CAPTCHA_REQUIRED_FAILURE_COUNT,
  };
}

/** メールアドレスの、いまの失敗の回数とロック */
export async function readLoginLockState(client: LoginLockRpcClient, email: string, now: Date): Promise<LoginLockState> {
  const fn = 'auth_login_lock_status';
  const { failureCount, lockedUntil } = parseLockRow(fn, await callRpc(client, fn, { p_email: email }));
  return toState(failureCount, lockedUntil, now);
}

export interface LoginFailureRecord extends LoginLockState {
  /** この失敗で、ちょうど段に届いたときの通知の相手 */
  notice: LoginLockNotice;
}

/**
 * 失敗を 1 回数え、届いた段のロックをかける。
 * 回数の加算は DB の 1 文 (INSERT ... ON CONFLICT) なので、同時に失敗しても数え漏れない。
 * ロックの期限は、今の期限より短くはしない (auth_login_apply_lock が GREATEST で延ばす)。
 */
export async function recordLoginFailure(
  client: LoginLockRpcClient,
  email: string,
  now: Date,
): Promise<LoginFailureRecord> {
  const fn = 'auth_login_record_failure';
  const recorded = parseLockRow(fn, await callRpc(client, fn, { p_email: email }));
  let lockedUntil = recorded.lockedUntil;

  const tier = lockTierFor(recorded.failureCount);
  if (tier) {
    const newLockedUntil = new Date(now.getTime() + tier.lockSeconds * MS_PER_SEC);
    await callRpc(client, 'auth_login_apply_lock', {
      p_email: email,
      p_locked_until: newLockedUntil.toISOString(),
    });
    if (!lockedUntil || newLockedUntil > lockedUntil) lockedUntil = newLockedUntil;
  }

  return { ...toState(recorded.failureCount, lockedUntil, now), notice: noticeFor(recorded.failureCount) };
}

/** 失敗の記録を消す (ログインの成功・パスワードの再設定) */
export async function clearLoginFailures(client: LoginLockRpcClient, email: string): Promise<void> {
  await callRpc(client, 'auth_login_clear_failures', { p_email: email });
}

const AccountUserIdSchema = z.string().uuid().nullable();

/** メールアドレスのアカウントの user_id。アカウントが無ければ null (通知の宛先を決めるのに使う) */
export async function findAccountUserId(client: LoginLockRpcClient, email: string): Promise<string | null> {
  const fn = 'auth_login_account_user_id';
  const parsed = AccountUserIdSchema.safeParse(await callRpc(client, fn, { p_email: email }));
  if (!parsed.success) throw new LoginLockStoreError(fn, parsed.error);
  return parsed.data;
}
