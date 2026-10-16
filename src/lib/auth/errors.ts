/**
 * 認証・認可エラークラス群
 * cross/01-auth-session.md §14 + cross/04-api-conventions.md §4 準拠
 */

/**
 * 認証エラー基底クラス (未認証 / セッション異常 / プロフィール未発見 等)
 * HTTP 401 相当
 */
export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

/**
 * 権限エラークラス (ロール不足 / 組織不一致 等)
 * HTTP 403 相当
 */
export class ForbiddenError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ForbiddenError';
  }
}

export type MfaRequiredCode = 'AUTH_2FA_REQUIRED' | 'AUTH_2FA_ENROLLMENT_REQUIRED';

/**
 * 二段階認証が未完了 (challenge か登録が要る)。HTTP 403 相当 (#1176。docs/design/cross/12-operator-mfa.md §13.3)。
 * ForbiddenError の派生にしてあるので、既存の route の `catch (err instanceof ForbiddenError)` はそのまま 403 を返す。
 * 画面 (page-guard) だけが code を見て MFA の画面へ回す。401 にしない理由: 画面が未ログインと解釈してログイン画面と往復する。
 */
export class MfaRequiredError extends ForbiddenError {
  constructor(code: MfaRequiredCode, message?: string) {
    super(code, message);
    this.name = 'MfaRequiredError';
  }
}

/**
 * cross/01-auth-session.md §14 で定義された PermError (互換用エイリアス)
 * ForbiddenError を使用してください
 */
export { ForbiddenError as PermError };
