/**
 * アカウント削除の本体 (src/lib/account-deletion.ts, #1175) の単体テスト
 *
 * Supabase はメモリ上の偽物。実物 (DB・Auth・Storage) での確認は tests/integration/security/account-deletion.test.ts。
 *
 * 確認すること:
 *   - 組織のオーナー / 家族の代表者は、従来と同じ 409 の形で止まり、何も呼ばない
 *   - 順序: 確認 → prepare_account_deletion → release_user_membership → Storage → auth.admin.deleteUser
 *   - 失敗の扱い: prepare / Storage / deleteUser の失敗はそこで止めて ACCOUNT_DELETE_FAILED (deleteUser より前なら deleteUser を呼ばない)。
 *     ライセンス解放 (release_user_membership) の失敗だけは続ける
 *   - 失敗の結果に、DB・Storage の生のエラー文を入れない。request_id と段階を持つ (HTTP の応答は route が #1172 の internalError で返す)
 *   - すでに消えているユーザーの deleteUser (404) は成功として扱う (やり直せる)
 *   - ログにメールアドレスを載せない。削除後のログに user_id を付けない
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  accountDeletionFailure,
  accountDeletionHttp,
  isAccountDeletionFailure,
  deleteAccount,
  type DeleteAccountResult,
  type AccountDeletionAdmin,
  type AccountDeletionLogger,
} from '../src/lib/account-deletion';

const USER = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = 'req_test_1';
const SECRET_DB_MESSAGE = 'duplicate key value violates unique constraint "secret_constraint" (user@example.com)';

/** 成功・409 の結果を HTTP の応答にする (失敗の結果は accountDeletionHttp に渡せない。route が internalError で返す) */
function httpOf(result: DeleteAccountResult) {
  if (isAccountDeletionFailure(result)) throw new Error(`unexpected failure at step: ${result.step}`);
  return accountDeletionHttp(result);
}

interface World {
  calls: string[];
  /** from(table) が返す行 / エラー */
  tables: Record<string, { data?: unknown[] | null; error?: { message: string } | null }>;
  rpc: Record<string, { data?: unknown; error?: { message: string; code?: string } | null; throws?: boolean }>;
  /** storage.list / remove の挙動 */
  storage: { listError?: { message: string } | null; entries?: Array<{ name: string; id: string | null }>; removeError?: { message: string } | null };
  deleteUser: { error?: { message: string; status?: number; code?: string } | null };
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    calls: [],
    tables: { organizations: { data: [] }, family_groups: { data: [] } },
    rpc: { prepare_account_deletion: { data: { email_delivery_logs: 1 } }, release_user_membership: { data: null } },
    storage: {},
    deleteUser: {},
    ...overrides,
  };
}

function makeAdmin(world: World): AccountDeletionAdmin {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'limit', 'not', 'order', 'range']) b[method] = () => b;
    b.then = (resolve: (value: unknown) => unknown) => {
      world.calls.push(`from:${table}`);
      const entry = world.tables[table] ?? { data: [] };
      return resolve({ data: entry.data ?? [], error: entry.error ?? null });
    };
    return b;
  };

  // Storage: 最初の list だけ中身を返し、remove のあとは空にする
  let listed = false;
  const storage = {
    from: (bucket: string) => ({
      list: async () => {
        world.calls.push(`storage.list:${bucket}`);
        if (world.storage.listError) return { data: null, error: world.storage.listError };
        const data = !listed && bucket === 'fridge-images' ? (world.storage.entries ?? []) : [];
        return { data, error: null };
      },
      remove: async (paths: string[]) => {
        world.calls.push(`storage.remove:${bucket}`);
        if (world.storage.removeError) return { data: null, error: world.storage.removeError };
        listed = true;
        return { data: paths.map((name) => ({ name })), error: null };
      },
    }),
  };

  return {
    from: (table: string) => builder(table),
    rpc: async (name: string) => {
      world.calls.push(`rpc:${name}`);
      const entry = world.rpc[name] ?? { data: null };
      if (entry.throws) throw new Error('network down');
      return { data: entry.data ?? null, error: entry.error ?? null };
    },
    storage,
    auth: {
      admin: {
        deleteUser: async () => {
          world.calls.push('auth.deleteUser');
          return { data: null, error: world.deleteUser.error ?? null };
        },
      },
    },
  } as unknown as AccountDeletionAdmin;
}

function makeLogger() {
  const entries: Array<{ level: string; message: string; metadata?: unknown; error?: unknown; viaUser: boolean }> = [];
  const make = (viaUser: boolean) => ({
    debug: vi.fn(),
    info: (message: string, metadata?: unknown) => entries.push({ level: 'info', message, metadata, viaUser }),
    warn: (message: string, metadata?: unknown) => entries.push({ level: 'warn', message, metadata, viaUser }),
    error: (message: string, error?: unknown, metadata?: unknown) =>
      entries.push({ level: 'error', message, error, metadata, viaUser }),
  });
  const logger = { ...make(false), withUser: () => make(true) } as unknown as AccountDeletionLogger;
  return { logger, entries };
}

