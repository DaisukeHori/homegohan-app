/**
 * #2059 Q1: PATCH /api/super-admin/experiments/[id] の状態の遷移の検査
 *
 * 以前の route は、今の status を読まずに .update(本文).eq('id', id) を実行し、毎回監査ログを残していた。
 * そのため、同じ状態への変更 (running → running)・終わった実験の再開 (completed / cancelled → running)・
 * 下書きへの戻し (running → draft) が 200 で通り、二度押し・2 つのタブでは監査ログが二重に残った。
 *
 * 直したあとの不変条件:
 *  - 状態を変えるときは今の status を読み、遷移表 (画面のボタンと同じ。draft → running・running → completed・
 *    running → cancelled) に無い変更 (同じ状態への変更を含む) は 409 OP_EXPERIMENT_INVALID_TRANSITION で断る
 *    (書かず、監査ログも残さない)
 *  - 状態の更新は読んだ status のままのときだけ書く条件つき。読んでから書くまでに別の操作が状態を変えていたら 0 行で
 *    409 CONFLICT_STALE_DATA (書かず、監査も残さない)。行が消えていたら 404
 *  - status を送らない更新 (名前・仮説など) は遷移の検査をしない (従来どおり)
 *
 * 別の操作は、route が experiments の更新を DB に送る直前に割り込ませて再現する
 * (schema-checked-db は route が付けた .eq の条件を実際に当てるので、条件の付け忘れは 200 と書き込みで見える)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type Row, type SchemaDb } from './helpers/schema-checked-db';
import {
  EXPERIMENT_INVALID_TRANSITION_ERROR_CODE,
  EXPERIMENT_STATUSES,
  EXPERIMENT_STATUS_TRANSITIONS,
  isAllowedExperimentStatusTransition,
} from '@/lib/super-admin/experiments-schemas';
import { STALE_DATA_ERROR_CODE } from '@/lib/admin/api-error-message';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

/** 運営 (super_admin) のセッションの client と service_role の client が見る DB (実験と監査ログ) */
let db: SchemaDb;

/** 読んでから書くまでの間に割り込む処理 (別の操作)。route が experiments の更新を送る直前に 1 回だけ実行する */
let beforeExperimentUpdate: (() => PromiseLike<unknown>) | null = null;

function interleavingFrom(table: string) {
  const query = db.from(table);
  if (table !== 'experiments') return query;
  let isUpdate = false;
  const update = query.update.bind(query);
  query.update = (values) => {
    isUpdate = true;
    return update(values);
  };
  type Result = Awaited<ReturnType<typeof query.single>>;
  const wrap = (terminal: () => Promise<Result>) => async (): Promise<Result> => {
    if (isUpdate && beforeExperimentUpdate) {
      const interleave = beforeExperimentUpdate;
      beforeExperimentUpdate = null;
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
  getSupabaseAdmin: () => ({ from: interleavingFrom }),
}));

const { PATCH } = await import('@/app/api/super-admin/experiments/[id]/route');

const EXPERIMENT_ID = '00000000-0000-4000-8000-000000002059';
const ACTOR = { id: '00000000-0000-4000-8000-000000000001', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

function experimentRow(overrides: Row = {}): Row {
  return {
    id: EXPERIMENT_ID,
    key: 'onboarding_copy_2059',
    name: 'オンボーディングの文言',
    hypothesis: null,
    variants: [
      { key: 'control', weight: 50 },
      { key: 'treatment', weight: 50 },
    ],
    primary_metric: null,
    start_date: null,
    end_date: null,
    status: 'draft',
    result: null,
    created_by: ACTOR.id,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function setup(experiment: Row | null, options: { errors?: Record<string, { message: string; code?: string }> } = {}) {
  db = createSchemaDb({
    tables: { experiments: experiment ? [experiment] : [], admin_audit_logs: [] },
    errors: options.errors,
  });
}

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost/api/super-admin/experiments/${EXPERIMENT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: EXPERIMENT_ID }) },
  );
}

const experimentNow = () => db.rows('experiments').find((row) => row.id === EXPERIMENT_ID);
const auditRows = () => db.rows('admin_audit_logs');
const json = (res: Response) => res.json() as Promise<Record<string, any>>;

/** 画面のボタンが送る遷移 (一覧: 開始・完了 / 詳細: 実験開始・完了・中止) */
const ALLOWED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['draft', 'running'],
  ['running', 'completed'],
  ['running', 'cancelled'],
];
const isAllowedPair = (from: string, to: string) => ALLOWED_PAIRS.some(([f, t]) => f === from && t === to);
/** 4 つの状態の総当たり (16 通り) のうち、遷移表に無いもの (同じ状態への変更を含む 13 通り) */
const DENIED_PAIRS = EXPERIMENT_STATUSES.flatMap((from) =>
  EXPERIMENT_STATUSES.filter((to) => !isAllowedPair(from, to)).map((to) => [from, to] as const),
);

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ACTOR);
  beforeExperimentUpdate = null;
});

