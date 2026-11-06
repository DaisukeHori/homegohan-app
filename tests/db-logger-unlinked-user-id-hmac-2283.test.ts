// @vitest-environment node
/**
 * #2283: 外部キー違反で入れ直した app_logs の行の metadata に、退会した利用者の id を生のまま残さない
 * (Next.js の src/lib/db-logger.ts と Edge の _shared/db-logger.ts の両方。判定と入れ直しの行は _shared/log-sanitizer.ts)
 *
 * 直す前: app_logs.user_id の外部キー違反 (23503) で user_id を外して入れ直すとき、元の user_id を
 * metadata の user_id_not_in_auth_users に生の uuid のまま入れていた (#2259 P3)。
 * 直した後: 退会の記録と同じ方式の HMAC (DB の public.pii_hmac_hex('account_deletion_subject', id)。鍵は Vault の pii_hmac_key)
 * を入れる。Next.js と Edge は同じ DB の関数を同じ引数で呼ぶので、同じ id なら同じ値になる。
 * HMAC を計算できなかったとき (関数の error・例外・形に合わない値) は印を入れ、生の id は入れない。
 *
 * テストの rpc は、pii_hmac_hex と同じ計算 (HMAC-SHA256(p_domain || ':' || p_value) を 16 進で。
 * supabase/migrations/20261016190000_deletion_record_and_invite_email_hash.sql) をテストの鍵で行う。
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'test-service-role-key';
const ROUTE_NAME = 'db-logger-unlinked-hmac-test';
/** テストの HMAC の鍵 (本物の鍵は Vault にあり、アプリは読まない) */
const TEST_HMAC_KEY = 'test-pii-hmac-key-2283';
/** auth.users に無い利用者 (テストでは insert の応答を手で外部キー違反にする) */
const MISSING_USER_ID = '00000000-0000-4000-8000-000000002283';
/** もう 1 人の、auth.users に無い利用者 */
const OTHER_MISSING_USER_ID = '00000000-0000-4000-8000-000000002284';
/** 入れ直した行で、元の user_id の HMAC を残す metadata のキー (log-sanitizer.ts の UNLINKED_USER_ID_METADATA_KEY) */
const UNLINKED_USER_ID_KEY = 'user_id_not_in_auth_users';
/** 退会の記録 (gdpr_deletion_requests.subject_hash) と同じ HMAC の用途 */
const HMAC_DOMAIN = 'account_deletion_subject';
/** HMAC を計算する DB の関数の名前 */
const HMAC_RPC = 'pii_hmac_hex';
/** HMAC を計算できなかったときに入れる印 (log-sanitizer.ts の UNLINKED_USER_ID_HMAC_UNAVAILABLE) */
const HMAC_UNAVAILABLE = '[hmac unavailable]';
/** HMAC-SHA256 を 16 進で書いた形 */
const HMAC_HEX = /^[0-9a-f]{64}$/;
/** Postgres の外部キー違反のエラーコード (foreign_key_violation) */
const FOREIGN_KEY_VIOLATION = '23503';
/** 一意制約違反 (外部キー違反でない失敗の例) */
const UNIQUE_VIOLATION = '23505';
/** マイクロタスクを流す回数 (保存 → insert → rpc → 入れ直しの insert の呼び出しが流れきるのに足りる回数) */
const MICROTASK_DRAIN_ROUNDS = 60;

const FK_ERROR = {
  code: FOREIGN_KEY_VIOLATION,
  message: 'insert or update on table "app_logs" violates foreign key constraint "app_logs_user_id_fkey"',
};

/** pii_hmac_hex と同じ計算 (テストの鍵で) */
function expectedHmac(value: string, domain: string = HMAC_DOMAIN): string {
  return createHmac('sha256', TEST_HMAC_KEY).update(`${domain}:${value}`).digest('hex');
}

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  insert: vi.fn(),
  rpc: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: h.createClient }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

