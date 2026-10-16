/**
 * tests/e2e/helpers/test-session.mjs
 *
 * テスト用のセッション (ログインした状態) を、パスワードのログインを使わずに作る (#1547)。
 *
 * Supabase の CAPTCHA (Turnstile) を有効にすると、トークンの無い `/auth/v1/token?grant_type=password` は断られる。
 * テストの道具はトークンを付けられないので、管理用の鍵 (service_role) でセッションを作る。
 * パスワードのログインを自分で呼ばず、ここの createTestSession を呼ぶ:
 *   - e2e の各所 (global-setup・fixtures・helpers・spec。Playwright が TypeScript から読む)
 *   - デプロイ後の動作確認の --with-auth (scripts/lib/smoke.mjs。node でそのまま動かす)
 * 両方から import できるよう、このファイルは依存の無い素の JavaScript (ES modules) で書き、型は JSDoc で書く
 * (同じ手順を各所に写さない。tests/e2e-test-session.test.ts が、ほかに /auth/v1/admin/generate_link・/auth/v1/verify を
 * 直接呼ぶファイルが無いことを検査する)。
 * Maestro の apps/mobile/maestro/flows/scripts/reset-onboarding.js だけは、Maestro の JavaScript (GraalJS) で動き
 * import できないので、同じ手順を写している (やり直す回数の解釈が同じことを tests/e2e-test-session.test.ts が突き合わせる)。
 *
 * 手順 (どちらも Supabase Auth の REST をそのまま呼ぶ。メールは送られない):
 *   1. service_role で POST /auth/v1/admin/generate_link ({ type: "recovery", email }) → 応答の hashed_token
 *   2. anon key で POST /auth/v1/verify ({ type: "recovery", token_hash }) → セッション
 *      (access_token / refresh_token / expires_at など。パスワードのログインの応答と同じ形)
 *
 * CAPTCHA の対象外である根拠 (Supabase Auth = github.com/supabase/auth の v2.183.0。このリポジトリの
 * supabase/.temp/gotrue-version の版。2026-10-14 に master でも同じであることを確かめた):
 *   - internal/api/api.go: CAPTCHA の検査 (verifyCaptcha) が掛かるのは /signup・/recover・/resend・/magiclink・/otp・
 *     /token・/sso・パスキーの認証だけ。/verify と /admin/generate_link (管理用の鍵の検査 requireAdminCredentials だけ) には掛からない
 *   - internal/api/verify.go: /verify の処理の中にも CAPTCHA の検査は無い。token_hash だけで受け付ける
 *     (email を一緒に送ると断られるので送らない)
 *
 * type を magiclink ではなく recovery にした理由: magiclink は、そのメールアドレスのユーザーがいないと、
 * 新しいユーザーを作ってしまう (internal/api/mail.go の adminGenerateLink が signup に切り替える。本番に向けて
 * メールアドレスを打ち間違えると、本番にアカウントができる)。recovery は、ユーザーがいなければ 404 で止まり、何も作らない。
 * いるユーザーに対しては、どちらも同じ recovery_token を発行し、/verify で同じ処理 (recoverVerify) を通る。
 *
 * 同じメールアドレスで並行に呼ばれたとき (worker がテストユーザーを共有するとき。fixtures/auth.ts の authedPage や、
 * e2e と --with-auth を同じテストユーザーで同時に流したとき):
 *   generate_link は、そのユーザーのトークンを発行し直す (internal/api/mail.go の adminGenerateLink が users の recovery_token を
 *   新しいハッシュで上書きし、internal/models/one_time_token.go の CreateOneTimeToken も最初に同じ種類の既存のトークンを消す)。
 *   そのため、先に発行した側の /verify はトークンが見つからず 403 (otp_expired。internal/api/verify.go) になる。パスワードのログインでは
 *   起きなかった競合なので、/verify の 403 は generate_link からやり直す (回数は testSessionMaxAttempts。待ち時間は乱数で
 *   ずらし、同じ競合を繰り返さないようにする)。
 *
 * 運営の MFA (#1176。docs/design/cross/12-operator-mfa.md §22.4.3): 必須ロールの運営の画面・API は aal2 のセッションだけを通すので、
 * promoteTestSessionToAal2 が createTestSession のセッション (aal1) に TOTP を登録・確認して aal2 にする
 * (anon key と Bearer access_token で /auth/v1/factors → /factors/{id}/challenge → /factors/{id}/verify。
 * tests/e2e-test-session.test.ts が、ほかに /auth/v1/factors を直接呼ぶファイルが無いことを検査する)。
 *
 * 鍵の値は、出力・ログ・失敗の結果に含めない (失敗の結果は、どの段かと HTTP のステータスと説明。応答の本文の先頭は
 * responseBodyPreview に分けて持つので、本文を出さない呼び出し側 (smoke) は説明だけを出せる)。
 */

