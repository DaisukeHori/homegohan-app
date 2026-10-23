/**
 * PATCH /api/super-admin/plans/[id] の同時の変更 (#1917 の範囲の外として 10/23 の整合で挙がった候補 (a))
 *
 * 遷移の可否・status ごとに変えてよい項目・廃止の ends_at の要否は、直前に読んだ status (と ends_at) で決める。
 * 更新はその値のままのときだけ書く条件つき。読んでから書くまでに別の運営が変えていたら 0 行で、
 *   - 読み直した行に送った変更がもう入っていれば 200 (書かず、監査も残さない)
 *   - 入っていなければ 409 CONFLICT_STALE_DATA (書かず、監査も残さない)
 *   - 行が消えていれば 404 OP_PLAN_NOT_FOUND
 * 遷移表に無い遷移 (deprecated → public など) は書かれず、監査の status_from は書いた時点の実際の直前の status と一致する。
 *
 * 別の運営の操作は、route が subscription_plans の更新を DB に送る直前に割り込ませて再現する
 * (schema-checked-db は route が付けた .eq / .not の条件を実際に当てるので、条件の付け忘れは 200 と書き込みで見える)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type Row, type SchemaDb } from './helpers/schema-checked-db';
import { createFakePlanSubscribersDb } from './helpers/fake-plan-subscribers-db';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: () => ({ error: vi.fn() }) }),
  generateRequestId: () => 'req_test',
}));

/** 運営 (super_admin) のセッションの client が見る DB (プランと監査ログ) */
let db: SchemaDb;

/** 読んでから書くまでの間に割り込む処理 (別の運営の操作)。route が subscription_plans の更新を送る直前に 1 回だけ実行する */
let beforePlanUpdate: (() => PromiseLike<unknown>) | null = null;

function interleavingFrom(table: string) {
  const query = db.from(table);
  if (table !== 'subscription_plans') return query;
  let isUpdate = false;
  const update = query.update.bind(query);
  query.update = (values) => {
    isUpdate = true;
    return update(values);
  };
  type Result = Awaited<ReturnType<typeof query.single>>;
  const wrap = (terminal: () => Promise<Result>) => async (): Promise<Result> => {
    if (isUpdate && beforePlanUpdate) {
      const interleave = beforePlanUpdate;
      beforePlanUpdate = null;
      await interleave();
    }
    return terminal();
  };
  query.single = wrap(query.single.bind(query));
  query.maybeSingle = wrap(query.maybeSingle.bind(query));
  return query;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ from: interleavingFrom }),
  // 廃止の安全弁 (#1127) は契約者のいない DB で通す (契約者がいるときは tests/plan-deprecate-subscribers-route.test.ts)
  getSupabaseAdmin: () => createFakePlanSubscribersDb().client,
}));

const { PATCH } = await import('@/app/api/super-admin/plans/[id]/route');

const PLAN_ID = '00000000-0000-4000-8000-000000000101';
const ACTOR = { id: '00000000-0000-4000-8000-000000000001', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };
const ENDS_AT = '2027-01-01T00:00:00.000Z';

function planRow(overrides: Row = {}): Row {
  return {
    id: PLAN_ID,
    plan_key: 'pro_cas_test',
    display_name: 'Pro',
    plan_type: 'personal',
    description: null,
    status: 'public',
    ends_at: null,
    feature_packages: [],
    display_order: 0,
    max_members: null,
    trial_days: 0,
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function setup(plan: Row) {
  db = createSchemaDb({ tables: { subscription_plans: [plan], admin_audit_logs: [] } });
}

/** 別の運営が、このプランの行を直接書き換える */
function otherOperatorUpdates(values: Row) {
  return () => db.from('subscription_plans').update(values).eq('id', PLAN_ID);
}

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost/api/super-admin/plans/${PLAN_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: PLAN_ID }) },
  );
}

const planNow = () => db.rows('subscription_plans').find((row) => row.id === PLAN_ID);
const auditRows = () => db.rows('admin_audit_logs');
const json = (res: Response) => res.json() as Promise<Record<string, any>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ACTOR);
  beforePlanUpdate = null;
});

