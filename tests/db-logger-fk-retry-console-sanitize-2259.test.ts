// @vitest-environment node
/**
 * #2259 P3: app_logs のログの 2 つの欠陥の回帰テスト (Next.js の src/lib/db-logger.ts と Edge の _shared/db-logger.ts の両方)
 *
 * 1. app_logs.user_id は auth.users への外部キー (app_logs_user_id_fkey) なので、auth.users に無い利用者
 *    (退会して消えた利用者など) の withUser(userId) のログは insert が外部キー違反 (23503) で落ち、関数ログにだけ残っていた。
 *    直した後: 23503 で落ちた user_id つきの行は、user_id を外して 1 回だけ入れ直し、元の user_id を metadata に残す。
 *    ほかの失敗 (23503 以外・user_id の無い行) は入れ直さない。入れ直しも落ちたら、それ以上は入れ直さない。
 * 2. Edge の db-logger は console (Supabase の関数ログ) に metadata を生のまま出していた (app_logs への保存は
 *    sanitizeLogEntry を通すので影響しない)。直した後: Next.js 側と同じく、console にも sanitizeMetadata を通した metadata を出す。
 *    無印・withUser の、debug / info / warn / error のすべてで。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeMetadata } from '../supabase/functions/_shared/log-sanitizer.ts';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'test-service-role-key';
const ROUTE_NAME = 'db-logger-fk-retry-test';
/** auth.users に無い利用者 (テストでは insert の応答を手で外部キー違反にする) */
const MISSING_USER_ID = '00000000-0000-4000-8000-000000002259';
/** Postgres の外部キー違反のエラーコード (foreign_key_violation) */
const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres の一意制約違反のエラーコード (外部キー違反でない失敗の例) */
const UNIQUE_VIOLATION = '23505';
/** 入れ直した行で、元の user_id を残す metadata のキー (log-sanitizer.ts の UNLINKED_USER_ID_METADATA_KEY) */
const UNLINKED_USER_ID_KEY = 'user_id_not_in_auth_users';
/** マイクロタスクを流す回数 (保存 → insert → 入れ直しの insert の呼び出しが流れきるのに足りる回数) */
const MICROTASK_DRAIN_ROUNDS = 40;

/** console に出してはいけない秘密の値 (キー名でも書式でもマスクされる) */
const SECRET_TOKEN = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_PASSWORD = 'hunter2-plain-password';
/** マスクの対象を含む metadata (キー名 api_key・値の書式 sk-・入れ子の password) */
const SECRET_METADATA: Record<string, unknown> = {
  api_key: SECRET_TOKEN,
  note: `upstream said ${SECRET_TOKEN}`,
  nested: { password: SECRET_PASSWORD, step: 1 },
};

const FK_ERROR = {
  code: FOREIGN_KEY_VIOLATION,
  message: 'insert or update on table "app_logs" violates foreign key constraint "app_logs_user_id_fkey"',
};

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

