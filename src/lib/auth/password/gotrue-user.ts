/**
 * 本人の access token で GoTrue の PUT /auth/v1/user を呼ぶ。設計の正典 docs/design/cross/16-auth-history-sessions.md §13.7。
 * Web (Cookie) とモバイル (Bearer だけ) を同じ経路にするため、auth-js の保管のセッションに頼らず、readSessionAuth が検証した access token を明示する。
 */
import { z } from 'zod';
import { getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env-required';
import type { UpdatePasswordOutcome } from './change';
/** GoTrue のエラー本文を { code: 文字列, message } の形で返させる版。auth-js の API_VERSIONS['2024-01-01'] と同じ値 */
export const GOTRUE_API_VERSION = '2024-01-01';
/** auth-js の API_VERSION_HEADER_NAME と同じ名前 */
export const GOTRUE_API_VERSION_HEADER = 'X-Supabase-Api-Version';
/** GoTrue の本人の情報の更新 (auth-js の updateUser と同じ口) */
export const GOTRUE_USER_PATH = '/auth/v1/user';
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const GoTrueErrorBodySchema = z.object({ code: z.unknown(), error_code: z.unknown() }).partial();
/** 版のヘッダを付けると code が文字列で返る。付かない古い形 (code が数値・error_code が文字列) も読む。どちらも無ければ null */
function gotrueErrorCodeOf(body: unknown): string | null {
  const parsed = GoTrueErrorBodySchema.safeParse(body);
  if (!parsed.success) return null;
  if (typeof parsed.data.code === 'string') return parsed.data.code;
  if (typeof parsed.data.error_code === 'string') return parsed.data.error_code;
  return null;
}
/**
 * accessToken = readSessionAuth(...).accessToken (Web は Cookie のセッションの token、モバイルは Bearer の JWT)。
 * currentPassword = 変更なら現在のパスワード (本文の current_password に入れる)、再設定なら null (本文に入れない)。
 * GoTrue は UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD が OFF (既定) なら current_password を読まない。ON なら、再設定のセッション
 * (amr が otp・magiclink・recovery) を除いてこれを照合する (§3)。本書は変更でいつも渡すので、どちらの設定でも同じに動く (§24・Q-18)。
 * 成功なら { error: null }。GoTrue が 4xx / 5xx なら { error: { code, status } } (例外にしない)。通信の失敗は fetch の例外のまま投げる。
 * パスワード・token・GoTrue の英文はログにも戻り値にも入れない
 */
export async function updatePasswordWithAccessToken(
  accessToken: string,
  newPassword: string,
  currentPassword: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<UpdatePasswordOutcome> {
  const requestBody = currentPassword === null ? { password: newPassword } : { password: newPassword, current_password: currentPassword };
  const response = await fetchImpl(`${getSupabaseUrl()}${GOTRUE_USER_PATH}`, {
    method: 'PUT',
    headers: {
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      [GOTRUE_API_VERSION_HEADER]: GOTRUE_API_VERSION,
    },
    body: JSON.stringify(requestBody),
    cache: 'no-store',
  });
  if (response.ok) return { error: null };
  const body: unknown = await response.json().catch(() => null);
  return { error: { code: gotrueErrorCodeOf(body), status: response.status } };
}
