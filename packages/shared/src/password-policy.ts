/**
 * パスワードの強さの規則 (Web とモバイルで同じものを使う)
 *
 * Issue #1057 (UX1-05): signup と reset-password で要件 (8 字以上・英数字混在) が食い違い、
 * reset-password 側で `123456` のような弱いパスワードが通ってしまっていたため、検証と文言を一本化した。
 * Issue #1187: モバイルの設定画面のパスワード変更でも同じ規則を使うため、置き場を Web (src/lib/auth) からここへ移した。
 * Web の src/lib/auth/validate-password.ts は、ここを読み直すだけの入口として残している。
 * Issue #1864: GoTrue (bcrypt) が断る 72 バイト超を、ここで先に止める (PASSWORD_MAX_BYTES)。
 */

/** パスワードの最小の長さ (#1057 で signup と再設定にそろえた値) */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_HINT_TEXT = `${PASSWORD_MIN_LENGTH}文字以上、英字と数字を含めてください`;

/**
 * パスワードの長さの上限 (UTF-8 のバイト数。#1864)。
 * Supabase Auth (GoTrue) はパスワードを bcrypt でハッシュし、bcrypt は先頭 72 バイトまでしか使わない。
 * GoTrue v2.183.0 は 72 バイトを超えるパスワードを、新規登録 (POST /auth/v1/signup) とパスワードの更新 (PUT /auth/v1/user) で
 * 400 validation_failed で断る (internal/api/password.go の MaxPasswordLength。Go の len は文字数ではなくバイト数)。
 * 画面と API でここで先に止めないと、利用者には GoTrue の英文か「時間をおいてもう一度」(500) が出て、何度やっても通らない。
 * 文字数ではなくバイト数なので、日本語 (1 文字 3 バイト) や絵文字 (4 バイト) を含むと 72 文字よりずっと手前で上限に当たる。
 * 新しいパスワードの規則にだけ使う。ログイン・現在のパスワードの確認には使わない (上限より長い既存のパスワードの利用者を締め出さない)
 */
export const PASSWORD_MAX_BYTES = 72;

/** UTF-8 で 1 文字が何バイトになるかの境目 (Unicode のコードポイントの範囲。RFC 3629 §3) */
const UTF8_ONE_BYTE_MAX_CODE_POINT = 0x7f;
const UTF8_TWO_BYTE_MAX_CODE_POINT = 0x7ff;
const UTF8_THREE_BYTE_MAX_CODE_POINT = 0xffff;
const UTF8_TWO_BYTES = 2;
const UTF8_THREE_BYTES = 3;
const UTF8_FOUR_BYTES = 4;
/** 文言の「日本語なら約 N 文字」の 1 文字のバイト数 (ひらがな・カタカナ・常用の漢字は UTF-8 で 3 バイト) */
const UTF8_BYTES_PER_JAPANESE_CHAR = UTF8_THREE_BYTES;

/**
 * 文字列を UTF-8 にしたときのバイト数 (GoTrue が受け取る JSON の文字列のバイト数と同じ数え方)。
 * Web・モバイル (Hermes) のどちらでも同じ結果になるよう、TextEncoder に頼らずコードポイントから数える。
 * 対になっていないサロゲート (例 '\ud800') は、TextEncoder・GoTrue と同じく置換文字 U+FFFD (3 バイト) として数える
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= UTF8_ONE_BYTE_MAX_CODE_POINT) bytes += 1;
    else if (codePoint <= UTF8_TWO_BYTE_MAX_CODE_POINT) bytes += UTF8_TWO_BYTES;
    else if (codePoint <= UTF8_THREE_BYTE_MAX_CODE_POINT) bytes += UTF8_THREE_BYTES;
    else bytes += UTF8_FOUR_BYTES;
  }
  return bytes;
}

/** 上限を超えたときの文言 (半角の文字数 = バイト数。日本語は 1 文字 3 バイトとして概数を添える) */
export const PASSWORD_TOO_LONG_MESSAGE = `パスワードが長すぎます。半角で${PASSWORD_MAX_BYTES}文字 (日本語なら約${Math.floor(
  PASSWORD_MAX_BYTES / UTF8_BYTES_PER_JAPANESE_CHAR,
)}文字) 以内にしてください`;

/** 規則を満たさないときは利用者向けの理由を、満たすときは null を返す */
export function validatePassword(password: string): string | null {
  if (!password) {
    return 'パスワードを入力してください';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください`;
  }
  if (utf8ByteLength(password) > PASSWORD_MAX_BYTES) {
    return PASSWORD_TOO_LONG_MESSAGE;
  }
  if (!/[A-Za-z]/.test(password)) {
    return 'パスワードには英字を含めてください';
  }
  if (!/[0-9]/.test(password)) {
    return 'パスワードには数字を含めてください';
  }
  return null;
}
