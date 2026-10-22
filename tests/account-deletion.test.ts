/**
 * アカウント削除の本体 (src/lib/account-deletion.ts, #1175) の単体テスト
 *
 * Supabase はメモリ上の偽物。実物 (DB・Auth・Storage) での確認は tests/integration/security/account-deletion.test.ts。
 *
 * 確認すること:
 *   - 組織のオーナー / 家族の代表者は、従来と同じ 409 の形で止まり、何も呼ばない
 *   - 順序: 確認 → prepare_account_deletion → release_user_membership → Storage → 削除の実行記録を始める
 *     (begin_account_deletion_record) → auth.admin.deleteUser → 記録に済んだ印 (complete_account_deletion_record) (#1562)
 *   - 削除の実行記録: 本人の退会は executor 'self' / 理由 'user_request'、運営の削除は 'operator' と運営者の id。
 *     記録を始められなければ削除しない。済んだ印の失敗は退会の結果を変えない (アカウントはもう消えている)
 *   - 失敗の扱い: prepare / Storage / deleteUser の失敗はそこで止めて ACCOUNT_DELETE_FAILED (deleteUser より前なら deleteUser を呼ばない)。
 *     ライセンス解放 (release_user_membership) の失敗だけは続ける。ただし、確認のあとにオーナーになったので DB 関数が所属を外さずに
 *     IS_ORG_OWNER で止めたときは確認をやり直して 409、所属の組織が途中で変わって CONFLICT_RETRY で止めたときは削除しない
 *     (supabase/migrations/20261022160000_release_membership_owner_race.sql)
 *   - 失敗の結果に、DB・Storage の生のエラー文を入れない。request_id と段階を持つ (HTTP の応答は route が #1172 の internalError で返す)
 *   - すでに消えているユーザーの deleteUser (404) は成功として扱う (やり直せる)
 *   - ログにメールアドレスを載せない。削除後のログに user_id を付けない
 *   - billing/01 §11: 段階 billing (check_blockers のあと・prepare の前) と billing_recheck (記録を始めたあと・deleteUser の直前)。
 *     どちらの失敗もそこで止める。顧客も Stripe の契約の行も無ければ、既定の実装は Stripe を呼ばない
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 既定の退会の段階 billing (src/lib/billing/account-deletion.ts) が使う DB と Stripe を偽物にする (テスト 43)。
// ほかの it は deleteAccount に偽の billing を渡すので、これには届かない
const { mockFindCustomer, mockListStripeBackedSubscriptions, mockCreateStripeGateway } = vi.hoisted(() => ({
  mockFindCustomer: vi.fn(),
  mockListStripeBackedSubscriptions: vi.fn(),
  mockCreateStripeGateway: vi.fn(() => {
    throw new Error('createStripeGateway must not be called');
  }),
}));
vi.mock('@/lib/billing/repository', () => ({
  createBillingRepository: () => ({
    findCustomer: mockFindCustomer,
    listStripeBackedSubscriptions: mockListStripeBackedSubscriptions,
  }),
}));
vi.mock('@/lib/billing/stripe-gateway', () => ({ createStripeGateway: mockCreateStripeGateway }));
import {
  accountDeletionFailure,
  accountDeletionHttp,
  isAccountDeletionFailure,
  deleteAccount,
  type DeleteAccountResult,
  type AccountDeletionAdmin,
  type AccountDeletionLogger,
  type AccountDeletionBilling,
  type AccountDeletionBillingPhase,
} from '../src/lib/account-deletion';

const USER = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = 'req_test_1';
const RECORD_ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
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
  /** rpc に渡された引数 (名前ごとの最後の呼び出し) */
  rpcArgs: Record<string, unknown>;
  /** storage.list / remove の挙動 */
  storage: { listError?: { message: string } | null; entries?: Array<{ name: string; id: string | null }>; removeError?: { message: string } | null };
  deleteUser: { error?: { message: string; status?: number; code?: string } | null };
  /** 退会の段階 billing / billing_recheck (billing/01 §11) で投げるもの */
  billingThrows?: Partial<Record<AccountDeletionBillingPhase, Error>>;
  /** rpc(name) が返したあとに世界を変える (同時に走った処理の代わり。例: 所属の解放の前にオーナーになっていた) */
  afterRpc?: Record<string, (target: World) => void>;
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    calls: [],
    tables: { organizations: { data: [] }, family_groups: { data: [] } },
    rpc: {
      prepare_account_deletion: { data: { email_delivery_logs: 1 } },
      release_user_membership: { data: null },
      begin_account_deletion_record: { data: RECORD_ID },
      complete_account_deletion_record: { data: null },
    },
    rpcArgs: {},
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
    rpc: async (name: string, args?: unknown) => {
      world.calls.push(`rpc:${name}`);
      world.rpcArgs[name] = args;
      const entry = world.rpc[name] ?? { data: null };
      world.afterRpc?.[name]?.(world);
      if (entry.throws) throw new Error('network down');
      return { data: entry.data ?? null, error: entry.error ?? null };
    },
    storage,
    auth: {
      admin: {
        // 退会の完了メール (#1152) の宛先。メールの送り分けは tests/account-deletion-email.test.ts で確かめるので、
        // ここではアドレスを持たないユーザーにして送らない (呼び出しの順番 world.calls にも載せない)
        getUserById: async () => ({ data: { user: { id: USER, email: null } }, error: null }),
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

/** 偽の退会の段階 billing。呼ばれた phase を world.calls に "billing:<phase>" で残す */
function makeBilling(target: World): AccountDeletionBilling {
  return {
    cancelForAccountDeletion: async (userId, _log, phase) => {
      target.calls.push(`billing:${phase}`);
      expect(userId).toBe(USER);
      const error = target.billingThrows?.[phase];
      if (error) throw error;
      return { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' };
    },
  };
}

const run = (extra: Record<string, unknown> = {}) =>
  deleteAccount({ userId: USER, admin: makeAdmin(world), requestId: REQUEST_ID, logger: logs.logger, billing: makeBilling(world), ...extra });

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
  it('確認 → prepare → ライセンス解放 → Storage → 記録を始める → deleteUser → 記録に済んだ印 の順に呼ぶ', async () => {
    world.storage.entries = [{ name: 'a.png', id: 'obj-1' }];
    const result = await run();

    expect(result).toEqual({ ok: true });
    const order = world.calls.filter((call) => !call.startsWith('storage.list'));
    expect(order.slice(0, 5)).toEqual([
      'from:organizations',
      'from:family_groups',
      'billing:billing',
      'rpc:prepare_account_deletion',
      'rpc:release_user_membership',
    ]);
    expect(world.calls.indexOf('storage.remove:fridge-images')).toBeGreaterThan(world.calls.indexOf('rpc:release_user_membership'));
    expect(world.calls.slice(-4)).toEqual([
      'rpc:begin_account_deletion_record',
      'billing:billing_recheck',
      'auth.deleteUser',
      'rpc:complete_account_deletion_record',
    ]);
    expect(world.calls.indexOf('rpc:begin_account_deletion_record')).toBeGreaterThan(world.calls.indexOf('storage.remove:fridge-images'));
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

describe('deleteAccount: 削除の実行記録 (#1562)', () => {
  it('本人の退会: executor は self、理由は user_request、運営者は無し、request_id を渡す。済んだ印は始めた記録の id で入れる', async () => {
    expect(await run()).toEqual({ ok: true });
    expect(world.rpcArgs.begin_account_deletion_record).toEqual({
      p_user_id: USER,
      p_executor_type: 'self',
      p_reason: 'user_request',
      p_request_id: REQUEST_ID,
      p_operator_id: null,
    });
    expect(world.rpcArgs.complete_account_deletion_record).toEqual({ p_record_id: RECORD_ID });
  });

  it('運営の削除: executor は operator、理由は operator_action、運営者の id を渡す', async () => {
    expect(await run({ executor: { type: 'operator', operatorId: OPERATOR } })).toEqual({ ok: true });
    expect(world.rpcArgs.begin_account_deletion_record).toEqual({
      p_user_id: USER,
      p_executor_type: 'operator',
      p_reason: 'operator_action',
      p_request_id: REQUEST_ID,
      p_operator_id: OPERATOR,
    });
  });

  it('記録を始められなければ削除しない (step: record)。生のエラー文は結果に入れない', async () => {
    world.rpc.begin_account_deletion_record = { error: { message: SECRET_DB_MESSAGE, code: 'P0001' } };
    const result = await run();
    expect(result).toEqual(accountDeletionFailure(REQUEST_ID, 'record'));
    expect(world.calls).not.toContain('auth.deleteUser');
    expect(world.calls).not.toContain('rpc:complete_account_deletion_record');
    expect(JSON.stringify(result)).not.toContain('secret_constraint');
    const failure = logs.entries.find((entry) => entry.level === 'error');
    expect(failure?.metadata).toMatchObject({ step: 'record', request_id: REQUEST_ID, error_code: 'P0001' });
  });

  it('記録の id が返らなければ削除しない (step: record)', async () => {
    world.rpc.begin_account_deletion_record = { data: null };
    expect(await run()).toEqual(accountDeletionFailure(REQUEST_ID, 'record'));
    expect(world.calls).not.toContain('auth.deleteUser');
  });

  it('済んだ印の失敗 (エラーでも例外でも) は退会の結果を変えない。ログには記録の id を残し、user_id は付けない', async () => {
    world.rpc.complete_account_deletion_record = { error: { message: 'boom', code: '40001' } };
    expect(await run()).toEqual({ ok: true });
    const failure = logs.entries.find((entry) => entry.level === 'error');
    expect(failure?.message).toMatch(/complete_account_deletion_record failed/);
    expect(failure?.viaUser).toBe(false);
    expect(failure?.metadata).toMatchObject({ step: 'record', request_id: REQUEST_ID, deletion_record_id: RECORD_ID, error_code: '40001' });
    expect(JSON.stringify(failure?.metadata)).not.toContain(USER);

    world = makeWorld();
    logs = makeLogger();
    world.rpc.complete_account_deletion_record = { throws: true };
    expect(await run()).toEqual({ ok: true });
    expect(logs.entries.some((entry) => entry.level === 'error' && /complete_account_deletion_record failed/.test(entry.message))).toBe(true);
  });

  it('すでに消えていたユーザー (404) でも、記録に済んだ印を入れる (やり直しで記録を閉じる)', async () => {
    world.deleteUser.error = { message: 'User not found', status: 404, code: 'user_not_found' };
    expect(await run()).toEqual({ ok: true });
    expect(world.rpcArgs.complete_account_deletion_record).toEqual({ p_record_id: RECORD_ID });
  });

  it('deleteUser が失敗したら済んだ印を入れない (記録は executed_at が空のまま。やり直しで使い直す)', async () => {
    world.deleteUser.error = { message: SECRET_DB_MESSAGE, status: 500, code: 'unexpected_failure' };
    expect(await run()).toMatchObject({ ok: false, step: 'delete_user' });
    expect(world.calls).toContain('rpc:begin_account_deletion_record');
    expect(world.calls).not.toContain('rpc:complete_account_deletion_record');
  });

  it('成功のログに記録の id を載せる (user_id は載せない)', async () => {
    await run();
    const info = logs.entries.find((entry) => entry.message === 'account deleted');
    expect(info?.metadata).toMatchObject({ deletion_record_id: RECORD_ID });
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

  it('確認のあとにオーナーになっていた (release_user_membership が P0001 IS_ORG_OWNER): 確認をやり直して従来と同じ 409。Storage・記録・deleteUser は呼ばない', async () => {
    world.rpc.release_user_membership = { error: { message: 'IS_ORG_OWNER', code: 'P0001' } };
    // 確認 (1 回目) のあと、所属の解放までの間に譲渡の承諾が commit した
    world.afterRpc = {
      prepare_account_deletion: (target) => {
        target.tables.organizations = { data: [{ id: 'org-2', name: '譲渡された組織' }] };
      },
    };
    const result = await run();

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
      message: '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。',
      organization: { id: 'org-2', name: '譲渡された組織' },
    });
    expect(world.calls).toEqual([
      'from:organizations',
      'from:family_groups',
      'billing:billing',
      'rpc:prepare_account_deletion',
      'rpc:release_user_membership',
      'from:organizations',
    ]);
    expect(httpOf(result).status).toBe(409);
  });

  it('IS_ORG_OWNER のあと確認をやり直してもオーナーでなければ (同時の譲渡がもう一度あった)、消さずに ACCOUNT_DELETE_FAILED (step: release_membership)', async () => {
    world.rpc.release_user_membership = { error: { message: 'IS_ORG_OWNER', code: 'P0001' } };
    const result = await run();

    expect(result).toEqual(accountDeletionFailure(REQUEST_ID, 'release_membership'));
    expect(world.calls).not.toContain('auth.deleteUser');
    expect(world.calls).not.toContain('rpc:begin_account_deletion_record');
    expect(world.calls.filter((call) => call === 'from:organizations')).toHaveLength(2);
  });

  it('所属の組織が途中で変わった (release_user_membership が P0001 CONFLICT_RETRY): 席を残したまま消さず ACCOUNT_DELETE_FAILED (step: release_membership)', async () => {
    world.rpc.release_user_membership = { error: { message: 'CONFLICT_RETRY', code: 'P0001' } };
    const result = await run();

    expect(result).toEqual(accountDeletionFailure(REQUEST_ID, 'release_membership'));
    expect(world.calls).not.toContain('auth.deleteUser');
    expect(world.calls.some((call) => call.startsWith('storage.'))).toBe(false);
    const failure = logs.entries.find((entry) => entry.level === 'error');
    expect(failure?.metadata).toMatchObject({ step: 'release_membership', error_code: 'P0001' });
  });

  it('コードの文字列が同じでも P0001 でなければ (DB 関数が RAISE したものでなければ)、従来どおりライセンス解放の失敗として続ける', async () => {
    world.rpc.release_user_membership = { error: { message: 'IS_ORG_OWNER', code: 'XX000' } };
    expect(await run()).toEqual({ ok: true });
    expect(world.calls).toContain('auth.deleteUser');
    expect(world.calls.filter((call) => call === 'from:organizations')).toHaveLength(1);
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

describe('deleteAccount: 退会の段階 billing / billing_recheck (billing/01 §11)', () => {
  it('runs the billing step after check_blockers and before prepare, and the billing_recheck step after storage and right before deleteUser; a failure in billing stops with step billing without prepare/deleteUser, and a failure in billing_recheck stops with step billing_recheck without deleteUser', async () => {
    world.storage.entries = [{ name: 'a.png', id: 'obj-1' }];
    expect(await run()).toEqual({ ok: true });
    const billingCalls = world.calls.filter((call) => call.startsWith('billing:'));
    expect(billingCalls).toEqual(['billing:billing', 'billing:billing_recheck']);
    const at = (call: string) => world.calls.indexOf(call);
    expect(at('billing:billing')).toBeGreaterThan(at('from:family_groups'));
    expect(at('billing:billing')).toBeLessThan(at('rpc:prepare_account_deletion'));
    expect(at('billing:billing_recheck')).toBeGreaterThan(at('storage.remove:fridge-images'));
    expect(at('auth.deleteUser')).toBe(at('billing:billing_recheck') + 1);
    // 成功のログに 2 つの段階の結果が載る
    const info = logs.entries.find((entry) => entry.message === 'account deleted');
    expect(info?.metadata).toMatchObject({
      billing: { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' },
      billing_recheck: { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' },
    });

    // 段階 billing の失敗: prepare にも deleteUser にも進まない
    world = makeWorld({ billingThrows: { billing: new Error(SECRET_DB_MESSAGE) } });
    const first = await run();
    expect(first).toEqual(accountDeletionFailure(REQUEST_ID, 'billing'));
    expect(world.calls).not.toContain('rpc:prepare_account_deletion');
    expect(world.calls).not.toContain('auth.deleteUser');
    expect(JSON.stringify(first)).not.toContain('secret_constraint');

    // 段階 billing_recheck の失敗: deleteUser に進まない (記録は始めたまま。やり直しで使い直す)
    world = makeWorld({ billingThrows: { billing_recheck: new Error(SECRET_DB_MESSAGE) } });
    const second = await run();
    expect(second).toEqual(accountDeletionFailure(REQUEST_ID, 'billing_recheck'));
    expect(world.calls).toContain('rpc:prepare_account_deletion');
    expect(world.calls).toContain('rpc:begin_account_deletion_record');
    expect(world.calls).not.toContain('auth.deleteUser');
    expect(world.calls).not.toContain('rpc:complete_account_deletion_record');
  });

  it('skips Stripe in both billing passes when the user has neither a billing customer nor a stripe-backed row', async () => {
    mockFindCustomer.mockResolvedValue(null);
    mockListStripeBackedSubscriptions.mockResolvedValue([]);
    mockCreateStripeGateway.mockClear();
    // billing を渡さない = 既定の defaultAccountDeletionBilling
    const result = await deleteAccount({ userId: USER, admin: makeAdmin(world), requestId: REQUEST_ID, logger: logs.logger });

    expect(result).toEqual({ ok: true });
    expect(mockFindCustomer).toHaveBeenCalledTimes(2);
    expect(mockFindCustomer).toHaveBeenCalledWith(USER);
    expect(mockListStripeBackedSubscriptions).toHaveBeenCalledTimes(2);
    expect(mockCreateStripeGateway).not.toHaveBeenCalled();
    expect(world.calls).toContain('auth.deleteUser');
    const info = logs.entries.find((entry) => entry.message === 'account deleted');
    expect(info?.metadata).toMatchObject({
      billing: { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' },
      billing_recheck: { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' },
    });
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