import { generateTotp } from "./totp.mjs";

/** 読む環境変数の名前 (今までのテストと同じもの。値は出さない) */
export const TEST_SESSION_ENV_NAMES = Object.freeze({
  supabaseUrl: "NEXT_PUBLIC_SUPABASE_URL",
  anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
});

/** generate_link と verify に渡す type。理由はファイルの先頭のコメント */
export const TEST_SESSION_LINK_TYPE = "recovery";

/** 失敗の結果に載せる、応答の本文の先頭の長さ (長い HTML のエラーページで出力が埋まらないように) */
const ERROR_BODY_PREVIEW_CHARS = 200;

/** 「通信できなかった」「設定が足りない」ときの status (HTTP の応答が無い) */
export const TEST_SESSION_NO_HTTP_STATUS = 0;

/** /verify がトークンを見つけられなかったときの status (otp_expired。並行の generate_link に消された。ファイルの先頭のコメント) */
export const TEST_SESSION_VERIFY_RETRY_STATUS = 403;

/**
 * /verify の 403 で generate_link からやり直すときの、試す回数の上限 (最初の 1 回を含む)。
 * テストユーザーを共有する worker の数 (playwright.config.ts は CI 以外で workers を指定しないので CPU コアの半分。
 * ユーザーが 1 人のときは全 worker) がぶつかっても、待ち時間の乱数でずれて、どれかが先に確認を済ませる。
 * ぶつかった中で最後に発行した側は、その後に誰も発行しなければ確認を済ませて抜けるので、やり直すたびに競う数は減っていく。
 * 待ち時間の幅も回数とともに広がるので、数回で足りる。足りずに 403 のまま終われば、そのまま失敗として返す。
 * TEST_SESSION_MAX_ATTEMPTS_ENV で上書きできる (worker を増やして足りなくなったとき)。
 */
export const TEST_SESSION_DEFAULT_MAX_ATTEMPTS = 6;

/** TEST_SESSION_DEFAULT_MAX_ATTEMPTS を上書きする環境変数の名前 (1 以上の整数。それ以外の値は無視して既定を使う) */
export const TEST_SESSION_MAX_ATTEMPTS_ENV = "E2E_TEST_SESSION_MAX_ATTEMPTS";

/**
 * やり直す前の待ち時間の基準 (ms)。n 回目のやり直しの前に [0, 基準 × n) の乱数だけ待つ。
 * ぶつかった相手と同じ間隔でやり直すと、また同じ順で消し合うので、乱数でずらす。1 回の generate_link → verify は
 * ローカルでも本番でも数十〜数百 ms なので、その数倍の幅にしてある。
 */
export const TEST_SESSION_RETRY_BASE_DELAY_MS = 200;

/**
 * @typedef {Record<string, string | undefined>} TestSessionEnv 読む環境変数 (process.env と同じ形)
 */

/**
 * @typedef {object} TestSessionConfig
 * @property {string} supabaseUrl - Supabase の URL (末尾の / は付けない)
 * @property {string} anonKey - anon key (公開用)
 * @property {string} serviceRoleKey - service_role (管理用の鍵)
 */

