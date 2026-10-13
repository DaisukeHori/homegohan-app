// @vitest-environment node
/**
 * #1518 Edge Functions の _shared/db-logger.ts の supabase-js の読み方を変えても、ログの保存の動きは変わらない
 *
 * 以前は `https://esm.sh/@supabase/supabase-js@2` (メジャー版だけの指定) から createClient を読んでいたため、
 * Vitest では読み込めず、どのテストもこのファイルをモックに差し替えるかソースの文字列を見るだけだった。
 * いまは supabase/functions/deno.json の imports (正確な版で固定) の名前 `@supabase/supabase-js` で読むので、
 * Vitest でもそのまま読み込める。ここでは本体を動かし、使っている API (createClient(url, key) →
 * from('app_logs').insert(...) の { error }) の呼び方が以前と同じであることを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sanitizeLogEntry } from '../supabase/functions/_shared/log-sanitizer.ts';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_JWT = 'test-service-role-jwt';
const SERVICE_ROLE_KEY = 'test-service-role-key';
const FUNCTION_NAME = 'db-logger-test';
const REQUEST_ID = 'req_test_1518';
const USER_ID = '00000000-0000-4000-8000-000000001518';

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  createClient: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: h.createClient }));

async function loadLogger() {
  return import('../supabase/functions/_shared/db-logger.ts');
}

beforeEach(() => {
  vi.resetModules();
  h.env = { SUPABASE_URL, SERVICE_ROLE_JWT, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };
  h.insert.mockReset().mockResolvedValue({ error: null });
  h.from.mockReset().mockReturnValue({ insert: h.insert });
  h.createClient.mockReset().mockReturnValue({ from: h.from });
  vi.stubGlobal('Deno', { env: { get: (key: string) => h.env[key] } });
  // ロガーはコンソールにも出すので、テストの出力を汚さないよう黙らせる
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#1518 _shared/db-logger.ts は deno.json の名前の supabase-js で app_logs へ保存する', () => {
  it('info: createClient(SUPABASE_URL, SERVICE_ROLE_JWT) で作ったクライアントで app_logs へ、サニタイズした行を insert する', async () => {
    const { createLogger } = await loadLogger();
    createLogger(FUNCTION_NAME, REQUEST_ID).info('保存する', { step: 1 });

    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledTimes(1));
    expect(h.createClient).toHaveBeenCalledWith(SUPABASE_URL, SERVICE_ROLE_JWT);
    expect(h.from).toHaveBeenCalledWith('app_logs');
    expect(h.insert).toHaveBeenCalledWith(
      sanitizeLogEntry({
        source: 'edge-function',
        function_name: FUNCTION_NAME,
        request_id: REQUEST_ID,
        level: 'info',
        message: '保存する',
        metadata: { step: 1 },
      }),
    );
  });

  it('SERVICE_ROLE_JWT が無ければ SUPABASE_SERVICE_ROLE_KEY を使う', async () => {
    h.env.SERVICE_ROLE_JWT = undefined;
    const { createLogger } = await loadLogger();
    createLogger(FUNCTION_NAME).warn('鍵の代わり');

    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledTimes(1));
    expect(h.createClient).toHaveBeenCalledWith(SUPABASE_URL, SERVICE_ROLE_KEY);
  });

  it('error と withUser: エラーの文・スタックと user_id を入れて保存する', async () => {
    const { createLogger } = await loadLogger();
    const failure = new Error('失敗した');
    createLogger(FUNCTION_NAME).withUser(USER_ID).error('処理に失敗', failure);

    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledTimes(1));
    expect(h.insert).toHaveBeenCalledWith(
      sanitizeLogEntry({
        source: 'edge-function',
        function_name: FUNCTION_NAME,
        request_id: undefined,
        user_id: USER_ID,
        level: 'error',
        message: '処理に失敗',
        metadata: undefined,
        error_message: failure.message,
        error_stack: failure.stack,
      }),
    );
  });

  it('SUPABASE_URL が無ければクライアントを作らず、保存しない (例外も投げない)', async () => {
    h.env.SUPABASE_URL = undefined;
    const { createLogger } = await loadLogger();
    expect(() => createLogger(FUNCTION_NAME).info('保存しない')).not.toThrow();

    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith('Missing SUPABASE_URL or service role key'),
    );
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('insert が { error } を返しても、insert が投げても、呼び出し元へ例外を出さない', async () => {
    const insertError = { message: 'insert failed' };
    h.insert.mockResolvedValueOnce({ error: insertError }).mockRejectedValueOnce(new Error('network down'));
    const { createLogger } = await loadLogger();
    const logger = createLogger(FUNCTION_NAME);

    expect(() => logger.info('1 回目')).not.toThrow();
    expect(() => logger.info('2 回目')).not.toThrow();

    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith('Failed to save log to DB:', insertError));
    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith('Failed to save log to DB:', expect.objectContaining({ message: 'network down' })),
    );
  });
});
