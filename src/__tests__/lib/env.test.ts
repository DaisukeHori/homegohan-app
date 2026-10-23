// @vitest-environment node
/**
 * src/lib/env.ts と src/lib/env-required.ts のテスト (#1182)
 *
 * 以前は `process.env.X!` が散らばっていて、環境変数が欠けていても型の上では string のまま undefined が
 * Supabase のクライアントや fetch の URL に流れ込み、変数名の分からないエラーになっていた。
 *
 *   1. 必須の環境変数 (env-required): 欠けていれば、サーバーのログに変数名を 1 行出して MissingEnvError。
 *      エラーの中では変数名を envName (列挙されない) にだけ持ち、message には変数名も値も入れない
 *      (500 の本文に漏れないように。#1172)。値はそのまま返す
 *   2. 任意の環境変数 (env): 欠けていれば undefined と、プロセスごとに 1 回だけの警告。例外は投げない
 *   3. 一覧 (zod のスキーマ): 公開用 (NEXT_PUBLIC_*) とサーバー用に分かれ、必須/任意の分類が env-required と一致する
 *   4. validateEnv (npm run check:env が使う): 必須の不足は errors、任意の不足は warnings。値は出力に含めない
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 警告は Node.js のサーバーでは db-logger (console と app_logs) に出す。DB には書かせない
const mockWarn = vi.fn();
const mockCreateLogger = vi.fn((_name: string) => ({ warn: mockWarn }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: (name: string) => mockCreateLogger(name),
}));

import {
  ENV_PAIRS,
  ENV_VARS,
  PUBLIC_ENV_VARS,
  SERVER_ENV_VARS,
  getOptionalEnv,
  normalizeEnvSource,
  publicEnvSchema,
  resetEnvWarningsForTest,
  serverEnvSchema,
  validateEnv,
} from '@/lib/env';
import {
  MISSING_ENV_ERROR_MESSAGE,
  MISSING_ENV_SERVER_LOG_PREFIX,
  MissingEnvError,
  REQUIRED_ENV_NAMES,
  getSupabaseAnonKey,
  getSupabasePublicConfig,
  getSupabaseServiceConfig,
  getSupabaseServiceRoleKey,
  getSupabaseUrl,
  isMissingEnvError,
} from '@/lib/env-required';

const ROOT = path.resolve(__dirname, '../../..');

const URL_VALUE = 'https://abcdefgh.supabase.co';
const ANON_VALUE = 'anon-key-value-for-test';
const SERVICE_VALUE = 'service-role-value-must-not-leak';

function stubRequiredEnv() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_VALUE);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_VALUE);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_VALUE);
}

/** db-logger の動的 import が済むのを待つ (「もう警告は出ない」ことを確かめる前に使う) */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.clearAllMocks();
  resetEnvWarningsForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 必須の環境変数
// ─────────────────────────────────────────────────────────────────────────────

