// @vitest-environment node
/**
 * #2254 M3: withUser(userId) のロガーの warn も、関数ログ (Vercel / Supabase) では warning の水準で出す
 *
 * 問題:
 *   src/lib/db-logger.ts と supabase/functions/_shared/db-logger.ts の withUser(userId) のロガーは、level に関わらず
 *   console.log で出していた。無印のロガー (createLogger(...).warn) は console.warn で出すので、同じ warn でも withUser を
 *   通すと関数ログでは info の水準になり、関数ログの水準で警報・絞り込みをすると見え方が変わる
 *   (app_logs の level は前から warn のまま)。
 * 直した後:
 *   どちらの db-logger も、無印のロガーと withUser のロガーとで同じ振り分けにする
 *   (error → console.error・warn → console.warn・debug / info → console.log)。app_logs の level と user_id 列は変えない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'test-service-role-key';
const ROUTE_NAME = 'db-logger-console-level-test';
const USER_ID = '00000000-0000-4000-8000-000000002254';
/** マイクロタスクを流す回数 (保存 → insert の呼び出しが流れきるのに足りる回数) */
const MICROTASK_DRAIN_ROUNDS = 20;

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  insert: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: h.createClient }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_DRAIN_ROUNDS; i += 1) {
    await Promise.resolve();
  }
}

type ConsoleMethod = 'log' | 'warn' | 'error';
const CONSOLE_METHODS: readonly ConsoleMethod[] = ['log', 'warn', 'error'];

interface LoggerLike {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, error?: unknown, metadata?: Record<string, unknown>) => void;
}

interface Variant {
  name: string;
  load: () => Promise<{ createLogger: (name: string) => LoggerLike & { withUser: (userId: string) => LoggerLike } }>;
}

const VARIANTS: readonly Variant[] = [
  { name: 'Next.js (src/lib/db-logger.ts)', load: () => import('@/lib/db-logger') },
  { name: 'Edge Functions (supabase/functions/_shared/db-logger.ts)', load: () => import('../supabase/functions/_shared/db-logger.ts') },
];

/** 呼んだ console のメソッドと、その 1 つ目の引数 (ログの行) */
function consoleCalls(): Array<{ method: ConsoleMethod; line: string }> {
  const calls: Array<{ method: ConsoleMethod; line: string }> = [];
  for (const method of CONSOLE_METHODS) {
    for (const args of vi.mocked(console[method]).mock.calls) calls.push({ method, line: String(args[0]) });
  }
  return calls;
}

/** app_logs への insert の行 (level と user_id) */
function insertedRows(): Array<{ level: unknown; user_id: unknown }> {
  return h.insert.mock.calls.map(([row]) => {
    const record = row as Record<string, unknown>;
    return { level: record.level, user_id: record.user_id };
  });
}

beforeEach(() => {
  vi.resetModules();
  h.env = { SUPABASE_URL, SERVICE_ROLE_JWT: SERVICE_ROLE_KEY };
  h.insert.mockReset().mockResolvedValue({ error: null });
  h.createClient.mockReset().mockReturnValue({ from: () => ({ insert: h.insert }) });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubGlobal('Deno', { env: { get: (key: string) => h.env[key] } });
  for (const method of CONSOLE_METHODS) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(VARIANTS)('$name: console の水準 (#2254 M3)', ({ load }) => {
  it('withUser(userId).warn は console.warn で出す (console.log では出さない)。app_logs は level warn・user_id 列に利用者', async () => {
    const { createLogger } = await load();

    createLogger(ROUTE_NAME).withUser(USER_ID).warn('利用者の警告');
    await drainMicrotasks();

    const calls = consoleCalls();
    expect(calls.map((call) => call.method)).toEqual(['warn']);
    expect(calls[0].line).toContain('[WARN]');
    expect(calls[0].line).toContain(`[user:${USER_ID}]`);
    expect(calls[0].line).toContain('利用者の警告');
    expect(insertedRows()).toEqual([{ level: 'warn', user_id: USER_ID }]);
  });

  it.each([
    ['debug', 'log'],
    ['info', 'log'],
    ['warn', 'warn'],
  ] as const)('%s: 無印のロガーと withUser のロガーは同じ console のメソッド (%s) で出す', async (level, expected) => {
    const { createLogger } = await load();
    const logger = createLogger(ROUTE_NAME);

    logger[level]('無印');
    logger.withUser(USER_ID)[level]('利用者つき');
    await drainMicrotasks();

    expect(consoleCalls().map((call) => call.method)).toEqual([expected, expected]);
    expect(insertedRows()).toEqual([
      { level, user_id: undefined },
      { level, user_id: USER_ID },
    ]);
  });

  it('error は無印・withUser のどちらも console.error で出す (従来どおり)', async () => {
    const { createLogger } = await load();
    const logger = createLogger(ROUTE_NAME);

    logger.error('無印の失敗', new Error('boom'));
    logger.withUser(USER_ID).error('利用者の失敗', new Error('boom'));
    await drainMicrotasks();

    expect(consoleCalls().map((call) => call.method)).toEqual(['error', 'error']);
    expect(insertedRows()).toEqual([
      { level: 'error', user_id: undefined },
      { level: 'error', user_id: USER_ID },
    ]);
  });
});
