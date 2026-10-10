// @vitest-environment node
/**
 * src/__tests__/lib/super-admin/flag-active-users.test.ts
 *
 * #1148 機能フラグごとの対象ユーザー数 (active_user_count) の算出。
 * route 経由の確認は tests/super-admin-flags-route.test.ts。ここでは算出そのものの境界を確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_USER_COUNT_SCAN_LIMIT,
  countActiveUsersForFlags,
} from '@/lib/super-admin/flag-active-users';
import type { FeatureFlagRecord } from '@/lib/super-admin/evaluate-flag';

type UserRow = {
  id: string;
  roles: string[] | null;
  organization_id: string | null;
  plan_key_cached: string | null;
  created_at: string | null;
};

function userRows(count: number, overrides: (i: number) => Partial<UserRow> = () => ({})): UserRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `user-${String(i).padStart(6, '0')}`,
    roles: ['user'],
    organization_id: null,
    plan_key_cached: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides(i),
  }));
}

/** user_profiles の select のあとに呼ばれる部分 (並べ替えと、ページ送り) */
interface FakeQuery {
  order: () => FakeQuery;
  range: (from: number, to: number) => Promise<{ data: UserRow[] | null; error: { message: string; code?: string } | null }>;
}

/** 件数 (head) と、ページ送り (range) を再現する reader */
function makeReader(
  users: UserRow[],
  options: { countError?: { message: string; code?: string }; pageError?: { message: string; code?: string }; grow?: UserRow[] } = {},
) {
  const rangeCalls: Array<[number, number]> = [];
  const select = vi.fn((_columns: string, selectOptions?: { head?: boolean }) => {
    if (selectOptions?.head) {
      return Promise.resolve(
        options.countError ? { count: null, error: options.countError } : { count: users.length, error: null },
      );
    }
    const builder: FakeQuery = {
      order: () => builder,
      range: async (from: number, to: number) => {
        rangeCalls.push([from, to]);
        if (options.pageError) return { data: null, error: options.pageError };
        // 件数を数えたあとに増えたユーザーを、読み込みのときに返す
        const source = options.grow ?? users;
        return { data: source.slice(from, to + 1), error: null };
      },
    };
    return builder;
  });
  // 作り物の Supabase は、countActiveUsersForFlags が使う from → select → order → range だけを持つ
  const reader = { from: vi.fn((_table: string) => ({ select })) } as unknown as Parameters<typeof countActiveUsersForFlags>[0];
  return { reader, select, rangeCalls };
}

function flag(key: string, overrides: Partial<FeatureFlagRecord> = {}): FeatureFlagRecord {
  return { key, enabled: true, rollout_strategy: null, constraints: null, ...overrides };
}

describe('countActiveUsersForFlags', () => {
  it('条件の無い constraints ({} や空配列) は「条件なし」として、総数をそのまま返す (ユーザーの列は読まない)', async () => {
    const { reader, select } = makeReader(userRows(7));

    const counts = await countActiveUsersForFlags(reader, [
      flag('a', { constraints: {} }),
      flag('b', { constraints: { exclude_plans: [], include_roles: [] } }),
      flag('c', { rollout_strategy: { type: 'all' } }),
    ]);

    expect([...counts.entries()]).toEqual([
      ['a', 7],
      ['b', 7],
      ['c', 7],
    ]);
    expect(select).toHaveBeenCalledTimes(1); // 件数だけ
  });

  it('総数が 0 でも失敗しない', async () => {
    const { reader } = makeReader([]);
    const counts = await countActiveUsersForFlags(reader, [flag('a'), flag('b', { rollout_strategy: { type: 'role', roles: ['admin'] } })]);
    expect(counts.get('a')).toBe(0);
    expect(counts.get('b')).toBe(0);
  });

  it('ちょうど上限のユーザー数までは 1 人ずつ数える。1 人超えると null', async () => {
    const roleFlag = flag('staff', { rollout_strategy: { type: 'role', roles: ['admin'] } });

    const atLimit = makeReader(userRows(ACTIVE_USER_COUNT_SCAN_LIMIT, (i) => ({ roles: i === 0 ? ['admin'] : ['user'] })));
    expect((await countActiveUsersForFlags(atLimit.reader, [roleFlag])).get('staff')).toBe(1);

    const overLimit = makeReader(userRows(ACTIVE_USER_COUNT_SCAN_LIMIT + 1));
    const counts = await countActiveUsersForFlags(overLimit.reader, [roleFlag, flag('everyone')]);
    expect(counts.get('staff')).toBeNull();
    expect(counts.get('everyone')).toBe(ACTIVE_USER_COUNT_SCAN_LIMIT + 1);
    expect(overLimit.rangeCalls).toEqual([]); // 読み込みに行かない
  });

  it('件数を数えたあとに上限を超えるほど増えたときは、読み込みを打ち切って null', async () => {
    const counted = userRows(ACTIVE_USER_COUNT_SCAN_LIMIT - 10);
    const grown = userRows(ACTIVE_USER_COUNT_SCAN_LIMIT + 2_000);
    const { reader } = makeReader(counted, { grow: grown });

    const counts = await countActiveUsersForFlags(reader, [
      flag('staff', { rollout_strategy: { type: 'role', roles: ['admin'] } }),
    ]);

    expect(counts.get('staff')).toBeNull();
  });

  it('ページは 1000 件ずつ、id 順に読む', async () => {
    const { reader, rangeCalls } = makeReader(userRows(2_001));

    await countActiveUsersForFlags(reader, [flag('staff', { rollout_strategy: { type: 'role', roles: ['admin'] } })]);

    expect(rangeCalls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('ちょうど 1000 件のときは、空のページを 1 回読んで終わる', async () => {
    const { reader, rangeCalls } = makeReader(userRows(1_000));
    await countActiveUsersForFlags(reader, [flag('staff', { rollout_strategy: { type: 'role', roles: ['admin'] } })]);
    expect(rangeCalls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('roles が null のユーザーは、ロールなしとして数える (落ちない)', async () => {
    const { reader } = makeReader(userRows(3, (i) => ({ roles: i === 0 ? null : ['admin'] })));
    const counts = await countActiveUsersForFlags(reader, [flag('staff', { rollout_strategy: { type: 'role', roles: ['admin'] } })]);
    expect(counts.get('staff')).toBe(2);
  });

  it('件数の取得に失敗したら例外 (メッセージとコードを含む)', async () => {
    const { reader } = makeReader(userRows(3), { countError: { message: 'permission denied', code: '42501' } });
    await expect(countActiveUsersForFlags(reader, [flag('a')])).rejects.toThrow(/permission denied.*42501/);
  });

  it('ページの取得に失敗したら例外', async () => {
    const { reader } = makeReader(userRows(3), { pageError: { message: 'timeout', code: '57014' } });
    await expect(
      countActiveUsersForFlags(reader, [flag('a', { rollout_strategy: { type: 'role', roles: ['admin'] } })]),
    ).rejects.toThrow(/timeout.*57014/);
  });

  it('ON のフラグが無ければ、何も読まない', async () => {
    const { reader, select } = makeReader(userRows(3));
    const counts = await countActiveUsersForFlags(reader, [flag('a', { enabled: false })]);
    expect(counts.get('a')).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });
});
