/**
 * 環境変数の一覧 (zod のスキーマ)・検証・任意の環境変数の取り出し (#1182)
 *
 * このアプリが読む環境変数を、公開用 (NEXT_PUBLIC_*) とサーバー用の 2 つのスキーマに分けて持つ。
 * それぞれに「必須」と「任意」の区別がある。
 *
 *  - 必須: 無いとアプリが動かない。Supabase の接続情報 3 つだけ。
 *    使う場所では src/lib/env-required.ts の getSupabaseUrl() などで取り出す。無ければ MissingEnvError (変数名は envName に持ち、message には入れない)。
 *  - 任意: 無くても動くが、機能が縮退する (メールが送れない・レート制限がメモリ内になる・AI が使えない など)。
 *    getOptionalEnv(name) で取り出す。無ければ undefined を返し、プロセスごとに 1 回だけ警告を出す。
 *    本番の起動を、任意の変数が無いことで止めてはならない。投げるのは必須の変数だけ。
 *  - 値を読む場所が 1 か所に決まっている任意の変数 (CRON_SECRET・LEGAL_CONSENT_ENFORCE など。readOnlyBy を書く): 一覧には、
 *    check:env が「無いと何が起きるか」を案内するための名前だけを置く。値は一覧に書いたファイルだけが読み、
 *    getOptionalEnv では読めない (型で渡せない)。tests/env-source-scan.test.ts が、本番コードで値を読むのが
 *    readOnlyBy のファイルだけであることを確かめる (CRON_SECRET は tests/cron-secret-contract.test.ts の CC-4 も、
 *    このファイルは名前を一覧のキーに書くだけで、値を読んでいないことを確かめる)。
 *
 * このファイルは zod を読み込む (最小のスキーマでも minify 後に約 59 KB)。そのため、ブラウザ向けのコード
 * (lib/supabase/client.ts) と Edge Runtime のコード (middleware・runtime = 'edge' の route) からは
 * import せず、何も import しない src/lib/env-required.ts を使う。Node.js のサーバーコードと
 * scripts/check-env.mjs (npm run check:env) はこちらを使ってよい。
 * scripts/check-env.mjs が Node.js から直接読み込めるように、このファイルは zod 以外を静的に import しない
 * (相対パスの import や `@/` の別名を書かない。警告に使う db-logger は、警告を出すときに動的に読み込む)。
 *
 * 新しい環境変数を足すとき:
 *  1. 下の PUBLIC_ENV_VARS / SERVER_ENV_VARS に足し、必須か任意かを決める。任意なら whenMissing に、無いと何が起きるかを書く。
 *     必須にするのは、無いとアプリが動かないものだけ (迷ったら任意にする)。
 *  2. .env.example に書く (tests/env-source-scan.test.ts が、一覧の全変数が書かれているかを検査する)。
 *     逆に、.env.example から変数を消す (採用をやめたサービスなど) ときは、ここからも消す。
 *  3. コードでは `process.env.X!` と書かない (tests/env-source-scan.test.ts が検査する)。
 *  1 を忘れると、tests/env-source-scan.test.ts が「本番コード (Web) で読む環境変数が一覧に無い」と失敗する
 *  (Node.js・Next.js が入れる NODE_ENV・NEXT_RUNTIME は除く。モバイル (apps/mobile) は apps/mobile/src/lib/env.ts)。
 */

import { z } from 'zod';

export type EnvScope = 'public' | 'server';

export interface EnvVarSpec {
  /** true: 無いとアプリが動かない。false: 無くても動く (機能が縮退する) */
  required: boolean;
  /** 何に使う変数か */
  description: string;
  /** 任意の変数が無いときに起きること。警告と check:env の表示に使う */
  whenMissing?: string;
  /** 値の形式。'url' は http(s) の URL。check:env だけが検査し、実行時の取り出しは存在しか見ない */
  format?: 'url';
  /**
   * 値を読むコードを 1 か所に決めている変数の、そのファイル (リポジトリのルートからのパス)。
   * 一覧には、check:env が「無いと何が起きるか」を案内するための名前だけを置く。値を読むのはこのファイルだけで、
   * getOptionalEnv では読めない (OptionalEnvName に入らない)。任意の変数にだけ付ける。
   */
  readOnlyBy?: string;
}

