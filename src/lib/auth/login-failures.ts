/**
 * ログインの連続失敗の回数 (#1165)。サーバー専用。
 *
 * ログインに続けて失敗しても、アカウントはロックしない (docs/operations/auth-protection.md §1)。
 * 他人のメールアドレスで失敗を繰り返すだけで本人を締め出せてしまうため。
 * 回数は、ボットの確認 (Cloudflare Turnstile) を求めるかどうかにだけ使う。
 *
 * | 連続失敗の回数                    | アクション                                   |
 * |-----------------------------------|----------------------------------------------|
 * | 0〜2 回                           | なし                                         |
 * | 3 回以上 (CAPTCHA_REQUIRED_...)   | ボットの確認を求める (キーがあるときだけ)    |
 *
 * 何回失敗しても、正しいパスワードならログインできる (断るのは、ボットの確認のトークンが無い・偽物のときだけ)。
 *
 * - 回数が 0 に戻るのは、ログインに成功したとき (記録の行を消す) と、最後の失敗から
 *   LOGIN_FAILURE_RESET_MINUTES 分 (環境変数 AUTH_LOGIN_FAILURE_RESET_MINUTES で上書きできる) が経ったとき。
 *   時間での判定は DB の関数がする (supabase/migrations/20261010160000_auth_login_failure_window.sql)。
 * - 数えるのはメールアドレス (小文字にして前後の空白を除いたもの) ごと。アカウントが存在しないメールアドレスも同じように数える
 *   (応答からアカウントの有無が分からないように)。記録は SHA-256 のハッシュだけ
 *   (supabase/migrations/20261010130000_auth_login_failures.sql の auth_login_failures)。
 * - 記録は DB。Upstash Redis を使わないのは、未設定のときにメモリ内の数え方になり、サーバーのインスタンスをまたいで数えられないため。
 */
import { z } from 'zod';

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
/** AUTH_LOGIN_FAILURE_RESET_MINUTES の上限の日数 */
const RESET_MAX_DAYS = 7;

/** この回数以上続けて失敗しているメールアドレスでは、ボットの確認 (Turnstile) を求める */
export const CAPTCHA_REQUIRED_FAILURE_COUNT = 3;

/**
 * 連続失敗の回数を 0 に戻すまでの、最後の失敗からの時間 (分) の既定値 = 24 時間。
 * 根拠: 回数はボットの確認を求めるかどうかにだけ使い、ログインを止めない。Web の画面はサイトキーがあれば毎回トークンを取って送るので、
 * 確認を求めても本人の手間はほとんど増えない。一方で短くすると、間を空けて同じメールアドレスを試す攻撃が確認を避けやすくなる。
 * そのため長めにとり、1 日失敗が無ければ戻す。成功すればその場で 0 に戻るので、本人がログインできれば影響は残らない。
 */
export const LOGIN_FAILURE_RESET_MINUTES = MINUTES_PER_DAY;

/** AUTH_LOGIN_FAILURE_RESET_MINUTES で受け付ける最小値 (分)。DB の関数が受け付ける下限 (1 分) に合わせる */
export const LOGIN_FAILURE_RESET_MINUTES_MIN = 1;

/** AUTH_LOGIN_FAILURE_RESET_MINUTES で受け付ける最大値 (分) = 7 日。これより長く数え続ける理由が無い */
export const LOGIN_FAILURE_RESET_MINUTES_MAX = RESET_MAX_DAYS * MINUTES_PER_DAY;

/** 上書きに使う環境変数の名前 (値を読むのは POST /api/auth/login の route だけ。ここは渡された文字列を検証するだけ) */
export const LOGIN_FAILURE_RESET_ENV_NAME = 'AUTH_LOGIN_FAILURE_RESET_MINUTES';

/** 10 進の整数だけを受け付ける (符号・小数・指数・16 進は不可)。桁数は Number で正確に表せる範囲に抑える */
const DECIMAL_INTEGER_PATTERN = /^\d{1,15}$/;

