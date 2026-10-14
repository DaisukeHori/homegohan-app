/**
 * tests/helpers/schema-checked-db.ts (スキーマを検査する簡易 PostgREST モック) 自体のテスト
 *
 * このモックは #1161 の route テストの土台なので、本物の PostgREST と同じ結果になることを先に固定する。
 * 期待値は、ローカル Supabase (本番スキーマのベースライン) に対して実際に確かめた結果:
 *   - admin_audit_logs.admin_id          -> 42703 (column ... does not exist)。操作した人の列は actor_id
 *   - planned_meals.user_id              -> 42703。持ち主は daily_meal_id -> user_daily_meals.user_id
 *   - inquiries -> user_profiles の埋め込み        -> PGRST200 (inquiries.user_id の外部キーは auth.users 宛)
 *   - admin_user_notes -> user_profiles の埋め込み -> PGRST200 (admin_id の外部キーも auth.users 宛)
 *   - planned_meals -> user_daily_meals!inner(user_id) は解決でき、'user_daily_meals.user_id' で絞り込める
 */
import { describe, expect, it } from 'vitest';
import { createSchemaDb } from './helpers/schema-checked-db';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('schema-checked-db: スキーマの検査 (本物の PostgREST と同じエラー)', () => {
  it('存在しない列で絞り込むと 42703 になる (admin_audit_logs.admin_id)', async () => {
    const db = createSchemaDb({ tables: { admin_audit_logs: [] } });

    const res = (await db.from('admin_audit_logs').select('*', { count: 'exact', head: true }).eq('admin_id', U1)) as {
      error: { code: string; message: string } | null;
    };

    expect(res.error?.code).toBe('42703');
    expect(res.error?.message).toContain('admin_audit_logs.admin_id');
  });

  it('実在する列 (actor_id) なら行が 0 件でもエラーにならず、件数は 0', async () => {
    const db = createSchemaDb({ tables: { admin_audit_logs: [] } });

    const res = (await db.from('admin_audit_logs').select('*', { count: 'exact', head: true }).eq('actor_id', U1)) as {
      error: unknown;
      count: number;
    };

    expect(res.error).toBeNull();
    expect(res.count).toBe(0);
  });

  it('planned_meals には user_id 列が無い (42703)', async () => {
    const db = createSchemaDb();

    const res = (await db.from('planned_meals').select('id').eq('user_id', U1)) as { error: { code: string } | null };

    expect(res.error?.code).toBe('42703');
  });

  it.each([
    ['inquiries', 'id, user_profiles(nickname)'],
    ['admin_user_notes', 'id, user_profiles!admin_user_notes_admin_id_fkey(nickname)'],
  ])('%s から user_profiles は埋め込めない (外部キーが auth.users 宛): PGRST200。行が 0 件でも同じ', async (table, columns) => {
    const db = createSchemaDb({ tables: { [table]: [] } });

    const res = (await db.from(table).select(columns)) as { data: unknown; error: { code: string; message: string } | null };

    expect(res.data).toBeNull();
    expect(res.error?.code).toBe('PGRST200');
    expect(res.error?.message).toContain(`'${table}' and 'user_profiles'`);
  });

  it('存在しないテーブルは PGRST205', async () => {
    const db = createSchemaDb();

    const res = (await db.from('no_such_table').select('id')) as { error: { code: string } | null };

    expect(res.error?.code).toBe('PGRST205');
  });

  it('存在しない列への insert は PGRST204', async () => {
    const db = createSchemaDb();

    const res = (await db.from('admin_audit_logs').insert({ admin_id: U1, action_type: 'x' })) as {
      error: { code: string } | null;
    };

    expect(res.error?.code).toBe('PGRST204');
    expect(db.rows('admin_audit_logs')).toHaveLength(0);
  });
});

