// @vitest-environment node
/**
 * Edge Functions の _shared/db-logger.ts も、ログの保存が終わるまで関数を止めさせない (#1909 の後片付け)
 *
 * Next.js 側 (src/lib/db-logger.ts) は #1913 で、保存の Promise を @vercel/functions の waitUntil に渡すようにした。
 * Edge 側も同じ形 (保存を待たずに応答を返す) だったため、Supabase の Edge Runtime の EdgeRuntime.waitUntil に渡す
 * (公式の文書 "Background Tasks": waitUntil に渡した Promise が終わるまで関数のインスタンスは動き続ける)。
 * ここでは本体を動かし、渡した Promise が insert の応答で終わること・上限で打ち切ること・EdgeRuntime が無くても
 * 保存は続くことを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_JWT = 'test-service-role-jwt';
const FUNCTION_NAME = 'db-logger-keepalive-test';
const USER_ID = '00000000-0000-4000-8000-000000001909';
/** マイクロタスクを流す回数 (保存 → catch → race → finally → then の連鎖が流れきるのに足りる回数) */
const MICROTASK_DRAIN_ROUNDS = 20;

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  createClient: vi.fn(),
  insert: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: h.createClient }));

async function loadLogger() {
  return import('../supabase/functions/_shared/db-logger.ts');
}

type Logger = ReturnType<Awaited<ReturnType<typeof loadLogger>>['createLogger']>;

/** 外から resolve できる Promise (insert の応答を手で返す) */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_DRAIN_ROUNDS; i += 1) {
    await Promise.resolve();
  }
}

function keptAlive(index = 0): Promise<unknown> {
  const arg: unknown = h.waitUntil.mock.calls[index]?.[0];
  if (!(arg instanceof Promise)) throw new Error(`EdgeRuntime.waitUntil の ${index} 番目の引数が Promise ではない`);
  return arg;
}

beforeEach(() => {
  vi.resetModules();
  h.env = { SUPABASE_URL, SERVICE_ROLE_JWT };
  h.insert.mockReset();
  h.waitUntil.mockReset();
  h.createClient.mockReset().mockReturnValue({ from: () => ({ insert: h.insert }) });
  vi.stubGlobal('Deno', { env: { get: (key: string) => h.env[key] } });
  vi.stubGlobal('EdgeRuntime', { waitUntil: h.waitUntil });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Edge の db-logger: 保存が終わるまで関数を止めさせない (#1909)', () => {
  it.each([
    ['debug', (l: Logger) => l.debug('d')],
    ['info', (l: Logger) => l.info('i')],
    ['warn', (l: Logger) => l.warn('w')],
    ['error', (l: Logger) => l.error('e', new Error('boom'))],
    ['withUser().info', (l: Logger) => l.withUser(USER_ID).info('ui')],
    ['withUser().error', (l: Logger) => l.withUser(USER_ID).error('ue', new Error('boom'))],
  ])('%s: EdgeRuntime.waitUntil に渡した Promise は、insert の応答が返るまで終わらない', async (_name, call) => {
    const insert = deferred<{ error: null }>();
    h.insert.mockReturnValue(insert.promise);
    const { createLogger } = await loadLogger();

    call(createLogger(FUNCTION_NAME));
    expect(h.waitUntil).toHaveBeenCalledTimes(1);
    const state = track(keptAlive());
    await drainMicrotasks();
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(state.settled).toBe(false);

    insert.resolve({ error: null });
    await drainMicrotasks();
    expect(state).toEqual({ settled: true, rejected: false });
  });

  it('ログ 1 行ごとに 1 回ずつ渡す (別々の保存をそれぞれ待つ)', async () => {
    h.insert.mockResolvedValue({ error: null });
    const { createLogger } = await loadLogger();
    const logger = createLogger(FUNCTION_NAME);
    logger.info('a');
    logger.warn('b');
    expect(h.waitUntil).toHaveBeenCalledTimes(2);
    expect(keptAlive(0)).not.toBe(keptAlive(1));
    await drainMicrotasks();
    expect(h.insert).toHaveBeenCalledTimes(2);
  });

  it('保存が返ってこなくても、延命は LOG_SAVE_KEEPALIVE_TIMEOUT_MS で打ち切る (それより前には終わらない)', async () => {
    h.insert.mockReturnValue(new Promise(() => {}));
    const { createLogger, LOG_SAVE_KEEPALIVE_TIMEOUT_MS } = await loadLogger();
    vi.useFakeTimers();

    createLogger(FUNCTION_NAME).info('hang');
    const state = track(keptAlive());

    await vi.advanceTimersByTimeAsync(LOG_SAVE_KEEPALIVE_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(state).toEqual({ settled: true, rejected: false });
  });

  it('保存が先に終わったら上限のタイマーを残さない', async () => {
    h.insert.mockResolvedValue({ error: null });
    const { createLogger } = await loadLogger();
    vi.useFakeTimers();

    createLogger(FUNCTION_NAME).info('quick');
    const state = track(keptAlive());
    await drainMicrotasks();
    expect(state.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('接続が切れて insert が投げても、渡した Promise は reject せず、失敗を console に残す', async () => {
    const networkError = new TypeError('fetch failed');
    h.insert.mockRejectedValue(networkError);
    const { createLogger } = await loadLogger();

    createLogger(FUNCTION_NAME).warn('w');
    const state = track(keptAlive());
    await drainMicrotasks();

    expect(state).toEqual({ settled: true, rejected: false });
    expect(console.error).toHaveBeenCalledWith('Failed to save log to DB:', networkError);
  });

  it.each([
    ['EdgeRuntime が無い (素の Deno・テスト)', undefined],
    ['EdgeRuntime に waitUntil が無い', {}],
  ])('%s: 例外を投げず、保存は続ける', async (_name, runtime) => {
    vi.stubGlobal('EdgeRuntime', runtime);
    h.insert.mockResolvedValue({ error: null });
    const { createLogger } = await loadLogger();

    expect(() => createLogger(FUNCTION_NAME).info('x')).not.toThrow();
    await drainMicrotasks();
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.waitUntil).not.toHaveBeenCalled();
  });

  it('EdgeRuntime.waitUntil が投げても、ロガーは例外を投げず保存は続ける', async () => {
    h.waitUntil.mockImplementation(() => {
      throw new Error('no request context');
    });
    h.insert.mockResolvedValue({ error: null });
    const { createLogger } = await loadLogger();

    expect(() => createLogger(FUNCTION_NAME).info('x')).not.toThrow();
    await drainMicrotasks();
    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it('EdgeRuntime.waitUntil は EdgeRuntime を this にして呼ぶ (本物の実装がメソッドとして呼ばれる前提でも動く)', async () => {
    const runtime = {
      calls: 0,
      waitUntil(this: { calls: number }, _promise: Promise<unknown>) {
        this.calls += 1;
      },
    };
    vi.stubGlobal('EdgeRuntime', runtime);
    h.insert.mockResolvedValue({ error: null });
    const { createLogger } = await loadLogger();

    createLogger(FUNCTION_NAME).info('x');
    expect(runtime.calls).toBe(1);
  });

  it('上限は Next.js 側 (src/lib/db-logger.ts) と同じ値', async () => {
    const edge = await loadLogger();
    const node = await import('../src/lib/db-logger');
    expect(edge.LOG_SAVE_KEEPALIVE_TIMEOUT_MS).toBe(node.LOG_SAVE_KEEPALIVE_TIMEOUT_MS);
  });
});
