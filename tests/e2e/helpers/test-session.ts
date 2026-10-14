/**
 * tests/e2e/helpers/test-session.ts
 *
 * e2e のテスト用のセッション (ログインした状態) を、パスワードのログインを使わずに作る (#1547)。
 *
 * Supabase の CAPTCHA (Turnstile) を有効にすると、トークンの無い `/auth/v1/token?grant_type=password` は断られる。
 * テストの道具はトークンを付けられないので、管理用の鍵 (service_role) でセッションを作る。e2e の各所
 * (global-setup・fixtures・helpers・spec) は、パスワードのログインを自分で呼ばず、ここの createTestSession を呼ぶ。
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
 * 同じメールアドレスで並行に呼ばれたとき (worker がテストユーザーを共有するとき。fixtures/auth.ts の authedPage など):
 *   generate_link は、そのユーザーの同じ種類のトークンを発行し直す (internal/api/mail.go の adminGenerateLink →
 *   internal/models/one_time_token.go の CreateOneTimeToken が、最初に同じ種類の既存のトークンを消す)。そのため、
 *   先に発行した側の /verify はトークンが見つからず 403 (otp_expired。internal/api/verify.go) になる。パスワードのログインでは
 *   起きなかった競合なので、/verify の 403 は generate_link からやり直す (回数は testSessionMaxAttempts。待ち時間は乱数で
 *   ずらし、同じ競合を繰り返さないようにする)。
 *
 * 鍵の値は、出力・ログ・例外のメッセージに含めない (失敗の報告は、どの段かと HTTP のステータスと、応答の本文の先頭だけ)。
 */

/** 読む環境変数の名前 (今までのテストと同じもの。値は出さない) */
export const TEST_SESSION_ENV_NAMES = {
  supabaseUrl: "NEXT_PUBLIC_SUPABASE_URL",
  anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
} as const;

/** generate_link と verify に渡す type。理由はファイルの先頭のコメント */
export const TEST_SESSION_LINK_TYPE = "recovery";

/** 失敗の報告に載せる、応答の本文の先頭の長さ (長い HTML のエラーページで出力が埋まらないように) */
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

export interface TestSessionConfig {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

/** Supabase Auth のセッション (パスワードのログインの応答と同じ形)。@supabase/ssr の Cookie にそのまま入れる */
export interface SupabaseSessionJson {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  [key: string]: unknown;
}

export type TestSessionStep = "config" | "generate_link" | "verify";

export type TestSessionResult =
  | { ok: true; session: SupabaseSessionJson }
  | {
      ok: false;
      /** どの段で失敗したか */
      step: TestSessionStep;
      /** HTTP のステータス。応答が無い (通信できない・設定が足りない) ときは TEST_SESSION_NO_HTTP_STATUS */
      status: number;
      /** 人が読む説明 (鍵の値は含めない) */
      detail: string;
    };

export interface CreateTestSessionOptions {
  /** 省略時は環境変数から読む (readTestSessionConfig) */
  config?: TestSessionConfig | null;
  /** 単体テストで差し替える。省略時は globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 試す回数の上限 (最初の 1 回を含む)。省略時は testSessionMaxAttempts() */
  maxAttempts?: number;
  /** 単体テストで差し替える (やり直す前に待つ)。省略時は setTimeout */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 単体テストで差し替える ([0, 1) の乱数)。省略時は Math.random */
  randomImpl?: () => number;
}

/**
 * /verify の 403 でやり直すときの、試す回数の上限 (最初の 1 回を含む)。
 * 環境変数 TEST_SESSION_MAX_ATTEMPTS_ENV が 1 以上の整数ならその値、そうでなければ TEST_SESSION_DEFAULT_MAX_ATTEMPTS。
 *
 * @param env - 読む環境変数 (省略時は process.env)
 */
export function testSessionMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TEST_SESSION_MAX_ATTEMPTS_ENV];
  if (raw && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  return TEST_SESSION_DEFAULT_MAX_ATTEMPTS;
}

/**
 * 環境変数から、テスト用のセッションを作るのに要る値を読む。1 つでも無ければ null。
 *
 * @param env - 読む環境変数 (省略時は process.env)
 */
export function readTestSessionConfig(env: NodeJS.ProcessEnv = process.env): TestSessionConfig | null {
  const supabaseUrl = env[TEST_SESSION_ENV_NAMES.supabaseUrl];
  const anonKey = env[TEST_SESSION_ENV_NAMES.anonKey];
  const serviceRoleKey = env[TEST_SESSION_ENV_NAMES.serviceRoleKey];
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return null;
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), anonKey, serviceRoleKey };
}

