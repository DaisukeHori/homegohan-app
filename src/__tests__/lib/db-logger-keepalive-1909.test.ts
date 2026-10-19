// @vitest-environment node
/**
 * db-logger のログの保存が終わるまで、Vercel の関数を止めさせない (#1909)
 *
 * 本番で `Failed to save log to DB: TypeError: fetch failed` (ECONNRESET / UND_ERR_SOCKET) が毎分出ていた。
 * 呼び出し元はログの保存を待たずに応答を返すため、保存の通信の途中で関数が止められ (凍結され)、
 * 次の呼び出しで起こされたときに接続が切れていて保存が失われていた。
 * 直した後は、保存の Promise を @vercel/functions の waitUntil に渡し、保存が終わる (または上限を過ぎる) まで関数を止めさせない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  insert: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: mocks.waitUntil,
}));

import { createLogger, LOG_SAVE_KEEPALIVE_TIMEOUT_MS } from '@/lib/db-logger';

const TEST_URL = 'http://127.0.0.1:54321';
const TEST_SERVICE_ROLE_KEY = 'service-role-key-for-test';
const TEST_USER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
/** 上限の 1 ミリ秒手前 (まだ延命が終わっていないことを確かめる) */
const JUST_BEFORE_DEADLINE_MS = LOG_SAVE_KEEPALIVE_TIMEOUT_MS - 1;
/** マイクロタスクを流す回数 (保存 → catch → race → finally → then の連鎖が流れきるのに足りる回数) */
const MICROTASK_DRAIN_ROUNDS = 20;

/** 外から resolve / reject できる Promise (insert の応答を手で返す) */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Promise が終わったかどうかを、待たずに見られるようにする */
function track(promise: Promise<unknown>) {
  const state = { settled: false, rejected: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
      state.rejected = true;
    },
  );
  return state;
}

/** マイクロタスクを流しきる (偽のタイマーの下でも動くように、タイマーを使わない) */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_DRAIN_ROUNDS; i += 1) {
    await Promise.resolve();
  }
}

/** waitUntil に渡された Promise (n 番目の呼び出し) */
function keptAlive(index = 0): Promise<unknown> {
  const arg: unknown = mocks.waitUntil.mock.calls[index]?.[0];
  if (!(arg instanceof Promise)) throw new Error(`waitUntil の ${index} 番目の引数が Promise ではない`);
  return arg;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', TEST_SERVICE_ROLE_KEY);
  mocks.createClient.mockReturnValue({ from: () => ({ insert: mocks.insert }) });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.createClient.mockReset();
  mocks.insert.mockReset();
  mocks.waitUntil.mockReset();
});

describe('db-logger: 保存が終わるまで関数を止めさせない (#1909)', () => {
  it('waitUntil に渡した Promise は、insert の応答が返るまで終わらない (返ったら終わる)', async () => {
    const insert = deferred<{ error: null }>();
    mocks.insert.mockReturnValue(insert.promise);

    createLogger('cron/push-outbox', 'req_1').warn('EXPO_ACCESS_TOKEN が未設定');
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    const state = track(keptAlive());

    await drainMicrotasks();
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(state.settled).toBe(false);

    insert.resolve({ error: null });
    await drainMicrotasks();
    expect(state).toEqual({ settled: true, rejected: false });
  });

  it.each([
    ['debug', (l: ReturnType<typeof createLogger>) => l.debug('d')],
    ['info', (l: ReturnType<typeof createLogger>) => l.info('i')],
    ['warn', (l: ReturnType<typeof createLogger>) => l.warn('w')],
    ['error', (l: ReturnType<typeof createLogger>) => l.error('e', new Error('boom'))],
    ['withUser().info', (l: ReturnType<typeof createLogger>) => l.withUser(TEST_USER_ID).info('ui')],
    ['withUser().error', (l: ReturnType<typeof createLogger>) => l.withUser(TEST_USER_ID).error('ue', new Error('boom'))],
  ])('%s も保存の Promise を waitUntil に渡し、保存が終わるまで終わらない', async (_name, call) => {
    const insert = deferred<{ error: null }>();
    mocks.insert.mockReturnValue(insert.promise);

    call(createLogger('GET /api/test'));
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    const state = track(keptAlive());
    await drainMicrotasks();
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(state.settled).toBe(false);

    insert.resolve({ error: null });
    await drainMicrotasks();
    expect(state.settled).toBe(true);
  });

  it('ログ 1 行ごとに 1 回ずつ渡す (別々の保存をそれぞれ待つ)', async () => {
    mocks.insert.mockResolvedValue({ error: null });
    const logger = createLogger('GET /api/test');
    logger.info('a');
    logger.warn('b');
    expect(mocks.waitUntil).toHaveBeenCalledTimes(2);
    expect(keptAlive(0)).not.toBe(keptAlive(1));
    await drainMicrotasks();
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });

  it('保存が返ってこなくても、延命は LOG_SAVE_KEEPALIVE_TIMEOUT_MS で打ち切る (それより前には終わらない)', async () => {
    vi.useFakeTimers();
    mocks.insert.mockReturnValue(new Promise(() => {}));

    createLogger('GET /api/test').info('hang');
    const state = track(keptAlive());

    await vi.advanceTimersByTimeAsync(JUST_BEFORE_DEADLINE_MS);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(state).toEqual({ settled: true, rejected: false });
  });

  it('保存が先に終わったら上限のタイマーを残さない', async () => {
    vi.useFakeTimers();
    mocks.insert.mockResolvedValue({ error: null });

    createLogger('GET /api/test').info('quick');
    const state = track(keptAlive());
    await drainMicrotasks();
    expect(state.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('接続が切れて insert が投げても、waitUntil の Promise は reject せず、失敗を console に残す', async () => {
    const networkError = new TypeError('fetch failed');
    mocks.insert.mockRejectedValue(networkError);

    createLogger('cron/push-outbox').warn('w');
    const state = track(keptAlive());
    await drainMicrotasks();

    expect(state).toEqual({ settled: true, rejected: false });
    expect(console.error).toHaveBeenCalledWith('Failed to save log to DB:', networkError);
  });

  it('waitUntil が投げても、ロガーは例外を投げず保存は続ける', async () => {
    mocks.waitUntil.mockImplementation(() => {
      throw new Error('no request context');
    });
    mocks.insert.mockResolvedValue({ error: null });

    expect(() => createLogger('GET /api/test').info('x')).not.toThrow();
    await drainMicrotasks();
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });
});
