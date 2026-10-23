/**
 * Sign in with Apple の共有の定数と固定の文 (docs/design/mobile/08-sign-in-with-apple.md §11.1)。
 * Web (NEXT_PUBLIC_APPLE_SIGN_IN) とモバイル (EXPO_PUBLIC_APPLE_SIGN_IN) のスイッチの読み方を 1 つにする
 * (lib/legal-consent.ts の isLegalConsentFlagOn と同じ: 明示的に on と書いたときだけ有効。大文字小文字と前後の空白は区別しない)。
 */

/** スイッチを有効とみなす値 */
export const APPLE_SIGN_IN_FLAG_ON = 'on';

/** スイッチの値が on か (未設定・空・それ以外の語は off) */
export function isAppleSignInFlagOn(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === APPLE_SIGN_IN_FLAG_ON;
}

/**
 * Apple の認可コード (authorizationCode) の長さの上限。Apple のコードは数百文字で、1,024 を超えることは無い
 * (超える値は本文の形の誤りとして 400 にする。POST /api/auth/apple/authorization の AppleAuthorizationBodySchema)
 */
export const APPLE_AUTHORIZATION_CODE_MAX_LENGTH = 1024;

/** 利用者に見せる固定の文 (Apple・GoTrue の英文は出さない) */
export const APPLE_SIGN_IN_MESSAGES = {
  /** Apple のシートは通ったが Supabase のセッションにできなかった (provider が無効・nonce の不一致・通信の失敗) */
  failed: 'Apple でのログインに失敗しました。しばらくしてからお試しください。',
  /** 新規登録画面の同じ失敗 */
  signupFailed: 'Apple での登録に失敗しました。しばらくしてからお試しください。',
  /** Apple が identityToken を返さなかった */
  noIdentityToken: 'Apple からログインの情報を受け取れませんでした。もう一度お試しください。',
} as const;
