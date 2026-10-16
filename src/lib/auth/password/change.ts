/**
 * パスワードの変更・再設定の筋 (副作用は deps)。設計の正典 docs/design/cross/16-auth-history-sessions.md §13.2。
 * 照合 (checkPassword = RPC auth_password_check) が ok のときだけ GoTrue の PUT /auth/v1/user を呼び、GoTrue のエラーの code を kind に変える。
 */
export type PasswordCheckOutcome = 'ok' | 'current_mismatch' | 'reused' | 'no_password' | 'unsupported_hash';
export interface PasswordChangeInput {
  userId: string;
  /** 再設定 (recovery) のときは null (現在のパスワードを確かめない) */
  currentPassword: string | null;
  newPassword: string;
  /** passwordHistoryGenerationsFor(roles) */
  generations: number;
}
/** GoTrue の PUT /auth/v1/user の結果。code = GoTrue のエラーの code (例 weak_password)、読めなければ null。status = HTTP の status。GoTrue の英文はここに入れない */
export interface UpdatePasswordOutcome { error: { code: string | null; status: number } | null }
export interface PasswordChangeDeps {
  /** admin.rpc('auth_password_check', { p_user_id, p_current_password, p_new_password, p_generations }) の戻りを絞って返す */
  checkPassword(input: PasswordChangeInput): Promise<PasswordCheckOutcome>;
  /**
   * updatePasswordWithAccessToken(session.accessToken, input.newPassword, input.currentPassword) (§13.7。session = readSessionAuth の結果)。
   * currentPassword は変更なら現在のパスワード (GoTrue の UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD が ON でも通るよう GoTrue にも渡す)、再設定なら null。
   * createClient() の auth.updateUser は使わない (Bearer だけの要求ではセッションが無く AuthSessionMissingError §3)
   */
  updatePassword(input: { newPassword: string; currentPassword: string | null }): Promise<UpdatePasswordOutcome>;
}
export type PasswordChangeResult =
  | { kind: 'changed' } | { kind: 'current_mismatch' } | { kind: 'reused' } | { kind: 'no_password' } | { kind: 'unsupported_hash' }
  | { kind: 'weak' } | { kind: 'reauthentication_required' }
  | { kind: 'upstream-error'; code: string | null; status: number | null };
/** GoTrue のエラーの code (auth-js の AuthApiError.code) */
const GOTRUE_WEAK_PASSWORD = 'weak_password';
const GOTRUE_SAME_PASSWORD = 'same_password';
const GOTRUE_REAUTHENTICATION_NEEDED = 'reauthentication_needed';
/** GoTrue の UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD が ON で、渡した current_password が違う (DB の照合の後に別の要求でパスワードが変わった) */
const GOTRUE_CURRENT_PASSWORD_INVALID = 'current_password_invalid';
export async function performPasswordChange(input: PasswordChangeInput, deps: PasswordChangeDeps): Promise<PasswordChangeResult> {
  const check = await deps.checkPassword(input);
  if (check !== 'ok') return { kind: check };
  const { error } = await deps.updatePassword({ newPassword: input.newPassword, currentPassword: input.currentPassword });
  if (!error) return { kind: 'changed' };
  if (error.code === GOTRUE_WEAK_PASSWORD) return { kind: 'weak' };
  if (error.code === GOTRUE_SAME_PASSWORD) return { kind: 'reused' };
  if (error.code === GOTRUE_REAUTHENTICATION_NEEDED) return { kind: 'reauthentication_required' };
  if (error.code === GOTRUE_CURRENT_PASSWORD_INVALID) return { kind: 'current_mismatch' };
  return { kind: 'upstream-error', code: error.code, status: error.status };
}