let world: World;
let logs: ReturnType<typeof makeLogger>;

beforeEach(() => {
  world = makeWorld();
  logs = makeLogger();
});

const run = (extra: Record<string, unknown> = {}) =>
  deleteAccount({ userId: USER, admin: makeAdmin(world), requestId: REQUEST_ID, logger: logs.logger, ...extra });

describe('deleteAccount: 409 (従来と同じ形)', () => {
  it('組織のオーナーは ACCOUNT_DELETE_BLOCKED_ORG_OWNER。何も呼ばない', async () => {
    world.tables.organizations = { data: [{ id: 'org-1', name: '株式会社テスト' }] };
    const result = await run();

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
      message: '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。',
      organization: { id: 'org-1', name: '株式会社テスト' },
    });
    expect(world.calls).toEqual(['from:organizations']);
    expect(httpOf(result)).toEqual({
      status: 409,
      body: {
        error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
        message: '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。',
        organization: { id: 'org-1', name: '株式会社テスト' },
      },
    });
  });

  it('家族グループの代表者は ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE。何も呼ばない', async () => {
    world.tables.family_groups = { data: [{ id: 'fg-1', name: 'うちの家族' }] };
    const result = await run();

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
      message: '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。',
      family_group: { id: 'fg-1', name: 'うちの家族' },
    });
    expect(world.calls).toEqual(['from:organizations', 'from:family_groups']);
    expect(httpOf(result).body).toEqual({
      error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
      message: '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。',
      family_group: { id: 'fg-1', name: 'うちの家族' },
    });
  });

  it('オーナー確認の問い合わせ自体が失敗したら、先へ進まず ACCOUNT_DELETE_FAILED (確認できないまま消さない)', async () => {
    world.tables.organizations = { error: { message: SECRET_DB_MESSAGE } };
    const result = await run();
    expect(result).toMatchObject({ ok: false, status: 500, error: 'ACCOUNT_DELETE_FAILED', step: 'check_blockers' });
    expect(world.calls).toEqual(['from:organizations']);

    world = makeWorld({ tables: { organizations: { data: [] }, family_groups: { error: { message: SECRET_DB_MESSAGE } } } });
    const second = await run();
    expect(second).toMatchObject({ ok: false, error: 'ACCOUNT_DELETE_FAILED', step: 'check_blockers' });
    expect(world.calls).not.toContain('auth.deleteUser');
  });
});

describe('deleteAccount: 成功', () => {
  it('確認 → prepare → ライセンス解放 → Storage → deleteUser の順に呼ぶ', async () => {
    world.storage.entries = [{ name: 'a.png', id: 'obj-1' }];
    const result = await run();

    expect(result).toEqual({ ok: true });
    const order = world.calls.filter((call) => !call.startsWith('storage.list'));
    expect(order.slice(0, 4)).toEqual(['from:organizations', 'from:family_groups', 'rpc:prepare_account_deletion', 'rpc:release_user_membership']);
    expect(world.calls.indexOf('storage.remove:fridge-images')).toBeGreaterThan(world.calls.indexOf('rpc:release_user_membership'));
    expect(world.calls[world.calls.length - 1]).toBe('auth.deleteUser');
    // 3 バケットとも掃除する
    for (const bucket of ['meal_photos', 'fridge-images', 'health-checkups']) {
      expect(world.calls).toContain(`storage.list:${bucket}`);
    }
    expect(httpOf(result)).toEqual({ status: 200, body: { success: true } });
  });

  it('成功のログには user_id もメールアドレスも載せず (削除後なので withUser を使わない)、掃除の件数だけを載せる', async () => {
    world.storage.entries = [{ name: 'a.png', id: 'obj-1' }];
    await run();

    const info = logs.entries.find((entry) => entry.message === 'account deleted');
    expect(info).toBeDefined();
    expect(info?.viaUser).toBe(false);
    const serialized = JSON.stringify(info?.metadata);
    expect(serialized).not.toContain(USER);
    expect(serialized).toContain('"email_delivery_logs":1');
    expect(serialized).toContain('removed_total');
  });
});

