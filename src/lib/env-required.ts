/**
 * 必須の環境変数 (Supabase の接続情報) の取り出し (#1182)
 *
 * アプリが動くのに欠かせない環境変数を、使う場所で取り出す。値が無い (未設定・空・空白だけ) と、
 * MissingEnvError を投げる (変数名は envName に持ち、message には入れない)。`process.env.X!` と書くと、未設定でも型の上では string のまま
 * undefined が Supabase のクライアントや fetch の URL に流れ込み、`supabaseUrl is required.` のような
 * 変数名の分からないエラーや、`undefined/functions/v1/...` への通信になってしまう。
 *
 * 守ること:
 *  - 値は加工せずにそのまま返す (trim しない)。設定されているときの挙動は `process.env.X!` と同じ。
 *  - モジュールの読み込み時には検査しない。呼ぶ場所 (リクエストの処理中・クライアントを作る瞬間) で検査する。
 *    読み込み時に投げると、環境変数を持たないビルド (`next build` のページ情報の収集など) まで落ちる。
 *  - このファイルは何も import しない。ブラウザ (lib/supabase/client.ts)・Edge Runtime (middleware・
 *    export const runtime = 'edge' の route) からも読み込まれるため。zod を入れると、最小のスキーマでも
 *    minify 後に約 59 KB (gzip 約 16 KB) が全ページの JS に加わる (#1182 で実測)。
 *    変数の一覧 (zod のスキーマ)・任意の変数の取り出し・check:env は src/lib/env.ts にある。
 *  - NEXT_PUBLIC_* の変数は `process.env.NEXT_PUBLIC_X` と名前を直接書いて読む。Next.js はブラウザ向けの
 *    バンドルで、この書き方の箇所だけをビルド時に値へ置き換える。`process.env[name]` のように名前を
 *    変数にすると置き換わらず、ブラウザでは常に undefined になる。
 *
 * 必須かどうかの分類は src/lib/env.ts の一覧と一致させる (src/__tests__/lib/env.test.ts が検査する)。
 */

/**
 * MissingEnvError の message。どの変数が欠けていても同じ文にし、変数名も値も入れない。
 * 500 の本文には汎用メッセージだけを返す規則 (#1172) があり、error.message をそのまま本文に入れる route が
 * 書かれても、変数名が利用者に漏れないようにするため。欠けている変数名は envName にある
 * (db-logger の error() が構造化ログの metadata に missing_env_name として記録する)。
 */
export const MISSING_ENV_ERROR_MESSAGE =
  'Missing a required environment variable (run `npm run check:env` to find which one)';

/**
 * 必須の環境変数が無いときに投げる。
 *  - message は MISSING_ENV_ERROR_MESSAGE で固定 (変数名も値も入らない)。
 *  - 変数名は envName に入る (値は入らない)。envName は列挙されないプロパティにしてあるので、
 *    `JSON.stringify(error)`・`{ ...error }`・`NextResponse.json({ error })` のようにエラーごと本文に入れても出てこない。
 *    構造化ログ (src/lib/db-logger.ts の error()) が envName を読んで記録する。
 * 設定のしかたは ENV_SETUP.md と、`npm run check:env` の出力にある。
 */
export class MissingEnvError extends Error {
  declare readonly envName: string;

  constructor(envName: string) {
    super(MISSING_ENV_ERROR_MESSAGE);
    this.name = 'MissingEnvError';
    Object.defineProperty(this, 'envName', { value: envName, enumerable: false, writable: false, configurable: false });
  }
}

/** MissingEnvError かどうか。バンドルが分かれて instanceof が使えない場合に備えて名前でも判定する */
export function isMissingEnvError(error: unknown): error is MissingEnvError {
  return (
    error instanceof MissingEnvError ||
    (error instanceof Error && error.name === 'MissingEnvError' && typeof (error as { envName?: unknown }).envName === 'string')
  );
}

/** このファイルが扱う、必須の環境変数の名前 */
export const REQUIRED_ENV_NAMES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

/** 値があればそのまま返す。未設定・空・空白だけなら MissingEnvError */
function requireValue(name: (typeof REQUIRED_ENV_NAMES)[number], value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new MissingEnvError(name);
  }
  return value;
}

/** Supabase プロジェクトの URL (ブラウザ・Edge・サーバーで使える) */
export function getSupabaseUrl(): string {
  return requireValue('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
}

/** Supabase の anon (公開) キー (ブラウザ・Edge・サーバーで使える) */
export function getSupabaseAnonKey(): string {
  return requireValue('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Supabase の service_role キー。RLS を無視できる秘密の値なので、**サーバーだけ**で使う
 * (NEXT_PUBLIC_ を付けていないので、ブラウザ向けのバンドルには入らない)。
 */
export function getSupabaseServiceRoleKey(): string {
  return requireValue('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** ブラウザ・Edge でも使える、anon キーでの接続情報 (createBrowserClient / createServerClient に渡す) */
export function getSupabasePublicConfig(): { url: string; anonKey: string } {
  return { url: getSupabaseUrl(), anonKey: getSupabaseAnonKey() };
}

/**
 * サーバー専用: service_role で Supabase (REST・Edge Function) を呼ぶための接続情報。
 * 認可 (ログイン・ロールの確認) を通したあとの処理でだけ使うこと。
 */
export function getSupabaseServiceConfig(): { url: string; serviceRoleKey: string } {
  return { url: getSupabaseUrl(), serviceRoleKey: getSupabaseServiceRoleKey() };
}