/** 行から keys を除いた写し */
function omitKeys(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

/** app_logs への insert に渡した行 */
function insertedRows(): Array<Record<string, unknown>> {
  return h.insert.mock.calls.map(([row]) => row as Record<string, unknown>);
}

/** console の全メソッドに渡した引数 (呼んだ順はメソッドごと) */
function allConsoleArgs(): unknown[][] {
  return CONSOLE_METHODS.flatMap((method) => vi.mocked(console[method]).mock.calls);
}

/** console に出したログの行 (1 つ目の引数が message を含む呼び出し) */
function consoleCallFor(message: string): unknown[] {
  const calls = allConsoleArgs().filter((args) => String(args[0]).includes(message));
  if (calls.length !== 1) throw new Error(`console に「${message}」の行が ${calls.length} 回出た (1 回のはず)`);
  return calls[0];
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

describe.each(VARIANTS)('$name: app_logs.user_id の外部キーで落ちた行 (#2259 P3)', ({ load }) => {
  it('withUser の error が外部キー違反 (23503) で落ちたら、user_id を外して 1 回だけ入れ直し、元の user_id を metadata に残す', async () => {
    h.insert.mockResolvedValueOnce({ error: FK_ERROR }).mockResolvedValueOnce({ error: null });
    const { createLogger } = await load();

    createLogger(ROUTE_NAME).withUser(MISSING_USER_ID).error('監査の書き込みに失敗', new Error('boom'), { event: 'TRANSFER' });
    await drainMicrotasks();

    const rows = insertedRows();
    expect(rows).toHaveLength(2);
    const [first, retried] = rows;
    expect(first.user_id).toBe(MISSING_USER_ID);
    expect(retried).not.toHaveProperty('user_id');
    expect(retried.metadata).toEqual({ event: 'TRANSFER', [UNLINKED_USER_ID_KEY]: MISSING_USER_ID });
    // user_id と metadata のほかは、最初の行と同じものを入れ直す
    const retriedRest = omitKeys(retried, ['metadata']);
    expect(retriedRest).toEqual(omitKeys(first, ['user_id', 'metadata']));
    expect(retriedRest).toMatchObject({ level: 'error', message: '監査の書き込みに失敗', error_message: 'boom' });
    // 外部キーで落ちたことは console (関数ログ) に warn で残し、入れ直しが通ったので error は出さない
    expect(vi.mocked(console.warn).mock.calls.some((args) => args.includes(FK_ERROR))).toBe(true);
    expect(vi.mocked(console.error).mock.calls.some((args) => String(args[0]).includes('Failed to save log to DB'))).toBe(false);
  });

  it.each(['debug', 'info', 'warn'] as const)('withUser の %s も、metadata の無い行でも入れ直す (metadata は元の user_id だけ)', async (level) => {
    h.insert.mockResolvedValueOnce({ error: FK_ERROR }).mockResolvedValueOnce({ error: null });
    const { createLogger } = await load();

    createLogger(ROUTE_NAME).withUser(MISSING_USER_ID)[level]('利用者のログ');
    await drainMicrotasks();

    const rows = insertedRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).not.toHaveProperty('user_id');
    expect(rows[1]).toMatchObject({ level, message: '利用者のログ', metadata: { [UNLINKED_USER_ID_KEY]: MISSING_USER_ID } });
  });

  it('入れ直しも落ちたら、それ以上は入れ直さず console.error に残す (insert は 2 回まで)', async () => {
    const retryError = { code: FOREIGN_KEY_VIOLATION, message: 'still failing' };
    h.insert.mockResolvedValueOnce({ error: FK_ERROR }).mockResolvedValueOnce({ error: retryError });
    const { createLogger } = await load();

    createLogger(ROUTE_NAME).withUser(MISSING_USER_ID).warn('利用者の警告');
    await drainMicrotasks();

    expect(insertedRows()).toHaveLength(2);
    expect(console.error).toHaveBeenCalledWith('Failed to save log to DB:', retryError);
  });

  it('外部キー違反でない失敗 (23505) は入れ直さず、従来どおり console.error に残す', async () => {
    const otherError = { code: UNIQUE_VIOLATION, message: 'duplicate key' };
    h.insert.mockResolvedValueOnce({ error: otherError });
    const { createLogger } = await load();

    createLogger(ROUTE_NAME).withUser(MISSING_USER_ID).info('利用者のログ');
    await drainMicrotasks();

    expect(insertedRows()).toHaveLength(1);
    expect(insertedRows()[0].user_id).toBe(MISSING_USER_ID);
    expect(console.error).toHaveBeenCalledWith('Failed to save log to DB:', otherError);
  });

  it('user_id の無い行 (無印のロガー) は 23503 でも入れ直さない', async () => {
    h.insert.mockResolvedValueOnce({ error: FK_ERROR });
    const { createLogger } = await load();

    createLogger(ROUTE_NAME).info('利用者なし');
    await drainMicrotasks();

    expect(insertedRows()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith('Failed to save log to DB:', FK_ERROR);
  });
});

describe.each(VARIANTS)('$name: console に出す metadata は sanitizeMetadata を通す (#2259 P3)', ({ load }) => {
  const expected = sanitizeMetadata(SECRET_METADATA);

  function expectSanitizedMetadataArg(args: unknown[]): void {
    const metadataArg = args[args.length - 1];
    expect(metadataArg).toEqual(expected);
    const printed = JSON.stringify(args.slice(1));
    expect(printed).not.toContain(SECRET_TOKEN);
    expect(printed).not.toContain(SECRET_PASSWORD);
  }

  it.each(['debug', 'info', 'warn'] as const)('無印の %s', async (level) => {
    const { createLogger } = await load();
    createLogger(ROUTE_NAME)[level](`無印の${level}`, SECRET_METADATA);
    await drainMicrotasks();
    expectSanitizedMetadataArg(consoleCallFor(`無印の${level}`));
  });

  it('無印の error', async () => {
    const { createLogger } = await load();
    createLogger(ROUTE_NAME).error('無印のerror', new Error('boom'), SECRET_METADATA);
    await drainMicrotasks();
    expectSanitizedMetadataArg(consoleCallFor('無印のerror'));
  });

  it.each(['debug', 'info', 'warn'] as const)('withUser の %s', async (level) => {
    const { createLogger } = await load();
    createLogger(ROUTE_NAME).withUser(MISSING_USER_ID)[level](`利用者の${level}`, SECRET_METADATA);
    await drainMicrotasks();
    expectSanitizedMetadataArg(consoleCallFor(`利用者の${level}`));
  });

  it('withUser の error', async () => {
    const { createLogger } = await load();
    createLogger(ROUTE_NAME).withUser(MISSING_USER_ID).error('利用者のerror', new Error('boom'), SECRET_METADATA);
    await drainMicrotasks();
    expectSanitizedMetadataArg(consoleCallFor('利用者のerror'));
  });

  it('metadata が無ければ従来どおり空文字を出す', async () => {
    const { createLogger } = await load();
    createLogger(ROUTE_NAME).info('metadata なし');
    await drainMicrotasks();
    const args = consoleCallFor('metadata なし');
    expect(args[args.length - 1]).toBe('');
  });
});

describe('log-sanitizer の rowForForeignKeyRetry (#2259 P3)', () => {
  async function loadSanitizer() {
    return import('../supabase/functions/_shared/log-sanitizer.ts');
  }

  it('外部キー違反で user_id のある行: user_id を省き、metadata に元の user_id を足した新しい行を返す (引数は書き換えない)', async () => {
    const { rowForForeignKeyRetry, sanitizeLogEntry } = await loadSanitizer();
    const row = sanitizeLogEntry({ level: 'error', source: 'api-route', user_id: MISSING_USER_ID, message: 'x', metadata: { a: 1 } });
    const snapshot = structuredClone(row);

    const retried = rowForForeignKeyRetry(FK_ERROR, row);

    expect(retried).toEqual({ level: 'error', source: 'api-route', message: 'x', metadata: { a: 1, [UNLINKED_USER_ID_KEY]: MISSING_USER_ID } });
    expect(retried).not.toHaveProperty('user_id');
    expect(row).toEqual(snapshot);
  });

  it.each([
    ['23503 でない', { code: UNIQUE_VIOLATION }],
    ['code が無い', { message: 'network' }],
    ['null', null],
    ['文字列', FOREIGN_KEY_VIOLATION],
  ])('error が %s なら null (入れ直さない)', async (_label, error) => {
    const { rowForForeignKeyRetry, sanitizeLogEntry } = await loadSanitizer();
    const row = sanitizeLogEntry({ level: 'warn', source: 'edge-function', user_id: MISSING_USER_ID, message: 'x' });
    expect(rowForForeignKeyRetry(error, row)).toBeNull();
  });

  it('user_id の無い行 (uuid でない user_id を sanitizeLogEntry が外した行も) は 23503 でも null', async () => {
    const { rowForForeignKeyRetry, sanitizeLogEntry } = await loadSanitizer();
    const row = sanitizeLogEntry({ level: 'warn', source: 'edge-function', user_id: 'unknown', message: 'x' });
    expect(rowForForeignKeyRetry(FK_ERROR, row)).toBeNull();
  });
});
