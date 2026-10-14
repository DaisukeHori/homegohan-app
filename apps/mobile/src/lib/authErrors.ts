/**
 * Supabase Auth のエラーを、セッションを捨てるべきかどうかで分類する (#1038 F7-07)。
 *
 * 以前の AuthProvider は、起動時の getUser() が何らかのエラーを返すと一律で「セッション失効」とみなして
 * signOut していた。機内モードやサーバーの一時障害でも失効扱いになり、ログイン済みのユーザーが
 * ウェルカム画面 (未ログインの画面) に落ちていた。
 *
 *   - "invalid"   : サーバーが「このセッションはもう使えない」と答えた (401/403、session_not_found など)。セッションを捨てる
 *   - "transient" : 通信できなかった・サーバーが一時的に不調・レート制限。失効とは限らないので、保存済みのセッションを信頼する
 *   - "unknown"   : 上のどちらとも言えない。誤ってログアウトさせないよう、"transient" と同じく捨てない
 *
 * supabase-js のエラーは AuthApiError (HTTP の応答。status / code を持つ) と AuthRetryableFetchError
 * (通信失敗。status は 0、または 502/503/504) など。クラスは import せず name / status / code で判定する
 * (バージョン違いで instanceof が合わなくなるのを避ける)。
 */

export type AuthErrorKind = "invalid" | "transient" | "unknown";

type AuthErrorLike = {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
};

/** サーバーが「セッション・ユーザー・トークンはもう存在しない/使えない」と返すときの code (GoTrue のエラーコード) */
const INVALID_SESSION_CODES = new Set([
  "session_not_found",
  "session_expired",
  "user_not_found",
  "bad_jwt",
  "refresh_token_not_found",
  "refresh_token_already_used",
]);

/** code が付かない古い応答のメッセージ */
const INVALID_SESSION_MESSAGE = /invalid refresh token|refresh token not found|refresh_token_not_found|session.+not.+found|user.+not.+found/i;

/** fetch が投げる例外 (TypeError: Network request failed など) のメッセージ */
const NETWORK_MESSAGE = /network|fetch|timed? ?out|offline|connection|socket|econn|enotfound/i;

export function classifyAuthError(error: unknown): AuthErrorKind {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as AuthErrorLike;
  const name = typeof e.name === "string" ? e.name : "";
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  const status = typeof e.status === "number" ? e.status : undefined;

  if (name === "AuthRetryableFetchError") return "transient";

  // 失効を示す code は status より優先する (code 付きなら確実)
  if (INVALID_SESSION_CODES.has(code)) return "invalid";
  if (name === "AuthSessionMissingError") return "invalid";

  if (status !== undefined) {
    if (status === 401 || status === 403) return "invalid";
    // 通信失敗 (0)・タイムアウト (408)・レート制限 (429)・サーバー側の不調 (5xx)
    if (status === 0 || status === 408 || status === 429 || status >= 500) return "transient";
    if (status >= 400 && INVALID_SESSION_MESSAGE.test(message)) return "invalid";
    return "unknown";
  }

  if (INVALID_SESSION_MESSAGE.test(message)) return "invalid";
  // status を持たない例外は fetch 自体の失敗 (オフライン等) の可能性が高い
  if (error instanceof TypeError || NETWORK_MESSAGE.test(message)) return "transient";
  return "unknown";
}

/** セッションを捨ててよいエラーか (サーバーが失効を明言したときだけ true) */
export function isSessionInvalidError(error: unknown): boolean {
  return classifyAuthError(error) === "invalid";
}

/** 通信失敗やサーバーの一時障害か */
export function isTransientAuthError(error: unknown): boolean {
  return classifyAuthError(error) === "transient";
}