/**
 * Supabase Auth のセッション (パスワードのログインの応答と同じ形)。@supabase/ssr の Cookie にそのまま入れる
 * @typedef {{ access_token: string; refresh_token?: string; expires_at?: number; expires_in?: number; token_type?: string; [key: string]: unknown }} SupabaseSessionJson
 */

/** @typedef {"config" | "generate_link" | "verify" | "mfa-enroll" | "mfa-challenge" | "mfa-verify"} TestSessionStep */

/**
 * 失敗の結果。
 *   - step: どの段で失敗したか
 *   - status: HTTP のステータス。応答が無い (通信できない・設定が足りない) ときは TEST_SESSION_NO_HTTP_STATUS
 *   - detail: 人が読む説明 (鍵の値・応答の本文は含めない)
 *   - responseBodyPreview: HTTP の失敗のときだけ。応答の本文の先頭 (ERROR_BODY_PREVIEW_CHARS 文字まで)
 *   - cause: 通信できなかったときだけ。fetch が投げた例外 (呼び出し側が時間切れなどを自分の書き方で説明するため)
 * @typedef {{ ok: false; step: TestSessionStep; status: number; detail: string; responseBodyPreview?: string; cause?: unknown }} TestSessionFailure
 */

/** @typedef {{ ok: true; session: SupabaseSessionJson } | TestSessionFailure} TestSessionResult */

/**
 * @typedef {object} CreateTestSessionOptions
 * @property {TestSessionEnv} [env] - 設定と回数の上限を読む環境変数。省略時は process.env
 * @property {TestSessionConfig | null} [config] - 省略時は env から読む (readTestSessionConfig)
 * @property {typeof fetch} [fetchImpl] - 送る関数 (smoke は時間切れ付きの fetch を渡す。単体テストは差し替える)。省略時は globalThis.fetch
 * @property {number} [maxAttempts] - 試す回数の上限 (最初の 1 回を含む)。省略時は testSessionMaxAttempts(env)
 * @property {(ms: number) => Promise<void>} [sleepImpl] - やり直す前に待つ (単体テストで差し替える)。省略時は setTimeout
 * @property {() => number} [randomImpl] - [0, 1) の乱数 (単体テストで差し替える)。省略時は Math.random
 */

/**
 * /verify の 403 でやり直すときの、試す回数の上限 (最初の 1 回を含む)。
 * 環境変数 TEST_SESSION_MAX_ATTEMPTS_ENV が 1 以上の整数 (前後の空白は無視) ならその値、そうでなければ TEST_SESSION_DEFAULT_MAX_ATTEMPTS。
 *
 * @param {TestSessionEnv} [env] - 読む環境変数 (省略時は process.env)
 * @returns {number}
 */
export function testSessionMaxAttempts(env = process.env) {
  const raw = env[TEST_SESSION_MAX_ATTEMPTS_ENV];
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  return TEST_SESSION_DEFAULT_MAX_ATTEMPTS;
}

/**
 * 必須ロール。src/lib/auth/mfa/policy.ts の MFA_REQUIRED_ROLES の写し
 * (.mjs は TypeScript を import できない。一致は tests/e2e-test-session.test.ts が確かめる)
 */
export const E2E_MFA_REQUIRED_ROLES = Object.freeze(["super_admin", "admin", "finance", "org_industrial_doctor"]);

/** 昇格で登録する factor の表示名 (1 利用者 1 個) */
export const E2E_TOTP_FRIENDLY_NAME = "e2e-authenticator";

/**
 * promoteTestSessionToAal2 の 429 を injectSession が例外にするときの頭 (結合の MFA_PROMOTION_RATE_LIMITED_MESSAGE と同じ文)。
 * ローカルの Supabase では MFA の回数制限が効かない前提で、待って試し直さない (§22.4.4)
 */
export const E2E_MFA_PROMOTION_RATE_LIMITED_MESSAGE =
  "Supabase の MFA の回数制限 (429) に当たりました。ローカルの Supabase では MFA の回数制限が効かない前提です (docs/design/cross/12-operator-mfa.md §22.4.4。結合テスト M-13 を確かめてください)";