describe('schema-checked-db: 絞り込みと埋め込み', () => {
  const tables = {
    user_daily_meals: [
      { id: 'd1', user_id: U1 },
      { id: 'd2', user_id: U2 },
    ],
    planned_meals: [
      { id: 'm1', daily_meal_id: 'd1', is_completed: true },
      { id: 'm2', daily_meal_id: 'd1', is_completed: true },
      { id: 'm3', daily_meal_id: 'd1', is_completed: false },
      { id: 'm4', daily_meal_id: 'd2', is_completed: true },
      { id: 'm5', daily_meal_id: 'd2', is_completed: true },
      { id: 'm6', daily_meal_id: 'd2', is_completed: true },
    ],
  };

  it("'user_daily_meals!inner(user_id)' + eq('user_daily_meals.user_id', …) で、そのユーザーの行だけを数える", async () => {
    const db = createSchemaDb({ tables });

    const res = (await db
      .from('planned_meals')
      .select('id, user_daily_meals!inner(user_id)', { count: 'exact', head: true })
      .eq('user_daily_meals.user_id', U1)
      .eq('is_completed', true)) as { count: number; error: unknown };

    expect(res.error).toBeNull();
    expect(res.count).toBe(2);
  });

  it('絞り込みを付け忘れると、他のユーザーの行まで数える (is_completed だけの旧実装)', async () => {
    const db = createSchemaDb({ tables });

    const res = (await db.from('planned_meals').select('*', { count: 'exact', head: true }).eq('is_completed', true)) as {
      count: number;
    };

    expect(res.count).toBe(5);
  });

  it('select に埋め込んでいない関係の絞り込みは PGRST108', async () => {
    const db = createSchemaDb({ tables });

    const res = (await db.from('planned_meals').select('id').eq('user_daily_meals.user_id', U1)) as {
      error: { code: string } | null;
    };

    expect(res.error?.code).toBe('PGRST108');
  });

  it('埋め込みの列を返す', async () => {
    const db = createSchemaDb({ tables });

    const res = (await db.from('planned_meals').select('id, user_daily_meals(user_id)').eq('id', 'm1').single()) as {
      data: { id: string; user_daily_meals: { user_id: string } };
    };

    expect(res.data).toEqual({ id: 'm1', user_daily_meals: { user_id: U1 } });
  });

  it('in / gte / not null / order / limit', async () => {
    const db = createSchemaDb({
      tables: {
        inquiries: [
          { id: 'a', status: 'pending', created_at: '2026-10-01T00:00:00Z', resolved_at: null },
          { id: 'b', status: 'resolved', created_at: '2026-10-03T00:00:00Z', resolved_at: '2026-10-04T00:00:00Z' },
          { id: 'c', status: 'resolved', created_at: '2026-10-02T00:00:00Z', resolved_at: '2026-10-02T12:00:00Z' },
        ],
      },
    });

    const inList = (await db.from('inquiries').select('id').in('status', ['pending', 'closed'])) as { data: unknown[] };
    const recent = (await db.from('inquiries').select('id').gte('resolved_at', '2026-10-03')) as { data: unknown[] };
    const resolved = (await db.from('inquiries').select('id').not('resolved_at', 'is', null)) as { data: unknown[] };
    const ordered = (await db
      .from('inquiries')
      .select('id')
      .order('created_at', { ascending: false })
      .limit(2)) as { data: unknown[] };

    expect(inList.data).toEqual([{ id: 'a' }]);
    expect(recent.data).toEqual([{ id: 'b' }]);
    expect(resolved.data).toEqual([{ id: 'b' }, { id: 'c' }]);
    expect(ordered.data).toEqual([{ id: 'b' }, { id: 'c' }]);
  });
});

describe('schema-checked-db: single / maybeSingle / insert / update / delete / エラー注入', () => {
  it('maybeSingle: 0 件は data null (エラーなし)、single: 0 件は PGRST116', async () => {
    const db = createSchemaDb({ tables: { user_profiles: [{ id: U1, nickname: 'a' }] } });

    const maybe = (await db.from('user_profiles').select('id').eq('id', U2).maybeSingle()) as {
      data: unknown;
      error: unknown;
    };
    const single = (await db.from('user_profiles').select('id').eq('id', U2).single()) as {
      error: { code: string } | null;
    };

    expect(maybe).toEqual({ data: null, error: null, count: null });
    expect(single.error?.code).toBe('PGRST116');
  });

  it('insert は行を足して、.select().single() で入れた行 (id 付き) を返す。記録も残る', async () => {
    const db = createSchemaDb();

    const res = (await db
      .from('admin_user_notes')
      .insert({ user_id: U1, admin_id: U2, note: 'メモ' })
      .select()
      .single()) as { data: { id: string; note: string } };

    expect(res.data.note).toBe('メモ');
    expect(res.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.rows('admin_user_notes')).toHaveLength(1);
    expect(db.recorded('admin_user_notes', 'insert')[0].values).toEqual({ user_id: U1, admin_id: U2, note: 'メモ' });
  });

  it('update / delete は絞り込みに合う行だけに作用する', async () => {
    const db = createSchemaDb({
      tables: {
        departments: [
          { id: 'x', name: 'A', organization_id: 'o1' },
          { id: 'y', name: 'B', organization_id: 'o2' },
        ],
      },
    });

    const updated = (await db
      .from('departments')
      .update({ name: 'A2' })
      .eq('id', 'x')
      .eq('organization_id', 'o1')
      .select('id, name')
      .maybeSingle()) as { data: unknown };
    const crossOrg = (await db
      .from('departments')
      .update({ name: 'hijack' })
      .eq('id', 'y')
      .eq('organization_id', 'o1')
      .select('id')
      .maybeSingle()) as { data: unknown };
    const deleted = (await db.from('departments').delete().eq('id', 'x').eq('organization_id', 'o1').select('id')) as {
      data: unknown[];
    };

    expect(updated.data).toEqual({ id: 'x', name: 'A2' });
    expect(crossOrg.data).toBeNull();
    expect(deleted.data).toEqual([{ id: 'x' }]);
    expect(db.rows('departments')).toEqual([{ id: 'y', name: 'B', organization_id: 'o2' }]);
  });

  it('errors を渡したテーブルは、全ての操作でそのエラーを返す', async () => {
    const db = createSchemaDb({ errors: { inquiries: { message: 'connection refused', code: '08006' } } });

    const res = (await db.from('inquiries').select('id')) as { data: unknown; error: { message: string } };

    expect(res.data).toBeNull();
    expect(res.error.message).toBe('connection refused');
  });
});