describe('deleteAccount: 失敗の扱い', () => {
  it('prepare_account_deletion の失敗: deleteUser も Storage も呼ばない。応答に生のエラー文を入れない', async () => {
    world.rpc.prepare_account_deletion = { error: { message: SECRET_DB_MESSAGE, code: '42883' } };
    const result = await run();

    expect(result).toEqual(accountDeletionFailure(REQUEST_ID, 'prepare'));
    expect(world.calls).not.toContain('rpc:release_user_membership');
    expect(world.calls.some((call) => call.startsWith('storage.'))).toBe(false);
    expect(world.calls).not.toContain('auth.deleteUser');

    // 失敗の結果に、DB の生のエラー文・メールアドレスを入れない (HTTP の応答は route が internalError で返す)
    expect(isAccountDeletionFailure(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret_constraint');
    expect(JSON.stringify(result)).not.toContain('user@example.com');
  });

  it('失敗はログ (error) に、段階・request_id・SQLSTATE を残す。user_id は付ける (まだ削除されていない)', async () => {
    world.rpc.prepare_account_deletion = { error: { message: SECRET_DB_MESSAGE, code: '42883' } };
    await run();

    const failure = logs.entries.find((entry) => entry.level === 'error');
    expect(failure?.message).toBe('account deletion failed at step: prepare');
    expect(failure?.viaUser).toBe(true);
    expect(failure?.metadata).toMatchObject({ step: 'prepare', request_id: REQUEST_ID, error_code: '42883' });
    // supabase-js のエラーは素のオブジェクトで来ることがある。ログには原因が残るよう、Error にそろえて渡す ("[object Object]" にしない)
    expect(failure?.error).toBeInstanceOf(Error);
    expect((failure?.error as Error).message).toBe(SECRET_DB_MESSAGE);
  });

  it('Storage の失敗: deleteUser を呼ばない (写真が残ったまま本人だけ消えるのを防ぐ。やり直せる)', async () => {
    world.storage.listError = { message: 'storage is down' };
    const result = await run();

    expect(result).toMatchObject({ ok: false, error: 'ACCOUNT_DELETE_FAILED', step: 'storage' });
    expect(world.calls).toContain('rpc:prepare_account_deletion');
    expect(world.calls).toContain('rpc:release_user_membership');
    expect(world.calls).not.toContain('auth.deleteUser');
  });

  it('deleteUser の失敗: ACCOUNT_DELETE_FAILED (step: delete_user)。生のエラー文は応答に入れない', async () => {
    world.deleteUser.error = { message: SECRET_DB_MESSAGE, status: 500, code: 'unexpected_failure' };
    const result = await run();

    expect(result).toMatchObject({ ok: false, status: 500, error: 'ACCOUNT_DELETE_FAILED', step: 'delete_user' });
    expect(JSON.stringify(result)).not.toContain('secret_constraint');
    const failure = logs.entries.find((entry) => entry.level === 'error');
    expect(failure?.metadata).toMatchObject({ step: 'delete_user', error_status: 500, error_code: 'unexpected_failure' });
  });

  it('ライセンス解放 (release_user_membership) の失敗は続ける (エラーでも、例外でも)', async () => {
    world.rpc.release_user_membership = { error: { message: 'boom' } };
    expect(await run()).toEqual({ ok: true });
    expect(world.calls).toContain('auth.deleteUser');
    expect(logs.entries.some((entry) => entry.level === 'error' && /release_user_membership failed/.test(entry.message))).toBe(true);

    world = makeWorld();
    world.rpc.release_user_membership = { throws: true };
    expect(await run()).toEqual({ ok: true });
    expect(world.calls).toContain('auth.deleteUser');
  });

  it('すでに消えているユーザー (deleteUser が 404 user_not_found) は成功として扱う (やり直せる)', async () => {
    world.deleteUser.error = { message: 'User not found', status: 404, code: 'user_not_found' };
    expect(await run()).toEqual({ ok: true });
    const warning = logs.entries.find((entry) => entry.level === 'warn' && /already deleted/.test(entry.message));
    expect(warning).toBeDefined();
    expect(warning?.viaUser).toBe(false); // 消えたユーザーの user_id は付けられない
  });

  it('想定外の例外でも投げずに ACCOUNT_DELETE_FAILED を返す', async () => {
    const admin = makeAdmin(world);
    (admin as unknown as { from: () => never }).from = () => {
      throw new Error('unexpected');
    };
    const result = await deleteAccount({ userId: USER, admin, requestId: REQUEST_ID, logger: logs.logger });
    expect(result).toMatchObject({ ok: false, error: 'ACCOUNT_DELETE_FAILED', step: 'check_blockers' });
  });
});

describe('accountDeletionHttp / accountDeletionFailure / isAccountDeletionFailure', () => {
  it('失敗の結果は request_id と段階を持つ (調査用。HTTP の応答には route が internalError を使うので出ない)', () => {
    const failure = accountDeletionFailure('req_x', 'storage');
    expect(failure).toEqual({ ok: false, status: 500, error: 'ACCOUNT_DELETE_FAILED', request_id: 'req_x', step: 'storage' });
  });

  it('isAccountDeletionFailure は ACCOUNT_DELETE_FAILED だけを失敗とみなす (成功・409 は accountDeletionHttp へ)', () => {
    expect(isAccountDeletionFailure(accountDeletionFailure('req_x', 'prepare'))).toBe(true);
    expect(isAccountDeletionFailure({ ok: true })).toBe(false);
    expect(
      isAccountDeletionFailure({
        ok: false,
        status: 409,
        error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
        message: 'm',
        organization: { id: 'o', name: 'n' },
      }),
    ).toBe(false);
    expect(
      isAccountDeletionFailure({
        ok: false,
        status: 409,
        error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
        message: 'm',
        family_group: { id: 'f', name: 'n' },
      }),
    ).toBe(false);
  });
});
