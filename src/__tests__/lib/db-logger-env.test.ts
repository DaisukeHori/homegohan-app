// @vitest-environment node
/**
 * db-logger が app_logs に書き込むときの接続情報 (#1434)
 *
 * 以前は process.env を自前で読み、`!url` で判定していたため、空白だけの値を通して Supabase のクライアントを作っていた。
 * いまは env-required の getter (getSupabaseServiceConfig) で取り出し、欠けていれば (空白だけも) app_logs には書かない。
 * ログを書く処理なので、欠けていても例外を投げない (console には出る)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

import { createLogger } from '@/lib/db-logger';
import { MISSING_ENV_SERVER_LOG_PREFIX } from '@/lib/env-required';

const TEST_URL = 'http://127.0.0.1:54321';
const TEST_SERVICE_ROLE_KEY = 'service-role-key-for-test';

/** saveLog は待たずに走るので、マイクロタスクを流して終わらせる */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mocks.insert.mockResolvedValue({ error: null });
  mocks.createClient.mockReturnValue({ from: () => ({ insert: mocks.insert }) });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.createClient.mockReset();
  mocks.insert.mockReset();
});

describe('db-logger の接続情報 (#1434)', () => {
  it('接続情報がそろっていれば、その値で service_role のクライアントを作って app_logs に書く', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST_URL);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', TEST_SERVICE_ROLE_KEY);

    createLogger('GET /api/test').info('hello');
    await flush();

    expect(mocks.createClient).toHaveBeenCalledWith(TEST_URL, TEST_SERVICE_ROLE_KEY);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', '   '],
    ['NEXT_PUBLIC_SUPABASE_URL', ''],
    ['SUPABASE_SERVICE_ROLE_KEY', '   '],
    ['SUPABASE_SERVICE_ROLE_KEY', undefined],
  ])('%s が %j なら、クライアントを作らず app_logs に書かない。例外は投げず、欠けた変数名をサーバーのログに残す', async (name, value) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST_URL);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', TEST_SERVICE_ROLE_KEY);
    vi.stubEnv(name, value);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => createLogger('GET /api/test').info('hello')).not.toThrow();
    await flush();

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(MISSING_ENV_SERVER_LOG_PREFIX, name);
  });
});