/** 公開用 (NEXT_PUBLIC_*)。ブラウザのバンドルに値が埋め込まれるので、秘密の値は入れない */
export const PUBLIC_ENV_VARS = {
  NEXT_PUBLIC_SUPABASE_URL: {
    required: true,
    description: 'Supabase プロジェクトの URL (例: https://xxxx.supabase.co)',
    format: 'url',
  },
  NEXT_PUBLIC_SUPABASE_ANON_KEY: {
    required: true,
    description: 'Supabase の anon (公開) キー',
  },
  NEXT_PUBLIC_APP_URL: {
    required: false,
    description: 'サイトの URL。メールのリンク・招待や譲渡の URL・ページの OGP などの基点 (src/lib/site-config.ts の getSiteUrl())',
    whenMissing: 'src/lib/site-config.ts の既定のサイトの URL (いま動いているサイト) になる',
    format: 'url',
  },
  NEXT_PUBLIC_INVITE_BASE_URL: {
    required: false,
    description: '招待系のリンクだけ別のホストにしたいときの上書き。ふだんは設定しない',
    whenMissing: 'サイトの URL (NEXT_PUBLIC_APP_URL) に従う。ふだんはこれでよい',
    format: 'url',
  },
  NEXT_PUBLIC_SUPPORT_EMAIL: {
    required: false,
    description: '問い合わせ先 (サポート窓口) のメールアドレス。メールの文面・お問い合わせ画面・プライバシーポリシーに出る',
    whenMissing: 'src/lib/site-config.ts の既定の問い合わせ先を使う',
  },
  NEXT_PUBLIC_VERCEL_ENV: {
    required: false,
    description: 'デプロイ環境の名前 (production / preview / development)。Vercel が自動で入れる',
    whenMissing: '運営画面の環境バナーが出ない',
  },
  NEXT_PUBLIC_APP_ENV: {
    required: false,
    description: '運営画面に出す環境名',
    whenMissing: 'NODE_ENV の値が表示される',
  },
  NEXT_PUBLIC_APP_VERSION: {
    required: false,
    description: '画面と /api/health に出すバージョン',
    whenMissing: 'next.config.mjs が package.json の version を入れる',
  },
  NEXT_PUBLIC_BUILD_DATE: {
    required: false,
    description: '画面に出すビルド日 (YYYYMMDD)',
    whenMissing: 'next.config.mjs がビルド時の日付を入れる',
  },
} as const satisfies Record<`NEXT_PUBLIC_${string}`, EnvVarSpec>;