/** pii_hmac_hex の rpc の応答 (本物と同じく、名前と引数を見て HMAC を返す) */
function piiHmacRpc(fn: string, args: { p_domain?: unknown; p_value?: unknown }) {
  if (fn !== HMAC_RPC) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `no function ${fn}` } });
  if (typeof args.p_domain !== 'string' || typeof args.p_value !== 'string') {
    return Promise.resolve({ data: null, error: { code: '22023', message: 'bad args' } });
  }
  return Promise.resolve({ data: expectedHmac(args.p_value, args.p_domain), error: null });
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_DRAIN_ROUNDS; i += 1) {
    await Promise.resolve();
  }
}

interface LoggerLike {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, error?: unknown, metadata?: Record<string, unknown>) => void;
}

type LoggerModule = { createLogger: (name: string) => LoggerLike & { withUser: (userId: string) => LoggerLike } };

interface Variant {
  name: string;
  load: () => Promise<LoggerModule>;
}

const NEXT_VARIANT: Variant = { name: 'Next.js (src/lib/db-logger.ts)', load: () => import('@/lib/db-logger') };
const EDGE_VARIANT: Variant = {
  name: 'Edge Functions (supabase/functions/_shared/db-logger.ts)',
  load: () => import('../supabase/functions/_shared/db-logger.ts'),
};
const VARIANTS: readonly Variant[] = [NEXT_VARIANT, EDGE_VARIANT];

/** app_logs への insert に渡した行 */
function insertedRows(): Array<Record<string, unknown>> {
  return h.insert.mock.calls.map(([row]) => row as Record<string, unknown>);
}

/** 1 人の利用者の withUser の warn を外部キー違反で落とし、入れ直した行を返す */
async function retriedRowFor(variant: Variant, userId: string): Promise<Record<string, unknown>> {
  h.insert.mockReset().mockResolvedValueOnce({ error: FK_ERROR }).mockResolvedValueOnce({ error: null });
  const { createLogger } = await variant.load();
  createLogger(ROUTE_NAME).withUser(userId).warn('利用者のログ', { step: 1 });
  await drainMicrotasks();
  const rows = insertedRows();
  if (rows.length !== 2) throw new Error(`insert が ${rows.length} 回 (2 回のはず)`);
  return rows[1];
}