/** MFA の回数制限の HTTP ステータス (やり直さない) */
export const E2E_MFA_RATE_LIMITED_STATUS = 429;

/**
 * 環境変数から、テスト用のセッションを作るのに要る値を読む。1 つでも無ければ null。
 *
 * @param {TestSessionEnv} [env] - 読む環境変数 (省略時は process.env)
 * @returns {TestSessionConfig | null}
 */
export function readTestSessionConfig(env = process.env) {
  const supabaseUrl = env[TEST_SESSION_ENV_NAMES.supabaseUrl];
  const anonKey = env[TEST_SESSION_ENV_NAMES.anonKey];
  const serviceRoleKey = env[TEST_SESSION_ENV_NAMES.serviceRoleKey];
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return null;
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), anonKey, serviceRoleKey };
}

/**
 * 足りない環境変数の名前 (値は出さない)
 *
 * @param {TestSessionEnv} [env] - 読む環境変数 (省略時は process.env)
 * @returns {string[]}
 */
export function missingTestSessionEnv(env = process.env) {
  return Object.values(TEST_SESSION_ENV_NAMES).filter((name) => !env[name]);
}

/**
 * @param {Response} resp
 * @returns {Promise<string>}
 */
async function readBodyPreview(resp) {
  const text = await resp.text().catch(() => "");
  return text.substring(0, ERROR_BODY_PREVIEW_CHARS);
}

/**
 * @param {TestSessionStep} step
 * @param {number} status
 * @param {string} detail
 * @param {{ responseBodyPreview?: string; cause?: unknown }} [extra]
 * @returns {TestSessionFailure}
 */
function failure(step, status, detail, extra = {}) {
  return { ok: false, step, status, detail, ...extra };
}

/**
 * @param {TestSessionStep} step
 * @param {Response} resp
 * @returns {Promise<TestSessionFailure>}
 */
async function httpFailure(step, resp) {
  return failure(step, resp.status, `HTTP ${resp.status}`, { responseBodyPreview: await readBodyPreview(resp) });
}

/**
 * @param {TestSessionStep} step
 * @param {unknown} err
 * @returns {TestSessionFailure}
 */
function networkFailure(step, err) {
  return failure(step, TEST_SESSION_NO_HTTP_STATUS, `通信できませんでした: ${String(err)}`, { cause: err });
}

/**
 * @param {TestSessionResult} result
 * @returns {boolean}
 */
function isVerifyRetry(result) {
  return !result.ok && result.step === "verify" && result.status === TEST_SESSION_VERIFY_RETRY_STATUS;
}

/**
 * email のユーザーのセッションを、パスワードのログインを使わずに作る。例外は投げず、結果で返す。
 * ユーザーがいなければ、作らずに失敗を返す (generate_link が 404)。
 * /verify が 403 (並行の呼び出しにトークンを消された) なら、乱数で待ってから generate_link からやり直す
 * (上限は options.maxAttempts。ファイルの先頭のコメント)。それ以外の失敗はやり直さずに返す (429 などは呼び出し側が決める)。
 *
 * @param {string} email - セッションを作るユーザーのメールアドレス (既にいるユーザー)
 * @param {CreateTestSessionOptions} [options]
 * @returns {Promise<TestSessionResult>}
 */
export async function createTestSession(email, options = {}) {
  const env = options.env ?? process.env;
  const config = options.config === undefined ? readTestSessionConfig(env) : options.config;
  if (!config) {
    const missing = missingTestSessionEnv(env);
    const names = missing.length > 0 ? missing : Object.values(TEST_SESSION_ENV_NAMES);
    return failure("config", TEST_SESSION_NO_HTTP_STATUS, `環境変数 ${names.join(" / ")} が未設定です`);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? testSessionMaxAttempts(env);
  const sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const randomImpl = options.randomImpl ?? Math.random;

  let result = await createTestSessionOnce(email, config, fetchImpl);
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    if (!isVerifyRetry(result)) return result;
    await sleepImpl(Math.floor(randomImpl() * TEST_SESSION_RETRY_BASE_DELAY_MS * attempt));
    result = await createTestSessionOnce(email, config, fetchImpl);
  }
  if (!result.ok && isVerifyRetry(result)) {
    return { ...result, detail: `${result.detail} (generate_link から ${maxAttempts} 回試しました)` };
  }
  return result;
}