describe('遷移表 (EXPERIMENT_STATUS_TRANSITIONS)', () => {
  it('許す遷移は画面のボタンと同じ 3 つだけ (draft → running・running → completed・running → cancelled)', () => {
    const allowed = EXPERIMENT_STATUSES.flatMap((from) => EXPERIMENT_STATUS_TRANSITIONS[from].map((to) => [from, to]));
    expect(allowed).toEqual(ALLOWED_PAIRS.map(([from, to]) => [from, to]));
    expect(DENIED_PAIRS).toHaveLength(13);
    for (const [from, to] of DENIED_PAIRS) {
      expect(isAllowedExperimentStatusTransition(from, to), `${from} → ${to}`).toBe(false);
    }
  });

  it('DB に知らない status が入っていたら、どこへも変えない', () => {
    for (const to of EXPERIMENT_STATUSES) {
      expect(isAllowedExperimentStatusTransition('paused', to)).toBe(false);
    }
  });
});

describe('遷移表にある変更', () => {
  it.each(ALLOWED_PAIRS)('%s → %s は 200 で書き、監査ログを 1 行残す。更新は読んだ status を条件にする', async (from, to) => {
    setup(experimentRow({ status: from }));
    const res = await patch({ status: to });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id: EXPERIMENT_ID, status: to });
    expect(experimentNow()?.status).toBe(to);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].details).toMatchObject({ changes: { status: to } });
    const update = db.recorded('experiments', 'update');
    expect(update).toHaveLength(1);
    expect(update[0].eq).toEqual([
      ['id', EXPERIMENT_ID],
      ['status', from],
    ]);
  });
});

describe('遷移表に無い変更 (同じ状態への変更・終わった実験の再開・下書きへの戻しなど)', () => {
  it.each(DENIED_PAIRS)('%s → %s は 409 OP_EXPERIMENT_INVALID_TRANSITION で断り、書かず監査も残さない', async (from, to) => {
    setup(experimentRow({ status: from }));
    const res = await patch({ status: to });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe(EXPERIMENT_INVALID_TRANSITION_ERROR_CODE);
    expect(body.error.code).toBe('OP_EXPERIMENT_INVALID_TRANSITION');
    expect(body.error.message).toContain(`${from} から ${to} へは変えられません`);
    expect(experimentNow()?.status).toBe(from);
    expect(db.recorded('experiments', 'update')).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('二度押し (running → running) を続けて 2 本送ると、2 本目は 409 で、監査ログは 1 行だけ', async () => {
    setup(experimentRow({ status: 'draft' }));
    const first = await patch({ status: 'running' });
    const second = await patch({ status: 'running' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect((await json(second)).error.code).toBe(EXPERIMENT_INVALID_TRANSITION_ERROR_CODE);
    expect(experimentNow()?.status).toBe('running');
    expect(auditRows()).toHaveLength(1);
  });

  it('状態と一緒に送った名前も書かない (遷移が断られたら本文のどの項目も書かない)', async () => {
    setup(experimentRow({ status: 'completed', name: '元の名前' }));
    const res = await patch({ status: 'running', name: '新しい名前' });
    expect(res.status).toBe(409);
    expect(experimentNow()).toMatchObject({ status: 'completed', name: '元の名前' });
    expect(auditRows()).toHaveLength(0);
  });
});

describe('読んでから書くまでに別の操作が状態を変えた (2 つのタブ・2 人で同時に押した)', () => {
  it('draft → running の間に別の操作が開始していた: 409 CONFLICT_STALE_DATA。書かず、監査も残さない', async () => {
    setup(experimentRow({ status: 'draft' }));
    beforeExperimentUpdate = () => db.from('experiments').update({ status: 'running' }).eq('id', EXPERIMENT_ID);
    const res = await patch({ status: 'running' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe(STALE_DATA_ERROR_CODE);
    expect(experimentNow()?.status).toBe('running');
    expect(auditRows()).toHaveLength(0);
  });

  it('running → completed の間に別の操作が中止していた: 409。中止した実験は完了に上書きされない', async () => {
    setup(experimentRow({ status: 'running' }));
    beforeExperimentUpdate = () => db.from('experiments').update({ status: 'cancelled' }).eq('id', EXPERIMENT_ID);
    const res = await patch({ status: 'completed' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe(STALE_DATA_ERROR_CODE);
    expect(experimentNow()?.status).toBe('cancelled');
    expect(auditRows()).toHaveLength(0);
  });

  it('読んでから書くまでに実験が消された: 404 NOT_FOUND で、監査も残さない', async () => {
    setup(experimentRow({ status: 'draft' }));
    beforeExperimentUpdate = () => db.from('experiments').delete().eq('id', EXPERIMENT_ID);
    const res = await patch({ status: 'running' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
    expect(auditRows()).toHaveLength(0);
  });
});

describe('状態を読めないとき・行が無いとき', () => {
  it('行が無ければ 404 で、更新を送らない', async () => {
    setup(null);
    const res = await patch({ status: 'running' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
    expect(db.recorded('experiments', 'update')).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('今の状態の読み込みが DB の失敗なら 500 (404 にしない・遷移を検査せずに書かない)', async () => {
    setup(experimentRow({ status: 'draft' }), { errors: { experiments: { message: 'connection reset by peer', code: '08006' } } });
    const res = await patch({ status: 'running' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain('connection reset by peer');
    expect(auditRows()).toHaveLength(0);
  });
});

describe('status を送らない更新', () => {
  it('名前だけの更新は、終わった実験でも遷移の検査をせずに 200 (従来どおり。状態は変わらない)', async () => {
    setup(experimentRow({ status: 'completed', name: '元の名前' }));
    const res = await patch({ name: '新しい名前' });
    expect(res.status).toBe(200);
    expect(experimentNow()).toMatchObject({ status: 'completed', name: '新しい名前' });
    expect(auditRows()).toHaveLength(1);
  });
});
