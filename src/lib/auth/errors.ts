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

/**
 * impersonate 専用エラークラス
 * super_admin 以外の実行・対象ユーザーが拒否設定 等
 */
export class ImpersonationError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ImpersonationError';
  }
}

/**
 * cross/01-auth-session.md §14 で定義された PermError (互換用エイリアス)
 * ForbiddenError を使用してください
 */
export { ForbiddenError as PermError };