/** サーバー専用。ブラウザには出さない */
export const SERVER_ENV_VARS = {
  SUPABASE_SERVICE_ROLE_KEY: {
    required: true,
    description: 'Supabase の service_role キー (RLS を無視できる秘密の値。サーバーだけで使う)',
  },
  RESEND_API_KEY: {
    required: false,
    description: 'Resend の API キー (メール送信)',
    whenMissing: 'メール (お問い合わせの通知・招待・サポート返信など) が送れない',
  },
  EMAIL_FROM: {
    required: false,
    description: 'メールの送信元 (From)。「表示名 <アドレス>」の形か、アドレスだけ。Resend で検証済みのドメインにする',
    whenMissing: 'src/lib/site-config.ts の既定の送信元を使う',
  },
  ADMIN_NOTIFICATION_EMAIL: {
    required: false,
    description: 'お問い合わせが届いたときに、運営へ知らせるメールの宛先',
    whenMissing: 'お問い合わせは保存されるが、運営への通知メールは送られない',
  },
  SUPPORT_REPLY_TO: {
    required: false,
    description: 'サポート返信メールの返信先アドレス',
    whenMissing: '送信元は noreply のままで、メール本文でお問い合わせフォームへ誘導する',
  },
  UPSTASH_REDIS_REST_URL: {
    required: false,
    description: 'Upstash Redis の REST URL (レート制限)',
    whenMissing: 'レート制限がサーバーインスタンスごとのメモリ内の数え方になる (本番では設定すること。ENV_SETUP.md 参照)',
    format: 'url',
  },
  UPSTASH_REDIS_REST_TOKEN: {
    required: false,
    description: 'Upstash Redis の REST トークン (レート制限)',
    whenMissing: 'レート制限がサーバーインスタンスごとのメモリ内の数え方になる (本番では設定すること。ENV_SETUP.md 参照)',
  },
  STRIPE_SECRET_KEY: {
    required: false,
    description: 'Stripe の秘密鍵',
    whenMissing: 'Stripe との照合・価格の同期が動かない',
  },
  GOOGLE_AI_STUDIO_API_KEY: {
    required: false,
    description: 'Google AI (Gemini) の API キー。別名の GOOGLE_GEN_AI_API_KEY と、どちらか一方でよい',
    whenMissing: 'Gemini を使う機能 (写真の解析・画像生成など) が使えない',
  },
  GOOGLE_GEN_AI_API_KEY: {
    required: false,
    description: 'Google AI (Gemini) の API キー (GOOGLE_AI_STUDIO_API_KEY の別名)',
    whenMissing: 'GOOGLE_AI_STUDIO_API_KEY も未設定なら、Gemini を使う機能が使えない',
  },
  GEMINI_VISION_MODEL: {
    required: false,
    description: '写真の解析に使う Gemini のモデル名',
    whenMissing: 'コードの既定のモデルを使う',
  },
  GEMINI_CLASSIFY_MODEL: {
    required: false,
    description: '写真の分類に使う Gemini のモデル名',
    whenMissing: 'コードの既定のモデルを使う',
  },
  GEMINI_IMAGE_MODEL: {
    required: false,
    description: '画像生成に使う Gemini のモデル名',
    whenMissing: 'コードの既定のモデルを使う',
  },
  XAI_API_KEY: {
    required: false,
    description: 'xAI (Grok) の API キー。献立生成・チャットの fast-llm が使う',
    whenMissing: 'fast-llm を使う機能 (献立生成・AI チャット) が使えない',
  },
  XAI_BASE_URL: {
    required: false,
    description: 'xAI の API のベース URL',
    whenMissing: 'コードの既定 (https://api.x.ai/v1) を使う',
    format: 'url',
  },
  FAST_LLM_MODEL: {
    required: false,
    description: 'fast-llm が使うモデル名',
    whenMissing: 'コードの既定のモデルを使う',
  },
  OPENAI_API_KEY: {
    required: false,
    description: 'OpenAI の API キー',
    whenMissing: '栄養フィードバック (/api/ai/nutrition/feedback) が使えない',
  },
  CRON_SECRET: {
    required: false,
    description: 'Vercel Cron が /api/cron/* に付ける Bearer トークンの照合用シークレット',
    whenMissing: 'cron の API が 503 を返し、定期処理 (献立生成キューの処理など) が動かない',
    // 定数時間の比較と入れ替え中の旧い値の受け付けを 1 か所に集めている (tests/cron-secret-contract.test.ts の CC-4)
    readOnlyBy: 'src/lib/cron-auth.ts',
  },
  CRON_SECRET_PREVIOUS: {
    required: false,
    description: 'CRON_SECRET を入れ替える間だけ設定する、旧い値',
    whenMissing: '旧い値は受け付けない (普段はこれで正しい)',
    readOnlyBy: 'src/lib/cron-auth.ts',
  },
  NATIVE_BRIDGE_LEGACY_GET: {
    required: false,
    description: "モバイルの旧い認証ブリッジ (URL にトークンを載せる方式) の受け付けを止めるスイッチ。'off' で止める",
    whenMissing: '旧方式を、src/lib/auth/native-bridge-code.ts の LEGACY_SUNSET_AT まで受け付ける',
  },
  NATIVE_BRIDGE_SHARE_REFRESH_TOKEN: {
    required: false,
    description:
      "モバイルの認証ブリッジ (コード方式) が WebView の Cookie に入れる refresh_token の扱いのスイッチ。'on' で実際の refresh_token を入れる (従来の動作)",
    whenMissing:
      '更新に使えない値を入れる。Web は自分で更新せず、期限が近づくとネイティブに再ブリッジを頼む (src/lib/native-auth-bridge.ts)',
  },
  LEGAL_CONSENT_ENFORCE: {
    required: false,
    description:
      "利用規約・プライバシーポリシーの再同意の強制 (#1174)。'on' のときだけ、同意が済んでいない利用者を同意画面 (/legal-consent) へ回す",
    whenMissing: '誰も同意画面へ回さない (既定)。お知らせを出すかは LEGAL_CONSENT_NOTICE で決まる',
    // middleware (Edge Runtime) が読むので、zod を持つこのファイルの getOptionalEnv は使えない。
    // 2 つのフラグの読み方 (on だけを有効とみなす) は lib/legal-consent.ts の isLegalConsentFlagOn に 1 つだけ置く
    readOnlyBy: 'lib/legal-consent.ts',
  },
  LEGAL_CONSENT_NOTICE: {
    required: false,
    description:
      "同意が済んでいない利用者の画面の上に「同意のお願い」のお知らせを出すか (#1174)。'on' のときだけ出す。強制していない間だけ効く",
    whenMissing: 'お知らせを出さない (既定)',
    readOnlyBy: 'lib/legal-consent.ts',
  },
  SERVICE_ROLE_JWT: {
    required: false,
    description: 'SUPABASE_SERVICE_ROLE_KEY の古い別名。画像生成ジョブがこちらを先に読む',
    whenMissing: 'SUPABASE_SERVICE_ROLE_KEY を使う',
  },
  NEXTAUTH_URL: {
    required: false,
    description: '運営画面のサーバー側 fetch が呼ぶ、このアプリ自身の URL (最優先)',
    whenMissing: 'VERCEL_URL、なければ http://localhost:3000 を使う',
    format: 'url',
  },
  VERCEL_URL: {
    required: false,
    description: 'このデプロイの URL (https:// なしのホスト名)。Vercel が自動で入れる',
    whenMissing: 'http://localhost:3000 を使う (Vercel 上では自動で入る)',
  },
  VERCEL_ENV: {
    required: false,
    description: 'デプロイ環境の名前 (production / preview / development)。Vercel が自動で入れる (サーバー側)',
    whenMissing: '本番かどうかを NEXT_PUBLIC_VERCEL_ENV だけで判断する (src/lib/site-config.ts)',
  },
} as const satisfies Record<string, EnvVarSpec>;