/** 足りない環境変数の名前 (値は出さない) */
export function missingTestSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.values(TEST_SESSION_ENV_NAMES).filter((name) => !env[name]);
}

async function readBodyPreview(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  return text.substring(0, ERROR_BODY_PREVIEW_CHARS);
}

function failure(step: TestSessionStep, status: number, detail: string): TestSessionResult {
  return { ok: false, step, status, detail };
}

/**
 * email のユーザーのセッションを、パスワードのログインを使わずに作る。例外は投げず、結果で返す。
 * ユーザーがいなければ、作らずに失敗を返す (generate_link が 404)。
 * /verify が 403 (並行の呼び出しにトークンを消された) なら、乱数で待ってから generate_link からやり直す
 * (上限は options.maxAttempts。ファイルの先頭のコメント)。それ以外の失敗はやり直さずに返す (429 などは呼び出し側が決める)。
 *
 * @param email - セッションを作るユーザーのメールアドレス (既にいるユーザー)
 */
export async function createTestSession(
  email: string,
  options: CreateTestSessionOptions = {},
): Promise<TestSessionResult> {
  const config = options.config === undefined ? readTestSessionConfig() : options.config;
  if (!config) {
    return failure(
      "config",
      TEST_SESSION_NO_HTTP_STATUS,
      `環境変数 ${missingTestSessionEnv().join(" / ") || Object.values(TEST_SESSION_ENV_NAMES).join(" / ")} が未設定です`,
    );
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? testSessionMaxAttempts();
  const sleepImpl = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const randomImpl = options.randomImpl ?? Math.random;

  let result = await createTestSessionOnce(email, config, fetchImpl);
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    if (result.ok || result.step !== "verify" || result.status !== TEST_SESSION_VERIFY_RETRY_STATUS) return result;
    await sleepImpl(Math.floor(randomImpl() * TEST_SESSION_RETRY_BASE_DELAY_MS * attempt));
    result = await createTestSessionOnce(email, config, fetchImpl);
  }
  if (!result.ok && result.step === "verify" && result.status === TEST_SESSION_VERIFY_RETRY_STATUS) {
    return failure(result.step, result.status, `${result.detail} (generate_link から ${maxAttempts} 回試しました)`);
  }
  return result;
}

/** generate_link → verify を 1 回だけ行う (やり直しは createTestSession) */
async function createTestSessionOnce(
  email: string,
  config: TestSessionConfig,
  fetchImpl: typeof fetch,
): Promise<TestSessionResult> {
  // 1. 管理用の鍵で、ワンタイムのトークン (のハッシュ) を発行する。メールは送られない
  let linkResp: Response;
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
    return failure("generate_link", TEST_SESSION_NO_HTTP_STATUS, `通信できませんでした: ${String(err)}`);
  }
  if (!linkResp.ok) {
    return failure("generate_link", linkResp.status, `HTTP ${linkResp.status}: ${await readBodyPreview(linkResp)}`);
  }
  const link = (await linkResp.json().catch(() => null)) as { hashed_token?: unknown } | null;
  const tokenHash = link?.hashed_token;
  if (typeof tokenHash !== "string" || !tokenHash) {
    return failure("generate_link", linkResp.status, "応答に hashed_token がありません");
  }

  // 2. そのトークンでセッションを受け取る (/verify には CAPTCHA が掛からない)
  let verifyResp: Response;
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
    return failure("verify", TEST_SESSION_NO_HTTP_STATUS, `通信できませんでした: ${String(err)}`);
  }
  if (!verifyResp.ok) {
    return failure("verify", verifyResp.status, `HTTP ${verifyResp.status}: ${await readBodyPreview(verifyResp)}`);
  }
  const session = (await verifyResp.json().catch(() => null)) as SupabaseSessionJson | null;
  if (!session || typeof session.access_token !== "string" || !session.access_token) {
    return failure("verify", verifyResp.status, "応答に access_token がありません");
  }
  return { ok: true, session };
}

/** 失敗の結果を 1 行の説明にする (ログ用。鍵の値は含まない) */
export function describeTestSessionFailure(result: Extract<TestSessionResult, { ok: false }>): string {
  return `テスト用のセッションを作れませんでした (${result.step}): ${result.detail}`;
}
