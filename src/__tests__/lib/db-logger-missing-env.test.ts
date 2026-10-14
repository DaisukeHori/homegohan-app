// @vitest-environment node
/**
 * 必須の環境変数が欠けていたとき (MissingEnvError)、変数名を構造化ログ (db-logger) に残すことのテスト (#1182)
 *
 * MissingEnvError の message には変数名を入れない (500 の本文に漏れないように。#1172)。
 * そのかわり db-logger の error() が envName を読み、metadata の missing_env_name に変数名を記録する。
 *   - console (Vercel の関数ログ) と app_logs の両方に残る
 *   - 値は記録しない
 *   - MissingEnvError 以外のエラーでは metadata を変えない
 * internalError() (src/lib/api/errors.ts) を通したときも、本文には変数名が出ず、ログには残ることを見る。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInsert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));
const mockFrom = vi.fn((_table: string) => ({ insert: mockInsert }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: mockFrom })),
}));

import { MISSING_ENV_NAME_LOG_KEY, createLogger, withMissingEnvName } from '@/lib/db-logger';
import { MISSING_ENV_ERROR_MESSAGE, MissingEnvError, REQUIRED_ENV_NAMES } from '@/lib/env-required';
import { internalError, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';

// app_logs への書き込み先 (モック)。値は記録されないことを確かめるため、目立つ文字列にする
const TEST_URL = 'https://logger-test.supabase.co';
const TEST_SERVICE_VALUE = 'service-role-value-must-not-be-logged';

/** saveLog は待たずに走るので、書き込みが済むのを待つ */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let consoleError: ReturnType<typeof vi.spyOn>;

/** console.error の全呼び出しを、1 つの文字列にする (オブジェクトは JSON にする) */
function consoleErrorText(): string {
  return consoleError.mock.calls
    .flat()
    .map((arg: unknown) => (typeof arg === 'string' ? arg : arg instanceof Error ? `${arg.message}\n${arg.stack}` : JSON.stringify(arg)))
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', TEST_SERVICE_VALUE);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('withMissingEnvName (#1182)', () => {
  it.each(REQUIRED_ENV_NAMES)('MissingEnvError (%s) なら、変数名を missing_env_name に足し、渡された metadata も残す', (name) => {
    expect(withMissingEnvName(new MissingEnvError(name), { table: 'x' })).toEqual({
      table: 'x',
      [MISSING_ENV_NAME_LOG_KEY]: name,
    });
    expect(withMissingEnvName(new MissingEnvError(name))).toEqual({ [MISSING_ENV_NAME_LOG_KEY]: name });
  });

  it('MissingEnvError 以外なら、metadata をそのまま返す (キーを足さない)', () => {
    const metadata = { table: 'x' };

    expect(withMissingEnvName(new Error('boom'), metadata)).toBe(metadata);
    expect(withMissingEnvName('boom', undefined)).toBeUndefined();
  });

  it('キーの名前は missing_env_name', () => {
    expect(MISSING_ENV_NAME_LOG_KEY).toBe('missing_env_name');
  });
});

describe('createLogger().error — MissingEnvError の変数名を構造化ログに残す (#1182)', () => {
  it.each(REQUIRED_ENV_NAMES)('%s: app_logs の metadata に変数名が入り、error_message は固定の文 (変数名なし)', async (name) => {
    createLogger('test-route', 'req-1').error('失敗しました', new MissingEnvError(name), { table: 'health_goals' });
    await flush();

    expect(mockFrom).toHaveBeenCalledWith('app_logs');
    const row = mockInsert.mock.calls[0][0] as { metadata: Record<string, unknown>; error_message: string };
    expect(row.metadata).toEqual({ table: 'health_goals', [MISSING_ENV_NAME_LOG_KEY]: name });
    expect(row.error_message).toBe(MISSING_ENV_ERROR_MESSAGE);
    // 値は記録しない
    expect(JSON.stringify(row)).not.toContain(TEST_SERVICE_VALUE);
  });

  it('console (Vercel の関数ログ) にも変数名が出る', () => {
    createLogger('test-route').error('失敗しました', new MissingEnvError('SUPABASE_SERVICE_ROLE_KEY'));

    expect(consoleErrorText()).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(consoleErrorText()).not.toContain(TEST_SERVICE_VALUE);
  });

  it('withUser() のロガーでも、変数名を metadata に残す', async () => {
    createLogger('test-route').withUser('00000000-0000-4000-8000-000000000001').error(
      '失敗しました',
      new MissingEnvError('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    );
    await flush();

    const row = mockInsert.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(row.metadata).toEqual({ [MISSING_ENV_NAME_LOG_KEY]: 'NEXT_PUBLIC_SUPABASE_ANON_KEY' });
    expect(consoleErrorText()).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  });

  it('app_logs に書けないとき (書き込み先の変数自体が欠けている) も、console には変数名が残る', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);

    createLogger('test-route').error('失敗しました', new MissingEnvError('SUPABASE_SERVICE_ROLE_KEY'));
    await flush();

    expect(mockInsert).not.toHaveBeenCalled();
    expect(consoleErrorText()).toContain(`"${MISSING_ENV_NAME_LOG_KEY}":"SUPABASE_SERVICE_ROLE_KEY"`);
  });

  it('MissingEnvError 以外のエラーでは、metadata に missing_env_name を足さない', async () => {
    createLogger('test-route').error('失敗しました', new Error('boom'), { table: 'x' });
    await flush();

    const row = mockInsert.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(row.metadata).toEqual({ table: 'x' });
  });
});

describe('internalError — 本文には変数名を出さず、変数名は構造化ログに残す (#1172 / #1182)', () => {
  it.each(REQUIRED_ENV_NAMES)('%s: 汎用の 500。本文・ヘッダに変数名が無く、app_logs と console には残る', async (name) => {
    const response = internalError('GET /api/test', new MissingEnvError(name), { table: 'x' });
    const text = await response.text();
    await flush();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: 'INTERNAL_ERROR' });
    expect(text).not.toContain(name);
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(name);

    const row = mockInsert.mock.calls[0][0] as { metadata: Record<string, unknown>; function_name: string };
    expect(row.function_name).toBe('GET /api/test');
    expect(row.metadata).toMatchObject({ table: 'x', [MISSING_ENV_NAME_LOG_KEY]: name });
    expect(consoleErrorText()).toContain(name);
  });
});
