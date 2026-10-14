/**
 * パスワード強度バリデーションの共有ヘルパー
 * Issue #1057 (UX1-05) 対応
 *
 * signup と reset-password で要件(8字以上・英数字混在)が食い違い、
 * reset-password 側で `123456` のような弱いパスワードが通ってしまっていた。
 * 検証ロジックとエラー文言を一本化し、両画面で同じ要件を課す。
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_HINT_TEXT = `${PASSWORD_MIN_LENGTH}文字以上、英字と数字を含めてください`;

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
