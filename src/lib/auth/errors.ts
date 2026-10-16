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
 * user_profiles の読み取りそのものが失敗したとき (行が無いのとは別)。HTTP 500 相当 (AuthError / ForbiddenError ではない)。
 * 行の無い利用者を通す requireUserAllowingMissingProfile (helpers.ts。#1751) が、凍結を確かめられないまま通さないために投げる。
 * PostgREST のエラーは cause に入れ、message には入れない (応答の本文に DB の生の文を出さない。route は internalError の 500)。
 */
export class UserProfileReadError extends Error {
  /** PostgREST / PostgreSQL のエラーコード (PGRST301 など)。internalError がログの error_code にだけ残す (本文には出ない) */
  public readonly code: string | undefined;

  constructor(cause: unknown) {
    super('user_profiles の読み取りに失敗しました', { cause });
    this.name = 'UserProfileReadError';
    const code = (cause as { code?: unknown } | null | undefined)?.code;
    this.code = typeof code === 'string' && code ? code : undefined;
  }
}

/**
 * cross/01-auth-session.md §14 で定義された PermError (互換用エイリアス)
 * ForbiddenError を使用してください
 */
export { ForbiddenError as PermError };