/**
 * generate_link → verify を 1 回だけ行う (やり直しは createTestSession)
 *
 * @param {string} email
 * @param {TestSessionConfig} config
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<TestSessionResult>}
 */
async function createTestSessionOnce(email, config, fetchImpl) {
  // 1. 管理用の鍵で、ワンタイムのトークン (のハッシュ) を発行する。メールは送られない
  /** @type {Response} */
  let linkResp;
  try {
    linkResp = await fetchImpl(`${config.supabaseUrl}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
      body: JSON.stringify({ type: TEST_SESSION_LINK_TYPE, email }),
    });
  } catch (err) {
    return networkFailure("generate_link", err);
  }
  if (!linkResp.ok) return httpFailure("generate_link", linkResp);
  /** @type {{ hashed_token?: unknown } | null} */
  const link = await linkResp.json().catch(() => null);
  const tokenHash = link?.hashed_token;
  if (typeof tokenHash !== "string" || !tokenHash) {
    return failure("generate_link", linkResp.status, "応答に hashed_token がありません");
  }

  // 2. そのトークンでセッションを受け取る (/verify には CAPTCHA が掛からない)
  /** @type {Response} */
  let verifyResp;
  try {
    verifyResp = await fetchImpl(`${config.supabaseUrl}/auth/v1/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.anonKey,
      },
      body: JSON.stringify({ type: TEST_SESSION_LINK_TYPE, token_hash: tokenHash }),
    });
  } catch (err) {
    return networkFailure("verify", err);
  }
  if (!verifyResp.ok) return httpFailure("verify", verifyResp);
  /** @type {SupabaseSessionJson | null} */
  const session = await verifyResp.json().catch(() => null);
  if (!session || typeof session.access_token !== "string" || !session.access_token) {
    return failure("verify", verifyResp.status, "応答に access_token がありません");
  }
  return { ok: true, session };
}

/**
 * 失敗の結果を 1 行の説明にする (e2e のログ用。鍵の値は含まない。応答の本文の先頭は付ける)
 *
 * @param {TestSessionFailure} result
 * @returns {string}
 */
export function describeTestSessionFailure(result) {
  const body = result.responseBodyPreview ? `: ${result.responseBodyPreview}` : "";
  return `テスト用のセッションを作れませんでした (${result.step}): ${result.detail}${body}`;
}

/**
 * @typedef {{ ok: true; session: SupabaseSessionJson; factorId: string; secret: string } | TestSessionFailure} PromoteTestSessionResult
 */

/**
 * @typedef {object} PromoteTestSessionOptions
 * @property {TestSessionEnv} [env] - 設定を読む環境変数。省略時は process.env
 * @property {TestSessionConfig | null} [config] - 省略時は env から読む (readTestSessionConfig)
 * @property {typeof fetch} [fetchImpl] - 送る関数 (単体テストは差し替える)。省略時は globalThis.fetch
 * @property {(secret: string) => string} [totpImpl] - 6 桁を作る関数 (単体テストで差し替える)。省略時は totp.mjs の generateTotp
 */