describe('割り込みが無いとき', () => {
  it('public → private は 200 で書き、監査 update_plan の status_from / status_to は書いた時点の直前の値と送った値', async () => {
    setup(planRow({ status: 'public' }));
    const res = await patch({ status: 'private' });
    expect(res.status).toBe(200);
    expect(planNow()?.status).toBe('private');
    const audits = auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].action_type).toBe('update_plan');
    expect(audits[0].details).toMatchObject({ status_from: 'public', status_to: 'private', changes: { status: 'private' } });
  });

  it('更新は読んだ status を条件にする (送った項目が status 以外でも)', async () => {
    setup(planRow({ status: 'public' }));
    const res = await patch({ display_name: '新しい名前' });
    expect(res.status).toBe(200);
    const update = db.recorded('subscription_plans', 'update');
    expect(update).toHaveLength(1);
    expect(update[0].eq).toEqual([
      ['id', PLAN_ID],
      ['status', 'public'],
    ]);
    // status を変えない更新は status_from を書かない
    expect(auditRows()[0].details).not.toHaveProperty('status_from');
  });

  it('廃止で ends_at を既存の値に頼るときは 200 で書く (既存の ends_at が残っている)', async () => {
    setup(planRow({ status: 'private', ends_at: ENDS_AT }));
    const res = await patch({ status: 'deprecated' });
    expect(res.status).toBe(200);
    expect(planNow()).toMatchObject({ status: 'deprecated', ends_at: ENDS_AT });
    expect(auditRows()[0].details).toMatchObject({ status_from: 'private', status_to: 'deprecated' });
  });

  it('廃止で本文に ends_at: null を送ると、既存の ends_at があっても 400 (書いた後に廃止予定日が無くなるため。書かない)', async () => {
    setup(planRow({ status: 'public', ends_at: ENDS_AT }));
    const res = await patch({ status: 'deprecated', ends_at: null });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('OP_PLAN_DEPRECATE_ENDS_AT_REQUIRED');
    expect(planNow()).toMatchObject({ status: 'public', ends_at: ENDS_AT });
    expect(db.recorded('subscription_plans', 'update')).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });
});

describe('読んでから書くまでに別の運営が変えた', () => {
  it('private → public の間に別の運営が deprecated にした: 409 CONFLICT_STALE_DATA。deprecated → public は書かれず、監査も残らない', async () => {
    setup(planRow({ status: 'private', ends_at: ENDS_AT }));
    beforePlanUpdate = otherOperatorUpdates({ status: 'deprecated' });
    const res = await patch({ status: 'public' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('CONFLICT_STALE_DATA');
    expect(planNow()?.status).toBe('deprecated');
    expect(auditRows()).toHaveLength(0);
  });

  it('別の運営が同じ遷移を先に入れていた: 200 で今の行を返し、書かず監査も残さない (status_from が古い値で残らない)', async () => {
    setup(planRow({ status: 'private' }));
    beforePlanUpdate = otherOperatorUpdates({ status: 'public', updated_at: '2026-10-23T00:00:00Z' });
    const res = await patch({ status: 'public' });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id: PLAN_ID, status: 'public', updated_at: '2026-10-23T00:00:00Z' });
    expect(planNow()?.updated_at).toBe('2026-10-23T00:00:00Z');
    expect(auditRows()).toHaveLength(0);
  });

  it('同じ廃止を先に入れていた (ends_at の書式が違っても同じ時刻): 200 で書かず、監査も残さない', async () => {
    setup(planRow({ status: 'public' }));
    beforePlanUpdate = otherOperatorUpdates({ status: 'deprecated', ends_at: '2027-01-01T00:00:00+00:00' });
    const res = await patch({ status: 'deprecated', ends_at: ENDS_AT });
    expect(res.status).toBe(200);
    expect(planNow()?.ends_at).toBe('2027-01-01T00:00:00+00:00');
    expect(auditRows()).toHaveLength(0);
  });

  it('別の運営が同じ status へ変えたが、送ったほかの項目が入っていない: 409 (送った変更を黙って捨てない)', async () => {
    setup(planRow({ status: 'private', display_name: 'Pro' }));
    beforePlanUpdate = otherOperatorUpdates({ status: 'public' });
    const res = await patch({ status: 'public', display_name: '新しい名前' });
    expect(res.status).toBe(409);
    expect(planNow()?.display_name).toBe('Pro');
    expect(auditRows()).toHaveLength(0);
  });

  it('下書きにだけ許す項目 (max_members) の更新の間に別の運営が公開した: 409。公開中のプランに書かれない', async () => {
    setup(planRow({ status: 'draft', max_members: null }));
    beforePlanUpdate = otherOperatorUpdates({ status: 'public' });
    const res = await patch({ max_members: 5 });
    expect(res.status).toBe(409);
    expect(planNow()).toMatchObject({ status: 'public', max_members: null });
    expect(auditRows()).toHaveLength(0);
  });

  it('廃止で既存の ends_at に頼った間に別の運営が ends_at を消した: 409。廃止予定日の無い廃止は書かれない', async () => {
    setup(planRow({ status: 'public', ends_at: ENDS_AT }));
    beforePlanUpdate = otherOperatorUpdates({ ends_at: null });
    const res = await patch({ status: 'deprecated' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('CONFLICT_STALE_DATA');
    expect(planNow()).toMatchObject({ status: 'public', ends_at: null });
    expect(auditRows()).toHaveLength(0);
  });

  it('別の運営がプランを消した: 404 OP_PLAN_NOT_FOUND で、監査も残さない', async () => {
    setup(planRow({ status: 'draft' }));
    beforePlanUpdate = () => db.from('subscription_plans').delete().eq('id', PLAN_ID);
    const res = await patch({ display_name: '新しい名前' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('OP_PLAN_NOT_FOUND');
    expect(auditRows()).toHaveLength(0);
  });
});
