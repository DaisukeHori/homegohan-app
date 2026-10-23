/**
 * Sign in with Apple のサーバ側の設定 (docs/design/mobile/08-sign-in-with-apple.md §11.2)。サーバ専用 (秘密を持つ)。
 * 4 つの環境変数は任意 (src/lib/env.ts の一覧)。Team ID・Key ID・秘密鍵のどれかが無ければ「未設定」で、交換と失効を行わない
 * (ログインは止めない)。Services ID は Web の OAuth の行にだけ要る。
 */
import { getOptionalEnv } from '@/lib/env';

/** iOS のアプリの client_id (= apps/mobile/app.json の ios.bundleIdentifier。src/__tests__/lib/auth/apple/config.test.ts が突き合わせる) */
export const APPLE_SIGN_IN_NATIVE_CLIENT_ID = 'com.homegohan.app';
/** 交換の API (F-14) */
export const APPLE_TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
/** 失効の API (F-14) */
export const APPLE_REVOKE_ENDPOINT = 'https://appleid.apple.com/auth/revoke';
/** client_secret の aud (F-14) */
export const APPLE_CLIENT_SECRET_AUDIENCE = 'https://appleid.apple.com';
/**
 * client_secret の有効期間 (秒)。要求のたびに作り直すので短くてよい。Apple の上限は 6 か月 (15,777,000 秒)。
 * 5 分 = サーバとの時計のずれ (数十秒) に耐え、漏れたときの使える時間を短くする
 */
export const APPLE_CLIENT_SECRET_TTL_SECONDS = 300;
/**
 * Apple の API の 1 回の応答を待つ最長 (ミリ秒)。ふだんは 1 秒以内。Turnstile の確認 (TURNSTILE_VERIFY_TIMEOUT_MS) と同じ 5 秒。
 * 交換 (/auth/token) はこの値。失効 (/auth/revoke) はこの値と、退会の段階の締め切りまでの残りの短いほう (APPLE_REVOKE_TOTAL_BUDGET_MS)
 */
export const APPLE_API_TIMEOUT_MS = 5000;
/**
 * 失効の試行の回数 (1 回目が失敗ならもう 1 回。失敗の種類 (通信の失敗・時間切れ・4xx・5xx) は区別しない)。
 * 2 回目も APPLE_REVOKE_TOTAL_BUDGET_MS の締め切りの前だけ試す (締め切りを過ぎたらやり直さない)
 */
export const APPLE_REVOKE_ATTEMPTS = 2;
/**
 * 退会の段階 apple_revoke 全体 (表の読み取りから最後の行の失効まで) に使ってよい時間 (ミリ秒)。設計書 §13.1 の計算:
 * 退会の route (src/app/api/account/delete/route.ts) の maxDuration 60 秒 − Storage の掃除の上限 45 秒
 * (src/lib/account-deletion-storage.ts の DEFAULT_MAX_DURATION_MS) − 完了メールの待ちの上限 5 秒
 * (src/lib/account-deletion-notification.ts の ACCOUNT_DELETED_EMAIL_TIMEOUT_MS) = 10 秒を、段階全体の上限を持たない段階
 * (DB の関数・Stripe・deleteUser。Stripe は 1 回の呼び出しに上限があるが段階全体の上限は無い) と分け合う。Apple に 3 秒、ほかの段階に 7 秒を残す。
 * 締め切りを過ぎた行は Apple を呼ばずに failed に数える (Apple の障害で退会の route の時間を超えない。裁定 2)。
 * 環境変数にしない: 3 つの上限と組で決まる値で、これだけを上げるとほかの段階の分 (7 秒) が減り、60 秒を超えうる (src/__tests__/lib/auth/apple/config.test.ts が 3 つの和 < 60 秒を確かめる)
 */
export const APPLE_REVOKE_TOTAL_BUDGET_MS = 3000;

export interface AppleSignInServerConfig {
  readonly teamId: string;
  readonly keyId: string;
  /** PEM 形式の PKCS#8 の秘密鍵 (BEGIN / END PRIVATE KEY の行で囲んだもの)。環境変数には改行を \n と書いて入れる (ここで戻す) */
  readonly privateKeyPem: string;
  /** Web の OAuth の client_id (Services ID)。無ければ null (Web の行は保管・失効しない) */
  readonly servicesId: string | null;
}

/** 環境変数の値の改行の書き方 (\n) を実際の改行に戻す */
function pemOf(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

/** 秘密がそろっていれば設定、そろっていなければ null (呼ぶたびに読む。値はログに出さない) */
export function readAppleSignInServerConfig(): AppleSignInServerConfig | null {
  const teamId = getOptionalEnv('APPLE_SIGN_IN_TEAM_ID')?.trim();
  const keyId = getOptionalEnv('APPLE_SIGN_IN_KEY_ID')?.trim();
  const privateKey = getOptionalEnv('APPLE_SIGN_IN_PRIVATE_KEY');
  const servicesId = getOptionalEnv('APPLE_SIGN_IN_SERVICES_ID')?.trim();
  if (!teamId || !keyId || !privateKey || privateKey.trim() === '') return null;
  return { teamId, keyId, privateKeyPem: pemOf(privateKey), servicesId: servicesId ? servicesId : null };
}
