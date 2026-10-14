/**
 * ログイン中のパスワード変更・メールアドレス変更 (#1187) で、Supabase Auth が返したエラーを
 * 利用者向けの日本語に直す。
 *
 * 画面 (src/app/(main)/settings/account/page.tsx) は、エラーの中身をそのまま出さずにこの関数を通す。
 * GoTrue のメッセージは英語で、`For security purposes, you can only request this after 52 seconds.` のように
 * 内部の事情が混じるため。
 *
 * 判定に使うエラーコードは、ローカルの Supabase Auth (GoTrue v2.183.0) で実測した値:
 *   - 現在のパスワードが違う      : 400 invalid_credentials
 *   - 今のパスワードと同じ        : 422 same_password
 *   - パスワードが弱い            : 422 weak_password (reasons: ['length' | 'characters' | 'pwned'])
 *   - 使われているメールアドレス  : 422 email_exists
 *   - メールアドレスの形式が不正  : 400 validation_failed ("Unable to validate email address: invalid format")
 *   - 短時間の連続リクエスト      : 429 over_email_send_rate_limit / over_request_rate_limit
 *   - 通信の失敗                  : AuthRetryableFetchError (status 0)
 * コードが無い・未知のエラーは、メッセージと HTTP ステータスで判定し、それでも分からなければ汎用の文言にする。
 */

/** Supabase の AuthError のうち、文言の出し分けに使う部分だけ (テストで素のオブジェクトを渡せるようにしている) */
export interface AuthErrorLike {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
  /** AuthWeakPasswordError のみ: 弱い理由 */
  reasons?: readonly string[];
}

const NETWORK_MESSAGE = '通信に失敗しました。ネットワークの状態を確認して、もう一度お試しください。';
const RATE_LIMIT_MESSAGE = '短い時間に操作が続いたため、一時的に受け付けられません。しばらく待ってから、もう一度お試しください。';
const RELOGIN_MESSAGE = 'ログインの有効期限が切れた可能性があります。いったんログアウトして、ログインし直してからお試しください。';

/** ログインし直さないと先へ進めないことを示すエラーコード */
const RELOGIN_CODES: ReadonlySet<string> = new Set([
  'reauthentication_needed',
  'reauthentication_not_valid',
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'no_authorization',
  'bad_jwt',
  'user_not_found',
]);

function toErrorLike(error: unknown): AuthErrorLike {
  if (error && typeof error === 'object') {
    return error as AuthErrorLike;
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  return {};
}

/** 通信そのものが失敗した (オフライン・DNS・サーバーに届かない・ゲートウェイ障害) */
export function isNetworkAuthError(error: unknown): boolean {
  const e = toErrorLike(error);
  if (e.name === 'AuthRetryableFetchError') return true;
  if (e.status === 0) return true;
  // fetch が投げる TypeError (Chrome: "Failed to fetch" / Safari: "Load failed" / Firefox: "NetworkError ...")
  return /failed to fetch|load failed|networkerror|network request failed|fetch failed/i.test(e.message ?? '');
}

/** 短時間にリクエストしすぎた (サインインの上限・確認メールの送信間隔) */
export function isRateLimitAuthError(error: unknown): boolean {
  const e = toErrorLike(error);
  if (e.status === 429) return true;
  if (e.code === 'over_request_rate_limit' || e.code === 'over_email_send_rate_limit') return true;
  return /rate limit|too many requests|for security purposes/i.test(e.message ?? '');
}

/** ログイン状態が切れている (セッションが無い・失効した) */
export function isSessionExpiredAuthError(error: unknown): boolean {
  const e = toErrorLike(error);
  if (e.code && RELOGIN_CODES.has(e.code)) return true;
  if (e.name === 'AuthSessionMissingError') return true;
  if (e.status === 401) return true;
  return /auth session missing|session.*(not found|expired|missing)|invalid jwt|jwt expired/i.test(e.message ?? '');
}

/**
 * パスワード変更の失敗理由を日本語にする。
 *
 * @param step 'reauth': 現在のパスワードでの再認証 (signInWithPassword) / 'update': 新しいパスワードへの更新 (updateUser)
 */
export function describePasswordChangeError(error: unknown, step: 'reauth' | 'update'): string {
  const e = toErrorLike(error);

  if (isNetworkAuthError(e)) return NETWORK_MESSAGE;
  if (isRateLimitAuthError(e)) return RATE_LIMIT_MESSAGE;

  if (step === 'reauth') {
    if (e.code === 'invalid_credentials' || /invalid login credentials/i.test(e.message ?? '')) {
      return '現在のパスワードが正しくありません。';
    }
    return '現在のパスワードを確認できませんでした。時間をおいて、もう一度お試しください。';
  }

  if (e.code === 'same_password' || /should be different from the old password/i.test(e.message ?? '')) {
    return '新しいパスワードは、現在のパスワードと違うものにしてください。';
  }
  if (e.code === 'weak_password' || e.name === 'AuthWeakPasswordError') {
    if (Array.isArray(e.reasons) && e.reasons.includes('pwned')) {
      return 'このパスワードは過去に流出したことが確認されています。別のパスワードにしてください。';
    }
    return 'このパスワードは安全性の基準を満たしていません。別のパスワードにしてください。';
  }
  if (isSessionExpiredAuthError(e)) return RELOGIN_MESSAGE;

  return 'パスワードを変更できませんでした。時間をおいて、もう一度お試しください。';
}

/** メールアドレス変更 (updateUser({ email })) の失敗理由を日本語にする */
export function describeEmailChangeError(error: unknown): string {
  const e = toErrorLike(error);

  if (isNetworkAuthError(e)) return NETWORK_MESSAGE;
  if (isRateLimitAuthError(e)) {
    return '確認メールの送信が続いたため、一時的に受け付けられません。しばらく待ってから、もう一度お試しください。';
  }

  if (e.code === 'email_exists' || /already been registered|already registered/i.test(e.message ?? '')) {
    return 'このメールアドレスは、すでに別のアカウントで使われています。別のメールアドレスを入力してください。';
  }
  if (e.code === 'email_address_invalid' || /unable to validate email address|invalid format/i.test(e.message ?? '')) {
    return 'メールアドレスの形式が正しくありません。';
  }
  if (e.code === 'email_address_not_authorized') {
    return 'このメールアドレスには確認メールを送れません。別のメールアドレスを入力してください。';
  }
  if (isSessionExpiredAuthError(e)) return RELOGIN_MESSAGE;

  return 'メールアドレスの変更を受け付けられませんでした。時間をおいて、もう一度お試しください。';
}
