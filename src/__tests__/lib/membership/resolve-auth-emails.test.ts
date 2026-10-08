import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LIST_USERS_DEFAULT_PER_PAGE, leadingUsers, type FakeAuthUser } from '../../api/operator/membership/fake-service-role';

// #1204 通知メールの宛先を auth.users から引く共通ヘルパー。
// auth.admin.listUsers() は page / perPage を渡さないと先頭 50 件しか返さないため、
// 必要なユーザー ID だけを getUserById で引く。

const mocks = vi.hoisted(() => ({
  getSupabaseAdmin: vi.fn(),
  createLogger: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: mocks.createLogger,
}));

import { DEFAULT_AUTH_LOOKUP_CONCURRENCY, resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';

type LookupResult = {
  data: { user: { id: string; email?: string | null } | null } | null;
  error: { message: string; status?: number } | null;
};

/** 登録ユーザーが多数いる Auth Admin API のフェイク。同時に実行中の getUserById の最大数も数える */
function createFakeAuthAdmin(
  users: FakeAuthUser[],
  behaviors: Record<string, 'reject' | 'error' | 'no-user' | 'throw-sync'> = {},
) {
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const getUserById = vi.fn((id: string): Promise<LookupResult> => {
    const behavior = behaviors[id];
    if (behavior === 'throw-sync') throw new Error('sync failure');
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    return new Promise<LookupResult>((resolve, reject) => {
      // 次のタスクまで待ち、同じ組の呼び出しが同時に実行中になるようにする
      setTimeout(() => {
        inFlight -= 1;
        if (behavior === 'reject') return reject(new Error('fetch failed'));
        if (behavior === 'error') return resolve({ data: { user: null }, error: { message: 'Database error', status: 500 } });
        if (behavior === 'no-user') return resolve({ data: { user: null }, error: null });
        const user = users.find((candidate) => candidate.id === id);
        resolve(
          user
            ? { data: { user: { ...user } }, error: null }
            : { data: { user: null }, error: { message: 'User not found', status: 404 } },
        );
      }, 0);
    });
  });
  // 本番と同じく、page / perPage を渡さない listUsers() は先頭 50 件だけを返す
  const listUsers = vi.fn(async (params?: { page?: number; perPage?: number }) => {
    const perPage = params?.perPage ?? LIST_USERS_DEFAULT_PER_PAGE;
    const page = params?.page ?? 1;
    return { data: { users: users.slice((page - 1) * perPage, page * perPage) }, error: null };
  });
  return { auth: { admin: { getUserById, listUsers } }, getUserById, listUsers, stats };
}

/** 先頭 60 件の無関係なユーザーのあとに、実際の宛先が並ぶ登録状況 */
function buildUsers(targetCount: number): FakeAuthUser[] {
  const targets = Array.from({ length: targetCount }, (_, index) => ({
    id: `aaaaaaaa-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    email: `target-${index + 1}@example.com`,
  }));
  return [...leadingUsers(60), ...targets];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLogger.mockReturnValue({ warn: mocks.logWarn });
});

describe('resolveAuthEmails: 先頭 50 件に収まらないユーザー (#1204)', () => {
  it('Auth ユーザー一覧の先頭 50 件より後ろにいる人のメールも解決できる (listUsers は使わない)', async () => {
    const users = buildUsers(70);
    const admin = createFakeAuthAdmin(users);
    // 先頭 50 件の外にいる宛先 (一覧は 60 人の無関係なユーザーから始まる)
    const [first, second, last] = [users[60], users[100], users[129]];

    const emails = await resolveAuthEmails([first.id, second.id, last.id], { admin });

    expect(emails.get(first.id)).toBe(first.email);
    expect(emails.get(second.id)).toBe(second.email);
    expect(emails.get(last.id)).toBe(last.email);
    expect(emails.size).toBe(3);
    // 必要な ID だけを引く (全体の人数に依存しない)
    expect(admin.getUserById).toHaveBeenCalledTimes(3);
    expect(admin.listUsers).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('テストの前提: listUsers() を引数なしで呼ぶと先頭 50 件しか返らず、上の宛先は一覧に載らない (旧実装の不具合)', async () => {
    const users = buildUsers(70);
    const admin = createFakeAuthAdmin(users);
    const target = users[100];

    const { data } = await admin.auth.admin.listUsers();

    expect(data.users).toHaveLength(LIST_USERS_DEFAULT_PER_PAGE);
    expect(data.users.some((user) => user.id === target.id)).toBe(false);
  });
});

describe('resolveAuthEmails: 入力の整理', () => {
  it('同じ ID は 1 回だけ引く。null / undefined / 空文字は無視する', async () => {
    const users = buildUsers(3);
    const admin = createFakeAuthAdmin(users);
    const [a, b] = [users[60], users[61]];

    const emails = await resolveAuthEmails([a.id, null, b.id, a.id, undefined, '', b.id], { admin });

    expect([...emails.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(admin.getUserById).toHaveBeenCalledTimes(2);
    expect(admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual([a.id, b.id].sort());
  });

  it('引く対象が無ければ Admin クライアントを作らず、Auth API も呼ばない', async () => {
    const emails = await resolveAuthEmails([null, undefined, '']);

    expect(emails.size).toBe(0);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('admin を渡さなければ getSupabaseAdmin() の Admin クライアントを使う', async () => {
    const users = buildUsers(1);
    const admin = createFakeAuthAdmin(users);
    mocks.getSupabaseAdmin.mockReturnValue(admin);

    const emails = await resolveAuthEmails([users[60].id]);

    expect(mocks.getSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(emails.get(users[60].id)).toBe(users[60].email);
  });

  it('admin を渡したときは getSupabaseAdmin() を呼ばない', async () => {
    const users = buildUsers(1);
    const admin = createFakeAuthAdmin(users);

    await resolveAuthEmails([users[60].id], { admin });

    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });
});

describe('resolveAuthEmails: 同時実行数の上限', () => {
  it('指定した concurrency を超えて同時に Auth API を呼ばない', async () => {
    const users = buildUsers(25);
    const admin = createFakeAuthAdmin(users);

    const emails = await resolveAuthEmails(users.slice(60).map((user) => user.id), { admin, concurrency: 4 });

    expect(emails.size).toBe(25);
    expect(admin.getUserById).toHaveBeenCalledTimes(25);
    expect(admin.stats.maxInFlight).toBeLessThanOrEqual(4);
    // 直列ではなく並列に引いている
    expect(admin.stats.maxInFlight).toBeGreaterThan(1);
  });

  it('既定の上限でも数百人を一度に Auth API へ投げない', async () => {
    const users = buildUsers(300);
    const admin = createFakeAuthAdmin(users);

    const emails = await resolveAuthEmails(users.slice(60).map((user) => user.id), { admin });

    expect(emails.size).toBe(300);
    expect(admin.stats.maxInFlight).toBeLessThanOrEqual(DEFAULT_AUTH_LOOKUP_CONCURRENCY);
    expect(admin.stats.maxInFlight).toBeGreaterThan(1);
  });

  it('concurrency に 0 を渡しても止まらず、1 件ずつ全員を解決する', async () => {
    const users = buildUsers(3);
    const admin = createFakeAuthAdmin(users);

    const emails = await resolveAuthEmails(users.slice(60).map((user) => user.id), { admin, concurrency: 0 });

    expect(emails.size).toBe(3);
    expect(admin.stats.maxInFlight).toBe(1);
  });
});

describe('resolveAuthEmails: 一部の取得に失敗したとき', () => {
  it('失敗した人を除いて残りを解決し、警告ログに件数と user_id を残す (メールアドレスは残さない)', async () => {
    const users = buildUsers(6);
    const [ok1, ok2, rejected, apiError, missing, throwsSync] = users.slice(60);
    const admin = createFakeAuthAdmin(users, {
      [rejected.id]: 'reject',
      [apiError.id]: 'error',
      [missing.id]: 'no-user',
      [throwsSync.id]: 'throw-sync',
    });

    const emails = await resolveAuthEmails(
      [ok1.id, rejected.id, ok2.id, apiError.id, missing.id, throwsSync.id],
      { admin },
    );

    expect([...emails.entries()].sort()).toEqual(
      [
        [ok1.id, ok1.email],
        [ok2.id, ok2.email],
      ].sort(),
    );
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const [message, metadata] = mocks.logWarn.mock.calls[0];
    expect(typeof message).toBe('string');
    expect(metadata).toMatchObject({ requested: 6, failed: 4 });
    expect([...metadata.failed_user_ids].sort()).toEqual(
      [rejected.id, apiError.id, missing.id, throwsSync.id].sort(),
    );
    // ログには user_id だけを残し、解決したアドレスも解決できなかった人のアドレスも含めない
    const logged = JSON.stringify(mocks.logWarn.mock.calls);
    for (const user of users) expect(logged).not.toContain(user.email);
    expect(logged).not.toContain('@');
  });

  it('全員の取得に失敗しても例外にせず、空の結果を返して警告ログに残す', async () => {
    const users = buildUsers(3);
    const targets = users.slice(60);
    const admin = createFakeAuthAdmin(
      users,
      Object.fromEntries(targets.map((user) => [user.id, 'reject' as const])),
    );

    const emails = await resolveAuthEmails(targets.map((user) => user.id), { admin });

    expect(emails.size).toBe(0);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 3, failed: 3 });
  });

  it('メールアドレスを持たないユーザー (電話番号のみなど) は失敗扱いにせず、結果にも入れない', async () => {
    const withEmail = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'has-email@example.com' };
    const phoneOnly = { id: 'aaaaaaaa-0000-4000-8000-000000000002', email: null };
    const emptyEmail = { id: 'aaaaaaaa-0000-4000-8000-000000000003', email: '' };
    const admin = createFakeAuthAdmin([withEmail, phoneOnly, emptyEmail]);

    const emails = await resolveAuthEmails([withEmail.id, phoneOnly.id, emptyEmail.id], { admin });

    expect([...emails.keys()]).toEqual([withEmail.id]);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('警告ログに残す user_id は上限件数まで (大量に失敗しても 1 行のログに収まる)', async () => {
    const users = buildUsers(40);
    const targets = users.slice(60);
    const admin = createFakeAuthAdmin(
      users,
      Object.fromEntries(targets.map((user) => [user.id, 'reject' as const])),
    );

    await resolveAuthEmails(targets.map((user) => user.id), { admin });

    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const metadata = mocks.logWarn.mock.calls[0][1];
    expect(metadata.failed).toBe(40);
    expect(metadata.failed_user_ids.length).toBeLessThanOrEqual(10);
  });

  it('Admin クライアントを作れない (service-role の環境変数が無い) ときも例外にせず、空の結果を返して警告ログに残す', async () => {
    mocks.getSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];

    const emails = await resolveAuthEmails(ids);

    expect(emails.size).toBe(0);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 2, failed: 2 });
  });

  it('logger を渡したときはそのロガーに警告を出す (呼び出し元の route / 操作者を引き継げる)', async () => {
    const users = buildUsers(1);
    const target = users[60];
    const admin = createFakeAuthAdmin(users, { [target.id]: 'reject' });
    const routeWarn = vi.fn();

    await resolveAuthEmails([target.id], { admin, logger: { warn: routeWarn } });

    expect(routeWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });
});