export type PublicEnvName = keyof typeof PUBLIC_ENV_VARS;
export type ServerEnvName = keyof typeof SERVER_ENV_VARS;
export type EnvName = PublicEnvName | ServerEnvName;

type OptionalNames<T extends Record<string, EnvVarSpec>> = {
  [K in keyof T]: T[K]['required'] extends false ? (T[K] extends { readonly readOnlyBy: string } ? never : K) : never;
}[keyof T] &
  string;

type RequiredNames<T extends Record<string, EnvVarSpec>> = {
  [K in keyof T]: T[K]['required'] extends true ? K : never;
}[keyof T] &
  string;

/** getOptionalEnv で取り出せる、任意の環境変数の名前 (値を読む場所が決まっている変数 = readOnlyBy を持つものは含まない) */
export type OptionalEnvName = OptionalNames<typeof PUBLIC_ENV_VARS> | OptionalNames<typeof SERVER_ENV_VARS>;
/** 必須の環境変数の名前 (src/lib/env-required.ts の REQUIRED_ENV_NAMES と一致する) */
export type RequiredEnvName = RequiredNames<typeof PUBLIC_ENV_VARS> | RequiredNames<typeof SERVER_ENV_VARS>;

export interface EnvVarEntry extends EnvVarSpec {
  name: EnvName;
  scope: EnvScope;
}

