/**
 * 端末の通知 (Expo Push) のトークンの claim・release の取り決め (#1599 / #1636)。
 * サーバー (src/app/api/push-tokens/claim・release) とモバイル (apps/mobile/src/lib/pushNotifications.ts・pushTokenRelease.ts) が
 * 同じ値を使うため、置き場はこのファイルの 1 つにする。
 *
 * 端末の秘密の値 (install secret):
 *   - 端末ごと (アプリのインストールごと) に 1 つ。サーバーが乱数で作って claim の応答で 1 度だけ返し、端末が保管庫
 *     (expo-secure-store。iOS Keychain / Android Keystore) に置く。サーバーは値を持たず、SHA-256 のハッシュだけを
 *     user_push_tokens.install_secret_hash に持つ
 *   - 同じ端末でログインした利用者は、みな同じ値を持つ (利用者ごとではない)。claim は、同じトークンで同じハッシュの行
 *     (= 同じ端末の前の利用者の行) だけを外す。トークンの値を知っているだけの他人は、ハッシュの元の値を知らないので外せない
 *   - release (セッションが無いときの後片付け) は、この値で認可する (利用者 ID・トークン・ハッシュが合う行だけを消す)
 */

/**
 * claim の API (POST。ログイン中の本人だけ)。メンテナンス中・凍結中でも middleware が止めない (src/lib/push-tokens.ts)。
 * 規約の同意ゲートでも止めない (legal-consent-api.ts の LEGAL_CONSENT_EXEMPT_API_PATHS に exact の行がある)
 */
export const PUSH_TOKEN_CLAIM_API_PATH = '/api/push-tokens/claim';

/** release の API (POST。セッション無しで、端末の秘密の値で認可する)。メンテナンス中は止まる (次の起動でやり直す) */
export const PUSH_TOKEN_RELEASE_API_PATH = '/api/push-tokens/release';

/**
 * 端末の秘密の値の長さ (バイト)。256 bit の乱数で、総当たりで当てられない長さにする。
 * base64url (詰め物の = なし) にすると 43 文字 (PUSH_INSTALL_SECRET_PATTERN)
 */
export const PUSH_INSTALL_SECRET_BYTES = 32;

/** 端末の秘密の値の形 (32 バイトの base64url。詰め物の = なし) */
export const PUSH_INSTALL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 値が端末の秘密の値の形なら true */
export function isPushInstallSecret(value: unknown): value is string {
  return typeof value === 'string' && PUSH_INSTALL_SECRET_PATTERN.test(value);
}

/**
 * claim の本文 (POST /api/push-tokens/claim)。
 *   - install_secret: 端末に秘密の値があるとき。サーバーは本人の行にそのハッシュを書き、同じトークン・同じハッシュ
 *     (と、ハッシュの無い古い行) のほかの利用者の行を外す
 *   - issue_install_secret: true: 端末に秘密の値がまだ無いとき。サーバーが値を作って本人の行にハッシュを書き、
 *     応答の install_secret で 1 度だけ返す。外すのはハッシュの無い古い行だけ
 *   - どちらも無い: 古い版のアプリ (#1636 より前)、または保管庫を読めなかったとき。本人の行のハッシュには触れず、
 *     ハッシュの無い古い行だけを外す
 * 両方を同時に送ると 400
 */
export type PushTokenClaimRequestBody = {
  expo_push_token: string;
  install_secret?: string;
  issue_install_secret?: true;
};

/** claim の 200 の本文。install_secret は issue_install_secret: true のときだけ付く */
export type PushTokenClaimResponseBody = {
  released: number;
  install_secret?: string;
};

/** release の本文 (POST /api/push-tokens/release) */
export type PushTokenReleaseRequestBody = {
  expo_push_token: string;
  install_secret: string;
  /** 行を消す利用者 (サインアウトした利用者)。この利用者の行だけを消す (次にログインした利用者の行を巻き込まない) */
  user_id: string;
};

/** release の 200 の本文 */
export type PushTokenReleaseResponseBody = {
  released: number;
};
