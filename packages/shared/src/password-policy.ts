/**
 * パスワードの強さの規則 (Web とモバイルで同じものを使う)
 *
 * Issue #1057 (UX1-05): signup と reset-password で要件 (8 字以上・英数字混在) が食い違い、
 * reset-password 側で `123456` のような弱いパスワードが通ってしまっていたため、検証と文言を一本化した。
 * Issue #1187: モバイルの設定画面のパスワード変更でも同じ規則を使うため、置き場を Web (src/lib/auth) からここへ移した。
 * Web の src/lib/auth/validate-password.ts は、ここを読み直すだけの入口として残している。
 */

/** パスワードの最小の長さ (#1057 で signup と再設定にそろえた値) */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_HINT_TEXT = `${PASSWORD_MIN_LENGTH}文字以上、英字と数字を含めてください`;

/** 規則を満たさないときは利用者向けの理由を、満たすときは null を返す */
export function validatePassword(password: string): string | null {
  if (!password) {
    return 'パスワードを入力してください';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください`;
  }
  if (!/[A-Za-z]/.test(password)) {
    return 'パスワードには英字を含めてください';
  }
  if (!/[0-9]/.test(password)) {
    return 'パスワードには数字を含めてください';
  }
  return null;
}