/** 公開用 → サーバー用の順に並べた、全変数の一覧 */
export const ENV_VARS: readonly EnvVarEntry[] = [
  ...Object.entries(PUBLIC_ENV_VARS).map(([name, spec]) => ({
    ...(spec as EnvVarSpec),
    name: name as EnvName,
    scope: 'public' as const,
  })),
  ...Object.entries(SERVER_ENV_VARS).map(([name, spec]) => ({
    ...(spec as EnvVarSpec),
    name: name as EnvName,
    scope: 'server' as const,
  })),
];

/**
 * 同時に設定する変数の組。片方だけ設定されていると、もう片方が無いために機能が黙って縮退する。
 * (Upstash は URL とトークンの両方が揃わないと使われず、メモリ内の数え方に戻る)
 */
export const ENV_PAIRS: ReadonlyArray<readonly [EnvName, EnvName]> = [
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
];

// ─────────────────────────────────────────────────────────────────────────────
// zod のスキーマ
// ─────────────────────────────────────────────────────────────────────────────

const httpUrl = z.url({ protocol: /^https?$/ });

type EnvShape<T extends Record<string, EnvVarSpec>> = {
  -readonly [K in keyof T]: T[K]['required'] extends true ? z.ZodString : z.ZodOptional<z.ZodString>;
};

function buildShape<T extends Record<string, EnvVarSpec>>(vars: T): EnvShape<T> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, spec] of Object.entries(vars)) {
    const base = spec.format === 'url' ? httpUrl : z.string();
    shape[name] = spec.required ? base : base.optional();
  }
  return shape as unknown as EnvShape<T>;
}

/**
 * 公開用 (NEXT_PUBLIC_*) のスキーマ。値は文字列。必須の変数が無いと失敗し、任意の変数は無くてよい。
 * 空文字・空白だけの値は未設定として扱うため、normalizeEnvSource() を通した値を渡す (validateEnv() が通す)。
 */
export const publicEnvSchema = z.object(buildShape(PUBLIC_ENV_VARS));

/** サーバー用のスキーマ。使い方は publicEnvSchema と同じ */
export const serverEnvSchema = z.object(buildShape(SERVER_ENV_VARS));

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 検証 (npm run check:env が使う)
// ─────────────────────────────────────────────────────────────────────────────

export type EnvSource = Record<string, string | undefined>;

/** 空文字・空白だけの値を取り除く。.env に `NAME=` と書いたままの行は、設定されていないものとして扱う */
export function normalizeEnvSource(source: EnvSource): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') normalized[key] = value;
  }
  return normalized;
}

export interface EnvFinding {
  name: EnvName;
  scope: EnvScope;
  required: boolean;
  /** missing: 未設定 / invalid: 値の形式が正しくない / incomplete: 同時に設定すべき変数の片方だけがある */
  kind: 'missing' | 'invalid' | 'incomplete';
  /** 人が読む説明。環境変数の値は含めない */
  message: string;
}

export interface EnvReport {
  /** 必須の変数がすべて揃い、必須の値の形式にも問題が無いとき true。任意の変数の不足は ok に影響しない */
  ok: boolean;
  /** 必須の変数の不足・形式の誤り */
  errors: EnvFinding[];
  /** 任意の変数の不足・形式の誤り、組の片方だけの設定 */
  warnings: EnvFinding[];
  /** 設定されている変数の名前 (値は含めない) */
  present: EnvName[];
}

/**
 * 環境変数を一覧に照らして検査する。process.env でも、.env ファイルを読んだ値でも渡せる。
 * 実行時の取り出し (getSupabaseUrl など) は値の存在しか見ない。URL の形式の検査は、この関数 (check:env) だけが行う。
 */
