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