describe('必須の環境変数 (env-required)', () => {
  it('設定されていれば、値を加工せずにそのまま返す (設定済みのときの挙動は process.env.X! と同じ)', () => {
    stubRequiredEnv();

    expect(getSupabaseUrl()).toBe(URL_VALUE);
    expect(getSupabaseAnonKey()).toBe(ANON_VALUE);
    expect(getSupabaseServiceRoleKey()).toBe(SERVICE_VALUE);
    expect(getSupabasePublicConfig()).toEqual({ url: URL_VALUE, anonKey: ANON_VALUE });
    expect(getSupabaseServiceConfig()).toEqual({ url: URL_VALUE, serviceRoleKey: SERVICE_VALUE });
  });

  it('前後に空白がある値も、trim せずそのまま返す', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ` ${URL_VALUE} `);

    expect(getSupabaseUrl()).toBe(` ${URL_VALUE} `);
  });

  /** getter を呼んで、投げた例外を返す (投げなければ undefined) */
  function thrownBy(getter: () => unknown): unknown {
    try {
      getter();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  /** エラーを、本文やログに入りうる形 (message・toString・JSON・スプレッド・stack) にすべて書き出す */
  function everySerialization(error: unknown): string {
    const err = error as Error;
    return [err.message, String(err), JSON.stringify(err), JSON.stringify({ ...err }), JSON.stringify({ error: err }), err.stack ?? ''].join('\n');
  }

  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', getSupabaseUrl],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', getSupabaseAnonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', getSupabaseServiceRoleKey],
  ] as const)('%s が未設定なら MissingEnvError を投げ、変数名は envName にだけ入る (message には入らない)', (name, getter) => {
    vi.stubEnv(name, undefined);

    const thrown = thrownBy(getter);

    expect(thrown).toBeInstanceOf(MissingEnvError);
    expect(isMissingEnvError(thrown)).toBe(true);
    expect((thrown as MissingEnvError).envName).toBe(name);
    expect((thrown as MissingEnvError).name).toBe('MissingEnvError');
    // message はどの変数でも同じ固定の文で、変数名を含まない (#1172: 500 の本文に error.message を入れるコードが書かれても漏れない)
    expect((thrown as MissingEnvError).message).toBe(MISSING_ENV_ERROR_MESSAGE);
    expect((thrown as MissingEnvError).message).not.toContain(name);
  });

  it.each(REQUIRED_ENV_NAMES)('%s の MissingEnvError は、message・toString・JSON・スプレッド・stack のどれにも変数名が出ない', (name) => {
    const error = new MissingEnvError(name);

    expect(everySerialization(error)).not.toContain(name);
    // envName は列挙されないプロパティ (エラーごと JSON にしても出ない)。読めば変数名が分かる
    expect(Object.keys(error)).not.toContain('envName');
    expect(error.envName).toBe(name);
  });

  it('message の固定の文には、どの必須の変数名も入っていない', () => {
    for (const name of REQUIRED_ENV_NAMES) expect(MISSING_ENV_ERROR_MESSAGE).not.toContain(name);
    // 調べ方 (npm run check:env) は案内する
    expect(MISSING_ENV_ERROR_MESSAGE).toContain('npm run check:env');
  });

  it.each(['', ' ', '\t\n'])('値が %j (空・空白だけ) でも、未設定として扱う', (blank) => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', blank);

    expect(thrownBy(() => getSupabaseServiceRoleKey())).toMatchObject({
      name: 'MissingEnvError',
      envName: 'SUPABASE_SERVICE_ROLE_KEY',
    });
  });

  it('接続情報をまとめて取るときも、欠けている変数名を envName で報告する (URL が先)', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_VALUE);

    expect((thrownBy(() => getSupabasePublicConfig()) as MissingEnvError).envName).toBe('NEXT_PUBLIC_SUPABASE_URL');
    expect((thrownBy(() => getSupabaseServiceConfig()) as MissingEnvError).envName).toBe('NEXT_PUBLIC_SUPABASE_URL');

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_VALUE);
    expect((thrownBy(() => getSupabasePublicConfig()) as MissingEnvError).envName).toBe('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(getSupabaseServiceConfig()).toEqual({ url: URL_VALUE, serviceRoleKey: SERVICE_VALUE });

    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    expect((thrownBy(() => getSupabaseServiceConfig()) as MissingEnvError).envName).toBe('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('エラーのどの書き出しにも、他の環境変数の値は含まれない', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_VALUE);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_VALUE);

    const thrown = thrownBy(() => getSupabaseServiceConfig());

    expect((thrown as MissingEnvError).envName).toBe('NEXT_PUBLIC_SUPABASE_URL');
    const written = everySerialization(thrown);
    expect(written).not.toContain(SERVICE_VALUE);
    expect(written).not.toContain(ANON_VALUE);
    expect(written).not.toContain('NEXT_PUBLIC_SUPABASE_URL');
  });

  // #1182 R1: 例外を internalError() / db-logger に渡さない route (error.message をそのまま返す・try の外で投げる) でも、
  // どの変数が欠けているかをサーバーのログに残す。envName は列挙されないので console.error(error) では見えない
  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', getSupabaseUrl],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', getSupabaseAnonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', getSupabaseServiceRoleKey],
  ] as const)('サーバー (window が無い所) では、%s が欠けていると、投げる前にサーバーのログへ変数名を 1 行出す (値は出さない)', (name, getter) => {
    stubRequiredEnv();
    vi.stubEnv(name, undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(thrownBy(getter)).toMatchObject({ name: 'MissingEnvError', envName: name });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(MISSING_ENV_SERVER_LOG_PREFIX, name);
    const logged = JSON.stringify(consoleError.mock.calls);
    for (const value of [URL_VALUE, ANON_VALUE, SERVICE_VALUE]) expect(logged).not.toContain(value);
  });

  it('値がそろっていれば、サーバーのログに何も出さない', () => {
    stubRequiredEnv();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    getSupabaseServiceConfig();
    getSupabasePublicConfig();

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('ブラウザ (window がある所) では、変数名をログに出さない (利用者の開発者ツールに見せない)。例外は同じく投げる', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('window', {});
    try {
      expect(thrownBy(() => getSupabaseUrl())).toMatchObject({ name: 'MissingEnvError', envName: 'NEXT_PUBLIC_SUPABASE_URL' });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ログの前置きには変数名も値も入っておらず、変数名は別の引数で渡る', () => {
    expect(MISSING_ENV_SERVER_LOG_PREFIX).toBe('[env] missing required env:');
    for (const name of REQUIRED_ENV_NAMES) expect(MISSING_ENV_SERVER_LOG_PREFIX).not.toContain(name);
  });

  it('isMissingEnvError は、別のバンドルで作られた同名のエラー (instanceof が使えない場合) も認める', () => {
    const lookalike = Object.assign(new Error('Missing required environment variable: X'), {
      name: 'MissingEnvError',
      envName: 'X',
    });

    expect(isMissingEnvError(lookalike)).toBe(true);
    expect(isMissingEnvError(new Error('Missing required environment variable: X'))).toBe(false);
    expect(isMissingEnvError('MissingEnvError')).toBe(false);
    expect(isMissingEnvError(null)).toBe(false);
  });

  it('モジュールを読み込むだけでは検査しない (環境変数が無いビルドや import でも落ちない)', async () => {
    for (const name of [...REQUIRED_ENV_NAMES, 'RESEND_API_KEY']) vi.stubEnv(name, undefined);
    vi.resetModules();

    await expect(import('@/lib/env-required')).resolves.toHaveProperty('getSupabaseUrl');
    await expect(import('@/lib/env')).resolves.toHaveProperty('validateEnv');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 任意の環境変数
// ─────────────────────────────────────────────────────────────────────────────

describe('任意の環境変数 (getOptionalEnv)', () => {
  it('設定されていれば値をそのまま返し、警告は出さない', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');

    expect(getOptionalEnv('RESEND_API_KEY')).toBe('re_test_key');
    await settle();

    expect(mockCreateLogger).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('未設定なら undefined を返し (例外は投げない)、警告を 1 回だけ出す', async () => {
    vi.stubEnv('RESEND_API_KEY', undefined);

    expect(getOptionalEnv('RESEND_API_KEY')).toBeUndefined();
    expect(getOptionalEnv('RESEND_API_KEY')).toBeUndefined();
    expect(getOptionalEnv('RESEND_API_KEY')).toBeUndefined();

    await vi.waitFor(() => expect(mockWarn).toHaveBeenCalledTimes(1));
    // 3 回呼んでも 1 回だけ (動的 import が済むのを待ってから、もう一度数える)
    await settle();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockCreateLogger).toHaveBeenCalledWith('lib/env');

    const [message, metadata] = mockWarn.mock.calls[0];
    expect(message).toContain('RESEND_API_KEY');
    expect(message).toContain('メール');
    expect(metadata).toMatchObject({ envName: 'RESEND_API_KEY', scope: 'server' });
  });

  it('変数ごとに 1 回ずつ警告を出す', async () => {
    vi.stubEnv('RESEND_API_KEY', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);

    getOptionalEnv('RESEND_API_KEY');
    getOptionalEnv('UPSTASH_REDIS_REST_URL');
    getOptionalEnv('RESEND_API_KEY');

    await vi.waitFor(() => expect(mockWarn).toHaveBeenCalledTimes(2));
    const names = mockWarn.mock.calls.map(([, metadata]) => (metadata as { envName: string }).envName).sort();
    expect(names).toEqual(['RESEND_API_KEY', 'UPSTASH_REDIS_REST_URL']);
  });

  it.each(['', '   '])('値が %j (空・空白だけ) でも、未設定として undefined を返し警告する', async (blank) => {
    vi.stubEnv('STRIPE_SECRET_KEY', blank);

    expect(getOptionalEnv('STRIPE_SECRET_KEY')).toBeUndefined();

    await vi.waitFor(() => expect(mockWarn).toHaveBeenCalledTimes(1));
  });

  it('公開用 (NEXT_PUBLIC_*) の任意の変数も同じ扱い', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);

    expect(getOptionalEnv('NEXT_PUBLIC_APP_URL')).toBeUndefined();

    await vi.waitFor(() => expect(mockWarn).toHaveBeenCalledTimes(1));
    expect(mockWarn.mock.calls[0][1]).toMatchObject({ envName: 'NEXT_PUBLIC_APP_URL', scope: 'public' });
  });

  it('警告の出力に失敗しても、呼び出し元には例外を投げず undefined を返す (console に出す)', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCreateLogger.mockImplementationOnce(() => {
      throw new Error('logger is down');
    });
    vi.stubEnv('OPENAI_API_KEY', undefined);

    expect(getOptionalEnv('OPENAI_API_KEY')).toBeUndefined();

    await vi.waitFor(() => expect(consoleWarn).toHaveBeenCalledTimes(1));
    expect(String(consoleWarn.mock.calls[0][0])).toContain('OPENAI_API_KEY');
  });

  it('Edge Runtime では db-logger を使わず、console にだけ警告を出す', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('XAI_API_KEY', undefined);

    expect(getOptionalEnv('XAI_API_KEY')).toBeUndefined();
    getOptionalEnv('XAI_API_KEY');

    // Edge では同期的に console に出る
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(String(consoleWarn.mock.calls[0][0])).toContain('XAI_API_KEY');
    await settle();
    expect(mockCreateLogger).not.toHaveBeenCalled();
  });

  it('警告の文面に、他の環境変数の値は含まれない', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_VALUE);
    vi.stubEnv('STRIPE_SECRET_KEY', undefined);

    getOptionalEnv('STRIPE_SECRET_KEY');

    await vi.waitFor(() => expect(mockWarn).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(mockWarn.mock.calls[0])).not.toContain(SERVICE_VALUE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 一覧 (zod のスキーマ)
// ─────────────────────────────────────────────────────────────────────────────

describe('環境変数の一覧 (zod のスキーマ)', () => {
  it('公開用は NEXT_PUBLIC_* だけ、サーバー用は NEXT_PUBLIC_ を含まない (重複もない)', () => {
    const publicNames = Object.keys(publicEnvSchema.shape);
    const serverNames = Object.keys(serverEnvSchema.shape);

    expect(publicNames.length).toBeGreaterThan(0);
    expect(serverNames.length).toBeGreaterThan(0);
    expect(publicNames.every((name) => name.startsWith('NEXT_PUBLIC_'))).toBe(true);
    expect(serverNames.some((name) => name.startsWith('NEXT_PUBLIC_'))).toBe(false);
    expect(publicNames.filter((name) => serverNames.includes(name))).toEqual([]);
    expect(new Set(ENV_VARS.map((entry) => entry.name)).size).toBe(ENV_VARS.length);
    expect(Object.keys(PUBLIC_ENV_VARS)).toEqual(publicNames);
    expect(Object.keys(SERVER_ENV_VARS)).toEqual(serverNames);
  });

  it('Sign in with Apple の 5 つ (公開の NEXT_PUBLIC_APPLE_SIGN_IN・サーバの APPLE_SIGN_IN_TEAM_ID / KEY_ID / PRIVATE_KEY / SERVICES_ID) はどれも任意として一覧にあり、公開の 1 つは PUBLIC_ENV_VARS・サーバの 4 つは SERVER_ENV_VARS にある (mobile/08 §11.7)', () => {
    const publicApple = ['NEXT_PUBLIC_APPLE_SIGN_IN'] as const;
    const serverApple = ['APPLE_SIGN_IN_TEAM_ID', 'APPLE_SIGN_IN_KEY_ID', 'APPLE_SIGN_IN_PRIVATE_KEY', 'APPLE_SIGN_IN_SERVICES_ID'] as const;
    for (const name of publicApple) {
      expect(Object.keys(PUBLIC_ENV_VARS), name).toContain(name);
      expect(Object.keys(SERVER_ENV_VARS), name).not.toContain(name);
    }
    for (const name of serverApple) {
      expect(Object.keys(SERVER_ENV_VARS), name).toContain(name);
      expect(Object.keys(PUBLIC_ENV_VARS), name).not.toContain(name);
    }
    for (const name of [...publicApple, ...serverApple]) {
      const entry = ENV_VARS.find((candidate) => candidate.name === name);
      expect(entry, name).toBeDefined();
      expect(entry?.required, name).toBe(false);
      // 任意の変数は、無いと何が起きるかを書く
      expect(entry?.whenMissing, name).toBeTruthy();
    }
  });

  it('必須は Supabase の接続情報の 3 つだけ。スキーマの必須/任意と env-required の分類が一致する', () => {
    const requiredFromList = ENV_VARS.filter((entry) => entry.required).map((entry) => entry.name);
    const requiredFromSchema = [
      ...Object.entries(publicEnvSchema.shape).filter(([, field]) => !field.isOptional()),
      ...Object.entries(serverEnvSchema.shape).filter(([, field]) => !field.isOptional()),
    ].map(([name]) => name);

    expect([...requiredFromList].sort()).toEqual([...REQUIRED_ENV_NAMES].sort());
    expect([...requiredFromSchema].sort()).toEqual([...REQUIRED_ENV_NAMES].sort());
    expect([...REQUIRED_ENV_NAMES].sort()).toEqual([
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
  });

  it('Supabase の接続情報以外 (メール・レート制限・課金・AI・cron・モバイル連携) はすべて任意', () => {
    const optional = ENV_VARS.filter((entry) => !entry.required).map((entry) => entry.name);

    for (const name of [
      'RESEND_API_KEY',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'STRIPE_SECRET_KEY',
      'GOOGLE_AI_STUDIO_API_KEY',
      'XAI_API_KEY',
      'OPENAI_API_KEY',
      'CRON_SECRET',
      'CRON_SECRET_PREVIOUS',
      'NATIVE_BRIDGE_LEGACY_GET',
      'NATIVE_BRIDGE_SHARE_REFRESH_TOKEN',
    ]) {
      expect(optional).toContain(name);
    }
  });

  it('採用しないと決めたサービス (Sentry・Better Stack。#1179) の変数は、一覧に載せない (.env.example からも消えている)', () => {
    const names: string[] = ENV_VARS.map((entry) => entry.name);

    for (const name of ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN', 'BETTER_STACK_TOKEN']) {
      expect(names).not.toContain(name);
    }
  });

  it('値を読む場所が決まっている変数 (AI_ULTIMATE_MODE_DAILY_LIMIT・AUTH_LOGIN_ALERT・AUTH_LOGIN_FAILURE_RESET_MINUTES・CRON_SECRET・CRON_SECRET_PREVIOUS・CSP_REPORT_ONLY・DSR_RESPONSE_DUE_DAYS・EMAIL_OUTBOX_*・EXPO_ACCESS_TOKEN・FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT・FEATURE_FLAG_CACHE_TTL_MS・IAP_RECONCILE_*・LEGAL_CONSENT_ENFORCE・LEGAL_CONSENT_NOTICE・MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS・OPERATOR_MFA_ENFORCE_FROM・OPS_ALERT_*・ORG_CHALLENGE_SHOW_NAMES・PHOTO_SIGNED_URL_TTL_SECONDS・PUSH_OUTBOX_*) は、check:env のために一覧にあるが、getOptionalEnv では読めない', () => {
    const sealed = ENV_VARS.filter((entry) => entry.readOnlyBy !== undefined);

    expect(sealed.map((entry) => [entry.name, entry.readOnlyBy]).sort()).toEqual([
      // #1142 究極モードの 1 日の上限の上書き。読み方 (0 以上の整数でなければ既定の 1 回) は Edge Functions と共用の
      // resolveAiUltimateModeDailyLimit。Web で値を読むのは consumeAiUsage の 1 か所だけ (名前を書いて読む)
      ['AI_ULTIMATE_MODE_DAILY_LIMIT', 'src/lib/plan/entitlements.ts'],
      // #1190 不審なログインの通知のスイッチ。解釈 (未設定・不正な値は on) は src/lib/auth/sessions/constants.ts の resolveLoginAlertMode、値を読むのは cron の route 1 か所
      ['AUTH_LOGIN_ALERT', 'src/app/api/cron/login-alerts/route.ts'],
      // #1165 ログインの連続失敗の回数を 0 に戻すまでの時間。不正な値の扱い (既定値に戻して warn) をログインの route 1 か所に置く
      ['AUTH_LOGIN_FAILURE_RESET_MINUTES', 'src/app/api/auth/login/route.ts'],
      ['CRON_SECRET', 'src/lib/cron-auth.ts'],
      ['CRON_SECRET_PREVIOUS', 'src/lib/cron-auth.ts'],
      // #1169 本番の CSP を「報告だけ」にするスイッチ。proxy (src/proxy.ts) が読むので、何も import しない csp.ts の isCspReportOnly 1 か所で読む
      ['CSP_REPORT_ONLY', 'src/lib/security/csp.ts'],
      // #1178 個人情報の請求の応答期限 (日)。1〜365 の整数でなければ既定の 30 日にする読み方を 1 か所に置く
      ['DSR_RESPONSE_DUE_DAYS', 'src/lib/data-subject-requests/config.ts'],
      // #1193 メールの送信待ちの試行の上限と 1 回の件数。不正な値の扱い (既定値に戻して warn) を送信待ちの cron の route 1 か所に置く
      ['EMAIL_OUTBOX_BATCH_SIZE', 'src/app/api/cron/email-outbox/route.ts'],
      ['EMAIL_OUTBOX_MAX_ATTEMPTS', 'src/app/api/cron/email-outbox/route.ts'],
      // #1136 Push 通知の送信 (Expo のアクセストークン)。未設定の扱い (送らずに掃除だけ・warn) を送信待ちの cron の route 1 か所に置く
      ['EXPO_ACCESS_TOKEN', 'src/app/api/cron/push-outbox/route.ts'],
      // #1148 機能フラグの対象ユーザー数を 1 人ずつ数える上限。正の整数でなければ既定値にする読み方を 1 か所に置く
      ['FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT', 'src/lib/super-admin/flag-active-users.ts'],
      // #1496 機能フラグの行をメモリに覚える時間。proxy (src/proxy.ts) も読むので、何も import しないファイル 1 か所で読む
      ['FEATURE_FLAG_CACHE_TTL_MS', 'src/lib/feature-flag-cache-ttl.ts'],
      // #1912 billing/04 ストアの購読の定期の取り直しの 1 回の件数と再確認の間隔。不正な値の扱い (既定値に戻して warn) を cron の route 1 か所に置く
      ['IAP_RECONCILE_BATCH_SIZE', 'src/app/api/cron/iap-reconcile/route.ts'],
      ['IAP_RECONCILE_RECHECK_HOURS', 'src/app/api/cron/iap-reconcile/route.ts'],
      // #1174 の同意ゲートのフラグ。proxy (src/proxy.ts) が lib/legal-consent.ts の isLegalConsentFlagOn で読む
      ['LEGAL_CONSENT_ENFORCE', 'lib/legal-consent.ts'],
      ['LEGAL_CONSENT_NOTICE', 'lib/legal-consent.ts'],
      // #1463 献立の単発追加の date_offset_days の上限。正の整数でなければ既定値にする読み方を 1 か所に置く
      ['MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS', 'src/lib/menu-plan-date-offset.ts'],
      // #1176 運営ロールの MFA の登録の猶予の終わり。形と実在する日時の確認 (不正なら猶予なしにして warn) を 1 か所に置く
      ['OPERATOR_MFA_ENFORCE_FROM', 'src/lib/auth/mfa/policy.ts'],
      // #1157 エラー急増の運用メール。未設定・不正な値の扱い (ログと応答の status) を cron の route 1 か所に置く
      // #1493 ブラウザ・端末から届いた error の急増の通知のしきい値 (サーバーとは別に数える)
      ['OPS_ALERT_CLIENT_ERROR_THRESHOLD', 'src/app/api/cron/app-log-alerts/route.ts'],
      ['OPS_ALERT_COOLDOWN_MINUTES', 'src/app/api/cron/app-log-alerts/route.ts'],
      // #1560 cron の共有シークレットの入れ替えの途中の通知の抑止。不正な値の扱い (既定値に戻して warn) を cron の route 1 か所に置く
      ['OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES', 'src/app/api/cron/app-log-alerts/route.ts'],
      // #1129 宛先の読み口は DB バックアップの鮮度の cron (backup-freshness) と共有する
      ['OPS_ALERT_EMAIL', 'src/lib/ops-alerts/recipient.ts'],
      ['OPS_ALERT_ERROR_THRESHOLD', 'src/app/api/cron/app-log-alerts/route.ts'],
      // #1125 (B) pg_cron の停止の通知のしきい値。不正な値の扱い (既定値に戻して warn) を cron の route 1 か所に置く
      ['OPS_ALERT_PG_CRON_STALL_MINUTES', 'src/app/api/cron/app-log-alerts/route.ts'],
      // #1132 組織チャレンジの順位表に参加者の表示名を出すか。1 / true / on / yes だけを有効とみなす読み方を 1 か所に置く
      ['ORG_CHALLENGE_SHOW_NAMES', 'src/lib/org-challenges.ts'],
      // #1365 食事写真・冷蔵庫写真の署名付き URL の有効期限。範囲の中の整数でなければ既定値にする読み方を 1 か所に置く
      ['PHOTO_SIGNED_URL_TTL_SECONDS', 'src/lib/photo-storage-signing.ts'],
      // #1136 Push 通知の送信待ちの試行の上限と 1 回の件数。不正な値の扱い (既定値に戻して warn) を送信待ちの cron の route 1 か所に置く
      ['PUSH_OUTBOX_BATCH_SIZE', 'src/app/api/cron/push-outbox/route.ts'],
      ['PUSH_OUTBOX_MAX_ATTEMPTS', 'src/app/api/cron/push-outbox/route.ts'],
    ]);
    for (const entry of sealed) {
      // 任意の変数にだけ付ける。読むファイルは実在する (ファイルを移したのに一覧が古いままにならない)
      expect(entry.required, entry.name).toBe(false);
      expect(entry.whenMissing?.trim(), entry.name).toBeTruthy();
      expect(fs.existsSync(path.join(ROOT, entry.readOnlyBy as string)), `${entry.name}: ${entry.readOnlyBy}`).toBe(true);
    }

    // 型で渡せないこと。npm run typecheck が、次の @ts-expect-error が不要になった (= 渡せてしまう) ときに失敗する。
    // 実行はしない (呼ぶと process.env から値を読んでしまうため)
    const typeOnly = () => {
      // @ts-expect-error CRON_SECRET の値を読むのは src/lib/cron-auth.ts だけ。getOptionalEnv には渡せない
      getOptionalEnv('CRON_SECRET');
      // @ts-expect-error CRON_SECRET_PREVIOUS も同じ
      getOptionalEnv('CRON_SECRET_PREVIOUS');
      // @ts-expect-error DSR_RESPONSE_DUE_DAYS の値を読むのは src/lib/data-subject-requests/config.ts だけ
      getOptionalEnv('DSR_RESPONSE_DUE_DAYS');
      // @ts-expect-error LEGAL_CONSENT_ENFORCE の値を読むのは lib/legal-consent.ts だけ (読み方を 1 つにしておく)
      getOptionalEnv('LEGAL_CONSENT_ENFORCE');
      // @ts-expect-error LEGAL_CONSENT_NOTICE も同じ
      getOptionalEnv('LEGAL_CONSENT_NOTICE');
      // @ts-expect-error OPERATOR_MFA_ENFORCE_FROM の値を読むのは src/lib/auth/mfa/policy.ts の readMfaEnforceFromEnv だけ
      getOptionalEnv('OPERATOR_MFA_ENFORCE_FROM');
      // @ts-expect-error OPS_ALERT_EMAIL の値を読むのは運用メールの宛先の読み口 (src/lib/ops-alerts/recipient.ts。#1129) だけ
      getOptionalEnv('OPS_ALERT_EMAIL');
      // @ts-expect-error OPS_ALERT_ERROR_THRESHOLD の値を読むのは cron の route (src/app/api/cron/app-log-alerts/route.ts) だけ
      getOptionalEnv('OPS_ALERT_ERROR_THRESHOLD');
      // @ts-expect-error OPS_ALERT_COOLDOWN_MINUTES も同じ
      getOptionalEnv('OPS_ALERT_COOLDOWN_MINUTES');
      // @ts-expect-error OPS_ALERT_CLIENT_ERROR_THRESHOLD も同じ (#1493)
      getOptionalEnv('OPS_ALERT_CLIENT_ERROR_THRESHOLD');
      // @ts-expect-error OPS_ALERT_PG_CRON_STALL_MINUTES も同じ (#1125 の B)
      getOptionalEnv('OPS_ALERT_PG_CRON_STALL_MINUTES');
      // @ts-expect-error OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES も同じ (#1560)
      getOptionalEnv('OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES');
      // @ts-expect-error AUTH_LOGIN_FAILURE_RESET_MINUTES の値を読むのはログインの route (src/app/api/auth/login/route.ts) だけ
      getOptionalEnv('AUTH_LOGIN_FAILURE_RESET_MINUTES');
      // @ts-expect-error AUTH_LOGIN_ALERT の値を読むのは cron の route (src/app/api/cron/login-alerts/route.ts) だけ (#1190)
      getOptionalEnv('AUTH_LOGIN_ALERT');
      // @ts-expect-error AI_ULTIMATE_MODE_DAILY_LIMIT の値を読むのは src/lib/plan/entitlements.ts (consumeAiUsage) だけ (#1142)
      getOptionalEnv('AI_ULTIMATE_MODE_DAILY_LIMIT');
      // @ts-expect-error ORG_CHALLENGE_SHOW_NAMES の値を読むのは src/lib/org-challenges.ts (showParticipantNames) だけ (#1132)
      getOptionalEnv('ORG_CHALLENGE_SHOW_NAMES');
      // @ts-expect-error EMAIL_OUTBOX_MAX_ATTEMPTS の値を読むのは送信待ちの cron の route (src/app/api/cron/email-outbox/route.ts) だけ (#1193)
      getOptionalEnv('EMAIL_OUTBOX_MAX_ATTEMPTS');
      // @ts-expect-error EMAIL_OUTBOX_BATCH_SIZE も同じ
      getOptionalEnv('EMAIL_OUTBOX_BATCH_SIZE');
      // @ts-expect-error EXPO_ACCESS_TOKEN の値を読むのは Push の送信待ちの cron の route (src/app/api/cron/push-outbox/route.ts) だけ (#1136)
      getOptionalEnv('EXPO_ACCESS_TOKEN');
      // @ts-expect-error PUSH_OUTBOX_MAX_ATTEMPTS も同じ
      getOptionalEnv('PUSH_OUTBOX_MAX_ATTEMPTS');
      // @ts-expect-error PUSH_OUTBOX_BATCH_SIZE も同じ
      getOptionalEnv('PUSH_OUTBOX_BATCH_SIZE');
      // @ts-expect-error IAP_RECONCILE_BATCH_SIZE の値を読むのは cron の route (src/app/api/cron/iap-reconcile/route.ts) だけ (#1912 billing/04)
      getOptionalEnv('IAP_RECONCILE_BATCH_SIZE');
      // @ts-expect-error IAP_RECONCILE_RECHECK_HOURS も同じ
      getOptionalEnv('IAP_RECONCILE_RECHECK_HOURS');
      getOptionalEnv('RESEND_API_KEY'); // 値を読む場所が決まっていない任意の変数は渡せる
    };
    expect(typeof typeOnly).toBe('function');
  });

  it('すべての変数に説明があり、任意の変数には「無いと何が起きるか」が書いてある', () => {
    for (const entry of ENV_VARS) {
      expect(entry.description.trim(), entry.name).not.toBe('');
      if (!entry.required) expect(entry.whenMissing?.trim(), entry.name).toBeTruthy();
    }
  });

  it('組にする変数 (Upstash の URL とトークン) は、どちらも任意の変数として一覧にある', () => {
    for (const [first, second] of ENV_PAIRS) {
      for (const name of [first, second]) {
        const entry = ENV_VARS.find((candidate) => candidate.name === name);
        expect(entry, name).toBeDefined();
        expect(entry?.required, name).toBe(false);
      }
    }
  });

  it('スキーマに直接かけると、必須が欠けた入力は失敗し、任意だけが欠けた入力は通る', () => {
    expect(publicEnvSchema.safeParse({}).success).toBe(false);
    expect(serverEnvSchema.safeParse({}).success).toBe(false);

    expect(
      publicEnvSchema.safeParse({
        NEXT_PUBLIC_SUPABASE_URL: URL_VALUE,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_VALUE,
      }).success,
    ).toBe(true);
    expect(serverEnvSchema.safeParse({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_VALUE }).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. validateEnv (check:env)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEnv', () => {
  const requiredOnly = {
    NEXT_PUBLIC_SUPABASE_URL: URL_VALUE,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_VALUE,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_VALUE,
  };

  it('必須がそろっていれば ok。任意の未設定は warnings に出るだけで、ok には影響しない', () => {
    const report = validateEnv(requiredOnly);

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    const missing = report.warnings.filter((finding) => finding.kind === 'missing').map((finding) => finding.name);
    expect(missing).toContain('RESEND_API_KEY');
    expect(missing).toContain('UPSTASH_REDIS_REST_URL');
    expect(report.present.sort()).toEqual(Object.keys(requiredOnly).sort());
  });

  it('必須が欠けていれば ok ではなく、欠けている変数名が errors に入る', () => {
    const report = validateEnv({ NEXT_PUBLIC_SUPABASE_URL: URL_VALUE });

    expect(report.ok).toBe(false);
    expect(report.errors.map((finding) => finding.name).sort()).toEqual([
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
    expect(report.errors.every((finding) => finding.kind === 'missing' && finding.required)).toBe(true);
  });

  it('空文字・空白だけの値は未設定として扱う (.env に `NAME=` と書いたままの行)', () => {
    const report = validateEnv({ ...requiredOnly, NEXT_PUBLIC_SUPABASE_URL: '', RESEND_API_KEY: '  ' });

    expect(report.ok).toBe(false);
    expect(report.errors.map((finding) => finding.name)).toEqual(['NEXT_PUBLIC_SUPABASE_URL']);
    expect(report.warnings.some((finding) => finding.name === 'RESEND_API_KEY' && finding.kind === 'missing')).toBe(true);
    expect(report.present).not.toContain('RESEND_API_KEY');
  });

  it('必須の URL の形式が不正なら errors (check:env だけが形式を見る。実行時の取り出しは存在しか見ない)', () => {
    const report = validateEnv({ ...requiredOnly, NEXT_PUBLIC_SUPABASE_URL: 'abcdefgh.supabase.co' });

    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ name: 'NEXT_PUBLIC_SUPABASE_URL', kind: 'invalid' });

    // 実行時の取り出しは、形式が不正でも (存在はするので) 値をそのまま返す。設定済みのときの挙動を変えない
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'abcdefgh.supabase.co');
    expect(getSupabaseUrl()).toBe('abcdefgh.supabase.co');
  });

  it('任意の URL の形式が不正なら warnings (ok のまま)', () => {
    const report = validateEnv({ ...requiredOnly, NEXT_PUBLIC_APP_URL: 'not a url' });

    expect(report.ok).toBe(true);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ name: 'NEXT_PUBLIC_APP_URL', kind: 'invalid', required: false }),
    );
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:54321', 'https://homegohan-app.vercel.app'])(
    'ローカルの URL や Vercel の URL (%s) は正しい形式として通る',
    (appUrl) => {
      const report = validateEnv({ ...requiredOnly, NEXT_PUBLIC_APP_URL: appUrl, NEXT_PUBLIC_SUPABASE_URL: appUrl });

      expect(report.ok).toBe(true);
      expect(report.warnings.some((finding) => finding.name === 'NEXT_PUBLIC_APP_URL' && finding.kind === 'invalid')).toBe(false);
    },
  );

  it('Upstash は URL とトークンの片方だけだと警告する (両方か、どちらも無しならよい)', () => {
    const onlyUrl = validateEnv({ ...requiredOnly, UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' });
    expect(onlyUrl.ok).toBe(true);
    expect(onlyUrl.warnings).toContainEqual(
      expect.objectContaining({ name: 'UPSTASH_REDIS_REST_TOKEN', kind: 'incomplete' }),
    );

    const onlyToken = validateEnv({ ...requiredOnly, UPSTASH_REDIS_REST_TOKEN: 'token' });
    expect(onlyToken.warnings).toContainEqual(
      expect.objectContaining({ name: 'UPSTASH_REDIS_REST_URL', kind: 'incomplete' }),
    );

    for (const source of [
      { ...requiredOnly, UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'token' },
      requiredOnly,
    ]) {
      expect(validateEnv(source).warnings.some((finding) => finding.kind === 'incomplete')).toBe(false);
    }
  });

  it('結果に環境変数の値は含まれない (不正な値の検査でも)', () => {
    const secretLooking = 'very-secret-looking-value';
    const report = validateEnv({
      ...requiredOnly,
      NEXT_PUBLIC_APP_URL: secretLooking,
      UPSTASH_REDIS_REST_TOKEN: secretLooking,
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secretLooking);
    expect(serialized).not.toContain(SERVICE_VALUE);
    expect(serialized).not.toContain(ANON_VALUE);
  });

  it('引数を省略すると process.env を検査する', () => {
    stubRequiredEnv();
    expect(validateEnv().errors.map((finding) => finding.name)).toEqual([]);

    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    expect(validateEnv().errors.map((finding) => finding.name)).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
  });

  it('normalizeEnvSource は空・空白だけの値と undefined を取り除く', () => {
    expect(normalizeEnvSource({ A: 'x', B: '', C: '  ', D: undefined, E: ' y ' })).toEqual({ A: 'x', E: ' y ' });
  });
});