export interface LoginFailureResetSetting {
  /** 連続失敗の回数を 0 に戻すまでの、最後の失敗からの時間 (分) */
  readonly minutes: number;
  /** 値が不正で、既定値に戻したか (ログで知らせる用。値そのものは返さない) */
  readonly ignored: boolean;
}

/**
 * 回数を 0 に戻すまでの時間を決める。環境変数 AUTH_LOGIN_FAILURE_RESET_MINUTES の文字列 (未設定は undefined) を渡す。
 * 未設定・空白だけは既定値 (無視したことにはしない)。整数でない・範囲外は既定値に戻し、ignored を true にする
 * (打ち間違いで、ログインが 500 になったり、確認が求められなくなったりしないように)。
 */
export function resolveLoginFailureResetMinutes(raw: string | undefined): LoginFailureResetSetting {
  const text = raw?.trim();
  if (!text) return { minutes: LOGIN_FAILURE_RESET_MINUTES, ignored: false };
  if (!DECIMAL_INTEGER_PATTERN.test(text)) return { minutes: LOGIN_FAILURE_RESET_MINUTES, ignored: true };
  const n = Number(text);
  if (n < LOGIN_FAILURE_RESET_MINUTES_MIN || n > LOGIN_FAILURE_RESET_MINUTES_MAX) {
    return { minutes: LOGIN_FAILURE_RESET_MINUTES, ignored: true };
  }
  return { minutes: n, ignored: false };
}

/** RPC を呼ぶ client (service_role の supabase-js client。テストでは偽物を渡す) */
export interface LoginFailureRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** 記録の読み書きに失敗した (DB に届かない・関数が無いなど)。ボットの確認を求めるかを判定できないので、ログインは通さない */
export class LoginFailureStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(`ログイン失敗の記録の ${operation} に失敗しました`);
    this.name = 'LoginFailureStoreError';
  }
}

const FailureCountSchema = z.number().int().nonnegative();

async function callRpc(client: LoginFailureRpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: unknown };
  try {
    result = await client.rpc(fn, args);
  } catch (error) {
    throw new LoginFailureStoreError(fn, error);
  }
  if (result.error) throw new LoginFailureStoreError(fn, result.error);
  return result.data;
}

function parseFailureCount(fn: string, data: unknown): number {
  const parsed = FailureCountSchema.safeParse(data);
  if (!parsed.success) throw new LoginFailureStoreError(fn, parsed.error);
  return parsed.data;
}

export interface LoginFailureState {
  /** いまの連続失敗の回数 (時間で戻った分は 0) */
  failureCount: number;
  /** ボットの確認を求めるか (連続失敗が CAPTCHA_REQUIRED_FAILURE_COUNT 回以上) */
  captchaRequired: boolean;
}

function toState(failureCount: number): LoginFailureState {
  return { failureCount, captchaRequired: failureCount >= CAPTCHA_REQUIRED_FAILURE_COUNT };
}

/** メールアドレスの、いまの連続失敗の回数 */
export async function readLoginFailureState(
  client: LoginFailureRpcClient,
  email: string,
  resetAfterMinutes: number,
): Promise<LoginFailureState> {
  const fn = 'auth_login_failure_count';
  const data = await callRpc(client, fn, { p_email: email, p_reset_after_minutes: resetAfterMinutes });
  return toState(parseFailureCount(fn, data));
}

/**
 * 失敗を 1 回数え、数えた後の状態を返す。
 * 回数の加算は DB の 1 文 (INSERT ... ON CONFLICT) なので、同時に失敗しても数え漏れない。
 * 最後の失敗から resetAfterMinutes 分が経っていれば、1 からやり直す。
 */
export async function recordLoginFailure(
  client: LoginFailureRpcClient,
  email: string,
  resetAfterMinutes: number,
): Promise<LoginFailureState> {
  const fn = 'auth_login_count_failure';
  const data = await callRpc(client, fn, { p_email: email, p_reset_after_minutes: resetAfterMinutes });
  return toState(parseFailureCount(fn, data));
}

/** 失敗の記録を消す (ログインの成功) */
export async function clearLoginFailures(client: LoginFailureRpcClient, email: string): Promise<void> {
  await callRpc(client, 'auth_login_clear_failures', { p_email: email });
}