/**
 * createTestSession の session (aal1) を aal2 にする (#1176。docs/design/cross/12-operator-mfa.md §22.4.3)。
 * anon key (apikey) と Authorization: Bearer <session.access_token> で
 *   POST /auth/v1/factors { factor_type: 'totp', friendly_name: E2E_TOTP_FRIENDLY_NAME } → { id, totp: { secret } }
 *   POST /auth/v1/factors/{id}/challenge → { id: challengeId }
 *   POST /auth/v1/factors/{id}/verify { challenge_id, code: generateTotp(secret) } → 新しい session (aal2)
 * 戻り: { ok: true, session, factorId, secret } か、createTestSession と同じ形の失敗 ({ ok: false, step: 'mfa-enroll' | 'mfa-challenge' | 'mfa-verify' | 'config', status, ... })。
 * 失敗の説明に鍵・トークン・secret の値を入れない。challenge / verify の 429 はやり直さず、そのまま失敗として返す (§22.4.4)。
 * verify は同じ利用者の他の aal1 のセッションを終える (§26.3) ので、1 利用者につき 1 回 (最初のセッション) だけ呼ぶ。
 *
 * @param {SupabaseSessionJson} session - createTestSession の session (aal1)
 * @param {PromoteTestSessionOptions} [options]
 * @returns {Promise<PromoteTestSessionResult>}
 */
export async function promoteTestSessionToAal2(session, options = {}) {
  const env = options.env ?? process.env;
  const config = options.config === undefined ? readTestSessionConfig(env) : options.config;
  if (!config) {
    const missing = missingTestSessionEnv(env);
    const names = missing.length > 0 ? missing : Object.values(TEST_SESSION_ENV_NAMES);
    return failure("config", TEST_SESSION_NO_HTTP_STATUS, `環境変数 ${names.join(" / ")} が未設定です`);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const totpImpl = options.totpImpl ?? ((secret) => generateTotp(secret));
  const headers = {
    "Content-Type": "application/json",
    apikey: config.anonKey,
    Authorization: `Bearer ${session.access_token}`,
  };

  // 1. TOTP の factor を登録する (unverified)
  /** @type {Response} */
  let enrollResp;
  try {
    enrollResp = await fetchImpl(`${config.supabaseUrl}/auth/v1/factors`, {
      method: "POST",
      headers,
      body: JSON.stringify({ factor_type: "totp", friendly_name: E2E_TOTP_FRIENDLY_NAME }),
    });
  } catch (err) {
    return networkFailure("mfa-enroll", err);
  }
  if (!enrollResp.ok) return httpFailure("mfa-enroll", enrollResp);
  /** @type {{ id?: unknown; totp?: { secret?: unknown } } | null} */
  const factor = await enrollResp.json().catch(() => null);
  const factorId = factor?.id;
  const secret = factor?.totp?.secret;
  if (typeof factorId !== "string" || !factorId || typeof secret !== "string" || !secret) {
    return failure("mfa-enroll", enrollResp.status, "応答に factor の id か TOTP の secret がありません");
  }
  const factorPath = `${config.supabaseUrl}/auth/v1/factors/${encodeURIComponent(factorId)}`;

  // 2. challenge を作る
  /** @type {Response} */
  let challengeResp;
  try {
    challengeResp = await fetchImpl(`${factorPath}/challenge`, { method: "POST", headers, body: "{}" });
  } catch (err) {
    return networkFailure("mfa-challenge", err);
  }
  if (!challengeResp.ok) return httpFailure("mfa-challenge", challengeResp);
  /** @type {{ id?: unknown } | null} */
  const challenge = await challengeResp.json().catch(() => null);
  const challengeId = challenge?.id;
  if (typeof challengeId !== "string" || !challengeId) {
    return failure("mfa-challenge", challengeResp.status, "応答に challenge の id がありません");
  }

  // 3. 6 桁で確かめる → aal2 のセッション
  /** @type {Response} */
  let verifyResp;
  try {
    verifyResp = await fetchImpl(`${factorPath}/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ challenge_id: challengeId, code: totpImpl(secret) }),
    });
  } catch (err) {
    return networkFailure("mfa-verify", err);
  }
  if (!verifyResp.ok) return httpFailure("mfa-verify", verifyResp);
  /** @type {SupabaseSessionJson | null} */
  const promoted = await verifyResp.json().catch(() => null);
  if (!promoted || typeof promoted.access_token !== "string" || !promoted.access_token) {
    return failure("mfa-verify", verifyResp.status, "応答に access_token がありません");
  }
  return { ok: true, session: promoted, factorId, secret };
}
