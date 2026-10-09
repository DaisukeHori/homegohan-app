// @vitest-environment node
/**
 * src/lib/env.ts と src/lib/env-required.ts のテスト (#1182)
 *
 * 以前は `process.env.X!` が散らばっていて、環境変数が欠けていても型の上では string のまま undefined が
 * Supabase のクライアントや fetch の URL に流れ込み、変数名の分からないエラーになっていた。
 *
 *   1. 必須の環境変数 (env-required): 欠けていれば変数名つきの MissingEnvError。値はそのまま返す
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

  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', getSupabaseUrl],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', getSupabaseAnonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', getSupabaseServiceRoleKey],
  ] as const)('%s が未設定なら、その変数名を入れた MissingEnvError を投げる', (name, getter) => {
    vi.stubEnv(name, undefined);

    let thrown: unknown;
    try {
      getter();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MissingEnvError);
    expect(isMissingEnvError(thrown)).toBe(true);
    expect((thrown as MissingEnvError).envName).toBe(name);
    expect((thrown as MissingEnvError).name).toBe('MissingEnvError');
    expect((thrown as MissingEnvError).message).toContain(name);
  });

  it.each(['', ' ', '\t\n'])('値が %j (空・空白だけ) でも、未設定として扱う', (blank) => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', blank);

    expect(() => getSupabaseServiceRoleKey()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('接続情報をまとめて取るときも、欠けている変数名を報告する (URL が先)', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_VALUE);

    expect(() => getSupabasePublicConfig()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(() => getSupabaseServiceConfig()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_VALUE);
    expect(() => getSupabasePublicConfig()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(getSupabaseServiceConfig()).toEqual({ url: URL_VALUE, serviceRoleKey: SERVICE_VALUE });

    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    expect(() => getSupabaseServiceConfig()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('エラーの文面に、他の環境変数の値は含まれない', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_VALUE);

    let message = '';
    try {
      getSupabaseServiceConfig();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(message).not.toContain(SERVICE_VALUE);
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

  it('値を読む場所が決まっている変数 (CRON_SECRET・CRON_SECRET_PREVIOUS) は、check:env のために一覧にあるが、getOptionalEnv では読めない', () => {
    const sealed = ENV_VARS.filter((entry) => entry.readOnlyBy !== undefined);

    expect(sealed.map((entry) => entry.name).sort()).toEqual(['CRON_SECRET', 'CRON_SECRET_PREVIOUS']);
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