function metadataOf(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = row.metadata;
  if (typeof metadata !== 'object' || metadata === null) throw new Error('metadata が無い');
  return metadata as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetModules();
  h.env = { SUPABASE_URL, SERVICE_ROLE_JWT: SERVICE_ROLE_KEY };
  h.insert.mockReset().mockResolvedValue({ error: null });
  h.rpc.mockReset().mockImplementation(piiHmacRpc);
  h.createClient.mockReset().mockReturnValue({ from: () => ({ insert: h.insert }), rpc: h.rpc });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubGlobal('Deno', { env: { get: (key: string) => h.env[key] } });
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(VARIANTS)('$name: 入れ直した行の metadata に元の user_id を生のまま残さない (#2283)', (variant) => {
  it('metadata の user_id_not_in_auth_users は pii_hmac_hex(account_deletion_subject, id) の値。行のどこにも生の id が無い', async () => {
    const retried = await retriedRowFor(variant, MISSING_USER_ID);

    expect(retried.user_id).toBeUndefined();
    expect(metadataOf(retried)[UNLINKED_USER_ID_KEY]).toBe(expectedHmac(MISSING_USER_ID));
    expect(metadataOf(retried)[UNLINKED_USER_ID_KEY]).toMatch(HMAC_HEX);
    expect(metadataOf(retried).step).toBe(1);
    expect(JSON.stringify(retried)).not.toContain(MISSING_USER_ID);
    // HMAC は service_role のクライアントの rpc で DB の関数に計算させる (退会の記録と同じ用途・同じ関数)
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith(HMAC_RPC, { p_domain: HMAC_DOMAIN, p_value: MISSING_USER_ID });
  });

  it('同じ id なら同じ値・違う id なら違う値', async () => {
    const first = metadataOf(await retriedRowFor(variant, MISSING_USER_ID))[UNLINKED_USER_ID_KEY];
    const again = metadataOf(await retriedRowFor(variant, MISSING_USER_ID))[UNLINKED_USER_ID_KEY];
    const other = metadataOf(await retriedRowFor(variant, OTHER_MISSING_USER_ID))[UNLINKED_USER_ID_KEY];

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(other).toBe(expectedHmac(OTHER_MISSING_USER_ID));
  });

  it('大文字の uuid でも小文字にしてから HMAC にする (Postgres の uuid::text と同じ形。退会の記録の subject_hash と同じ値になる)', async () => {
    const retried = await retriedRowFor(variant, MISSING_USER_ID.toUpperCase());

    expect(metadataOf(retried)[UNLINKED_USER_ID_KEY]).toBe(expectedHmac(MISSING_USER_ID));
    expect(h.rpc).toHaveBeenCalledWith(HMAC_RPC, { p_domain: HMAC_DOMAIN, p_value: MISSING_USER_ID });
  });

  it.each([
    ['関数が error を返す (鍵が Vault に無いなど)', () => Promise.resolve({ data: null, error: { code: 'P0001', message: 'pii_hmac_key not found in Vault' } })],
    ['rpc が例外を投げる (DB に届かないなど)', () => Promise.reject(new TypeError('fetch failed'))],
    ['値が 16 進 64 文字でない', () => Promise.resolve({ data: 'not-a-hmac', error: null })],
    ['値が元の id そのもの', () => Promise.resolve({ data: MISSING_USER_ID, error: null })],
    ['値が無い', () => Promise.resolve({ data: null, error: null })],
  ])('HMAC を計算できない (%s) ときも入れ直し、印を入れて生の id は入れない', async (_label, respond) => {
    h.rpc.mockReset().mockImplementation(respond);

    const retried = await retriedRowFor(variant, MISSING_USER_ID);

    expect(retried.user_id).toBeUndefined();
    expect(metadataOf(retried)[UNLINKED_USER_ID_KEY]).toBe(HMAC_UNAVAILABLE);
    expect(JSON.stringify(retried)).not.toContain(MISSING_USER_ID);
  });

  it('クライアントに rpc が無くても (古い形のクライアント) 入れ直しは止まらず、生の id は入れない', async () => {
    h.createClient.mockReset().mockReturnValue({ from: () => ({ insert: h.insert }) });

    const retried = await retriedRowFor(variant, MISSING_USER_ID);

    expect(metadataOf(retried)[UNLINKED_USER_ID_KEY]).toBe(HMAC_UNAVAILABLE);
    expect(JSON.stringify(retried)).not.toContain(MISSING_USER_ID);
  });

  it('入れ直さない失敗 (23505・user_id の無い行の 23503) では HMAC を計算しない', async () => {
    const { createLogger } = await variant.load();
    h.insert.mockReset().mockResolvedValueOnce({ error: { code: UNIQUE_VIOLATION, message: 'duplicate key' } });
    createLogger(ROUTE_NAME).withUser(MISSING_USER_ID).info('一意制約');
    await drainMicrotasks();
    h.insert.mockReset().mockResolvedValueOnce({ error: FK_ERROR });
    createLogger(ROUTE_NAME).info('利用者なし');
    await drainMicrotasks();

    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('Next.js と Edge で同じ値 (同じ鍵のとき。#2283)', () => {
  it('同じ id の入れ直しの行の metadata の値が、Next.js と Edge で一致する', async () => {
    const fromNext = metadataOf(await retriedRowFor(NEXT_VARIANT, MISSING_USER_ID))[UNLINKED_USER_ID_KEY];
    const nextRpcCalls = [...h.rpc.mock.calls];
    h.rpc.mockClear();
    const fromEdge = metadataOf(await retriedRowFor(EDGE_VARIANT, MISSING_USER_ID))[UNLINKED_USER_ID_KEY];

    expect(fromNext).toMatch(HMAC_HEX);
    expect(fromEdge).toBe(fromNext);
    // 両方が同じ DB の関数を同じ引数で呼ぶ (値が一致するのは、鍵を持つ DB が計算するから)
    expect(h.rpc.mock.calls).toEqual(nextRpcCalls);
  });
});

describe('log-sanitizer の entryForForeignKeyRetry と createUnlinkedUserIdHasher (#2283)', () => {
  async function loadSanitizer() {
    return import('../supabase/functions/_shared/log-sanitizer.ts');
  }

  it('hashUserId の値を metadata の先頭に入れ、元の id は入れない (引数は書き換えない)', async () => {
    const { entryForForeignKeyRetry, createUnlinkedUserIdHasher } = await loadSanitizer();
    const entry = { level: 'error', source: 'api-route', user_id: MISSING_USER_ID, message: 'x', metadata: { a: 1 } };
    const snapshot = structuredClone(entry);

    const retried = await entryForForeignKeyRetry(FK_ERROR, entry, createUnlinkedUserIdHasher((args) => h.rpc(HMAC_RPC, args)));

    expect(retried).toEqual({ level: 'error', source: 'api-route', message: 'x', metadata: { [UNLINKED_USER_ID_KEY]: expectedHmac(MISSING_USER_ID), a: 1 } });
    expect(Object.keys(retried?.metadata ?? {})[0]).toBe(UNLINKED_USER_ID_KEY);
    expect(JSON.stringify(retried)).not.toContain(MISSING_USER_ID);
    expect(entry).toEqual(snapshot);
  });

  it('元の metadata に同じ名前のキーで生の id があっても、HMAC で上書きする', async () => {
    const { entryForForeignKeyRetry, createUnlinkedUserIdHasher } = await loadSanitizer();
    const entry = { level: 'warn', source: 'edge-function', user_id: MISSING_USER_ID, message: 'x', metadata: { [UNLINKED_USER_ID_KEY]: MISSING_USER_ID } };

    const retried = await entryForForeignKeyRetry(FK_ERROR, entry, createUnlinkedUserIdHasher((args) => h.rpc(HMAC_RPC, args)));

    expect(retried?.metadata).toEqual({ [UNLINKED_USER_ID_KEY]: expectedHmac(MISSING_USER_ID) });
  });

  it.each([
    ['null を返す', () => Promise.resolve(null)],
    ['例外を投げる', () => Promise.reject(new Error('boom'))],
    ['元の id をそのまま返す', (userId: string) => Promise.resolve(userId)],
  ])('hashUserId が %s なら印を入れる', async (_label, hashUserId) => {
    const { entryForForeignKeyRetry, UNLINKED_USER_ID_HMAC_UNAVAILABLE } = await loadSanitizer();
    const entry = { level: 'warn', source: 'edge-function', user_id: MISSING_USER_ID, message: 'x' };

    const retried = await entryForForeignKeyRetry(FK_ERROR, entry, hashUserId);

    expect(UNLINKED_USER_ID_HMAC_UNAVAILABLE).toBe(HMAC_UNAVAILABLE);
    expect(retried?.metadata).toEqual({ [UNLINKED_USER_ID_KEY]: HMAC_UNAVAILABLE });
  });

  it('入れ直さないとき (23503 でない・user_id が無い) は hashUserId を呼ばずに null', async () => {
    const { entryForForeignKeyRetry } = await loadSanitizer();
    const hashUserId = vi.fn(async (userId: string) => expectedHmac(userId));

    expect(await entryForForeignKeyRetry({ code: UNIQUE_VIOLATION }, { level: 'warn', source: 'api-route', user_id: MISSING_USER_ID, message: 'x' }, hashUserId)).toBeNull();
    expect(await entryForForeignKeyRetry(FK_ERROR, { level: 'warn', source: 'api-route', message: 'x' }, hashUserId)).toBeNull();
    expect(hashUserId).not.toHaveBeenCalled();
  });

  it('定数は退会の記録と同じ用途・同じ DB の関数を指す', async () => {
    const { UNLINKED_USER_ID_HMAC_DOMAIN, PII_HMAC_HEX_RPC, UNLINKED_USER_ID_METADATA_KEY } = await loadSanitizer();
    expect(UNLINKED_USER_ID_HMAC_DOMAIN).toBe(HMAC_DOMAIN);
    expect(PII_HMAC_HEX_RPC).toBe(HMAC_RPC);
    expect(UNLINKED_USER_ID_METADATA_KEY).toBe(UNLINKED_USER_ID_KEY);
  });
});