export function validateEnv(source: EnvSource = process.env): EnvReport {
  const env = normalizeEnvSource(source);

  // zod での形式の検査。変数名 → 最初の問題の説明
  const formatIssues = new Map<string, string>();
  for (const schema of [publicEnvSchema, serverEnvSchema]) {
    const result = schema.safeParse(env);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      const name = String(issue.path[0] ?? '');
      if (name && !formatIssues.has(name)) formatIssues.set(name, issue.message);
    }
  }

  const errors: EnvFinding[] = [];
  const warnings: EnvFinding[] = [];
  const present: EnvName[] = [];

  for (const entry of ENV_VARS) {
    const { name, scope, required } = entry;
    const target = required ? errors : warnings;

    if (env[name] === undefined) {
      target.push({
        name,
        scope,
        required,
        kind: 'missing',
        message: required
          ? `必須の環境変数が設定されていません。${entry.description}`
          : `未設定です。${entry.whenMissing ?? ''}`.trim(),
      });
      continue;
    }

    present.push(name);
    const issue = formatIssues.get(name);
    if (issue) {
      target.push({
        name,
        scope,
        required,
        kind: 'invalid',
        message: `値の形式が正しくありません (${entry.format === 'url' ? 'http:// か https:// で始まる URL にしてください' : issue})`,
      });
    }
  }

  for (const [first, second] of ENV_PAIRS) {
    if ((env[first] === undefined) === (env[second] === undefined)) continue;
    const missing = env[first] === undefined ? first : second;
    const entry = ENV_VARS.find((candidate) => candidate.name === missing);
    warnings.push({
      name: missing,
      scope: entry?.scope ?? 'server',
      required: false,
      kind: 'incomplete',
      message: `${first} と ${second} は、両方設定するか両方未設定にしてください (片方だけだと使われません)`,
    });
  }

  return { ok: errors.length === 0, errors, warnings, present };
}

// ─────────────────────────────────────────────────────────────────────────────
// 任意の環境変数の取り出し
// ─────────────────────────────────────────────────────────────────────────────

const warnedOptionalEnv = new Set<string>();

/** db-logger の読み込み。警告のたびに import せず、1 つの Promise を使い回す */
let dbLoggerModule: Promise<typeof import('./db-logger')> | undefined;

/** テスト用: 「1 回だけ出す警告」の記録と、読み込み済みの db-logger を忘れる */
export function resetEnvWarningsForTest(): void {
  warnedOptionalEnv.clear();
  dbLoggerModule = undefined;
}

/**
 * 警告を出す。Node.js のサーバーでは db-logger (console と app_logs) に、Edge Runtime とブラウザでは console だけに出す。
 * db-logger は service_role で app_logs に書き込むので、Edge・ブラウザでは読み込まない。
 * 警告を出す処理が失敗しても、呼び出し元 (リクエストの処理) は止めない。
 */
function emitEnvWarning(message: string, metadata: Record<string, unknown>): void {
  const canUseDbLogger = typeof window === 'undefined' && process.env.NEXT_RUNTIME !== 'edge';
  if (!canUseDbLogger) {
    console.warn(`[env] ${message}`, metadata);
    return;
  }
  dbLoggerModule ??= import('./db-logger');
  dbLoggerModule
    .then(({ createLogger }) => createLogger('lib/env').warn(message, metadata))
    .catch(() => {
      console.warn(`[env] ${message}`, metadata);
    });
}

/**
 * 任意の環境変数の値を返す。未設定・空・空白だけなら undefined を返し、その変数についての警告を
 * プロセスごとに 1 回だけ出す。例外は投げない (任意の変数が無いことで、本番の処理を止めてはならない)。
 *
 * Node.js のサーバー専用。process.env[name] と名前を変数にして読むため、ブラウザのコードでは使えない
 * (ブラウザで NEXT_PUBLIC_* を読むときは `process.env.NEXT_PUBLIC_X` と名前を直接書く)。
 * 必須の変数 (Supabase の接続情報) には使えない。src/lib/env-required.ts の getter を使う。
 */
export function getOptionalEnv(name: OptionalEnvName): string | undefined {
  const value = process.env[name];
  if (value !== undefined && value.trim() !== '') return value;

  if (!warnedOptionalEnv.has(name)) {
    warnedOptionalEnv.add(name);
    const entry = ENV_VARS.find((candidate) => candidate.name === name);
    emitEnvWarning(
      `任意の環境変数 ${name} が設定されていません。${entry?.whenMissing ?? ''}`.trim(),
      { envName: name, scope: entry?.scope, whenMissing: entry?.whenMissing },
    );
  }
  return undefined;
}
