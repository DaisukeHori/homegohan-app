/**
 * PATCH /api/admin/sales/leads/[id] (リードの更新・ステージ変更) の route テスト
 *
 * 問い合わせの更新 (tests/admin-inquiries-route.test.ts) と同じ型の欠陥の回帰テスト:
 * ステージの変更は、活動履歴 (sales_lead_activities の stage_change) に from_stage を残す。以前は直前に読んだ stage を
 * 条件にせずに書いていたので、読んでから書くまでに別の担当者がステージを変えると、from_stage が実際の直前の値と食い違った
 * (同じステージを送り直したときは、別の担当者の変更を履歴に残さずに戻した)。
 *
 *  - ステージを送った更新は「直前に読んだ stage のままなら書く」条件つき。0 行なら読み直し、行があれば 409 CONFLICT_STALE_DATA
 *    (書かず、活動履歴も監査ログも残さない)、無ければ 404
 *  - ステージを送らない更新 (会社名・メモなど) は条件を付けない (ステージの履歴に関わらない)
 *  - 読み込み・更新・読み直しの DB の失敗は 500 (404 にしない)
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type SchemaDb } from './helpers/schema-checked-db';
import { jsonRequest, makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';

let sessionUser: FakeUser | null = null;
/** 担当者本人のセッションの client が見る DB (sales_leads の RLS は sales / admin / super_admin に全行を見せる) */
let sessionDb: SchemaDb;

/** route が sales_leads の更新を DB に送る直前に 1 回だけ実行する (別の担当者の操作の再現) */
let beforeLeadUpdate: (() => PromiseLike<unknown>) | null = null;
/** sales_leads への select を何回目 (0 始まり) で選んで失敗させる (読み直しだけの失敗の再現) */
let leadSelectFault: ((index: number) => DbError | null) | null = null;
let leadSelectCount = 0;
/** sales_leads への update を失敗させる (DB に送らずにエラーを返す) */
let leadUpdateFault: DbError | null = null;

/** sales_leads・sales_lead_activities に書いた client (本人のセッション / service_role)。書き込みは service_role だけ (#1917 の続き) */
let writeClients: Array<{ client: 'session' | 'admin'; table: string }> = [];

function interleavingFrom(table: string, client: 'session' | 'admin') {
  const query = sessionDb.from(table);
  if (table === 'sales_lead_activities') {
    const insert = query.insert.bind(query);
    query.insert = (values) => {
      writeClients.push({ client, table });
      return insert(values);
    };
  }
  if (table !== 'sales_leads') return query;
  let isUpdate = false;
  const update = query.update.bind(query);
  query.update = (values) => {
    isUpdate = true;
    writeClients.push({ client, table });
    return update(values);
  };
  type Result = Awaited<ReturnType<typeof query.single>>;
  const wrap = (terminal: () => Promise<Result>) => async (): Promise<Result> => {
    if (isUpdate) {
      const interleave = beforeLeadUpdate;
      if (interleave) {
        beforeLeadUpdate = null;
        await interleave();
      }
      if (leadUpdateFault) return { data: null, error: leadUpdateFault, count: null };
    } else {
      const index = leadSelectCount;
      leadSelectCount += 1;
      const fault = leadSelectFault?.(index) ?? null;
      if (fault) return { data: null, error: fault, count: null };
    }
    return terminal();
  };
  query.single = wrap(query.single.bind(query));
  query.maybeSingle = wrap(query.maybeSingle.bind(query));
  return query;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ ...makeClient(sessionDb, sessionUser), from: (table: string) => interleavingFrom(table, 'session') }),
  getSupabaseAdmin: () => ({ ...makeClient(sessionDb, null), from: (table: string) => interleavingFrom(table, 'admin') }),
}));

const route = await import('@/app/api/admin/sales/leads/[id]/route');

const ACTOR_ID = uuid(1);
const OTHER_SALES_ID = uuid(2);
const LEAD_ID = uuid(100);
const OTHER_LEAD_ID = uuid(200);

function lead(id: string, stage: string) {
  return {
    id,
    company_name: `会社 ${id.slice(-3)}`,
    industry: null,
    employee_count: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    source: null,
    stage,
    assigned_to: null,
    estimated_acv: null,
    notes: null,
    converted_org_id: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };
}

function setup(options: { stage?: string } = {}) {
  sessionUser = { id: ACTOR_ID };
  sessionDb = createSchemaDb({
    tables: {
      user_profiles: [profileRow(ACTOR_ID, { roles: ['sales'] }), profileRow(OTHER_SALES_ID, { roles: ['sales'] })],
      sales_leads: [lead(LEAD_ID, options.stage ?? 'approach'), lead(OTHER_LEAD_ID, 'approach')],
      sales_lead_activities: [],
      admin_audit_logs: [],
    },
  });
}

function patch(body: unknown, id = LEAD_ID) {
  return route.PATCH(
    new NextRequest(jsonRequest(`http://localhost/api/admin/sales/leads/${id}`, 'PATCH', body)),
    { params: Promise.resolve({ id }) },
  );
}

const stageOf = (id: string) => sessionDb.rows('sales_leads').find((row) => row.id === id)?.stage;
const stageHistory = () =>
  sessionDb
    .rows('sales_lead_activities')
    .filter((row) => row.activity_type === 'stage_change')
    .map((row) => row.details);
const auditRows = () => sessionDb.rows('admin_audit_logs');
interface ResponseBody {
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}
const json = (res: Response) => res.json() as Promise<ResponseBody>;

/** 別の担当者が、こちらの更新の直前に同じリードのステージを変える (活動履歴も残す。route と同じ書き方) */
const otherSalesChangesStage = (stage: string) => async () => {
  const before = stageOf(LEAD_ID);
  await sessionDb.from('sales_leads').update({ stage, updated_at: '2026-10-02T00:00:00Z' }).eq('id', LEAD_ID);
  await sessionDb.from('sales_lead_activities').insert({
    lead_id: LEAD_ID,
    actor_id: OTHER_SALES_ID,
    activity_type: 'stage_change',
    details: { from_stage: before, to_stage: stage },
  });
};

beforeEach(() => {
  beforeLeadUpdate = null;
  leadSelectFault = null;
  leadUpdateFault = null;
  leadSelectCount = 0;
  writeClients = [];
  setup();
});

describe('PATCH /api/admin/sales/leads/[id]: ステージの変更', () => {
  it('直前に読んだ stage のままなら書き、活動履歴に from_stage → to_stage を残す', async () => {
    const res = await patch({ stage: 'meeting' });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id: LEAD_ID, stage: 'meeting' });
    expect(stageOf(LEAD_ID)).toBe('meeting');
    expect(stageOf(OTHER_LEAD_ID)).toBe('approach');

    const updates = sessionDb.recorded('sales_leads', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].eq).toEqual([
      ['id', LEAD_ID],
      ['stage', 'approach'],
    ]);
    expect(stageHistory()).toEqual([{ from_stage: 'approach', to_stage: 'meeting' }]);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ action_type: 'admin.sales.lead.update', target_id: LEAD_ID });
    // リードの更新と活動履歴の追加は service_role で書く (運営の直接の書き込みを塞いだ。#1917 の続き)
    expect(writeClients).toEqual([
      { client: 'admin', table: 'sales_leads' },
      { client: 'admin', table: 'sales_lead_activities' },
    ]);
  });

  it('続けて変えても、2 回目は 1 回目が書いたステージを条件にして書ける', async () => {
    expect((await patch({ stage: 'meeting' })).status).toBe(200);
    expect((await patch({ stage: 'proposal' })).status).toBe(200);
    expect(stageHistory()).toEqual([
      { from_stage: 'approach', to_stage: 'meeting' },
      { from_stage: 'meeting', to_stage: 'proposal' },
    ]);
  });

  it('409 CONFLICT_STALE_DATA: 読んでから書くまでに別の担当者がステージを変えた。上書きせず、活動履歴も監査ログも残さない', async () => {
    beforeLeadUpdate = otherSalesChangesStage('proposal');
    const res = await patch({ stage: 'won' });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe('CONFLICT_STALE_DATA');
    expect(body.error?.message).toContain('画面を開き直して');
    expect(body).not.toHaveProperty('data');

    // 先の担当者の変更が残る
    expect(stageOf(LEAD_ID)).toBe('proposal');
    // こちらの更新 (先に組み立てたので 0 番目) は「直前に読んだ approach のままなら」の条件つきで、0 行だった
    expect(sessionDb.recorded('sales_leads', 'update')[0].eq).toEqual([
      ['id', LEAD_ID],
      ['stage', 'approach'],
    ]);
    // 活動履歴は先の担当者の 1 行だけで、実際の変化と一致する (approach → won のような古い from_stage を残さない)
    expect(stageHistory()).toEqual([{ from_stage: 'approach', to_stage: 'proposal' }]);
    expect(auditRows()).toEqual([]);
  });

  it('409: 読んだのと同じステージを送り直しても、別の担当者が変えたステージを履歴に残さずに戻さない', async () => {
    setup({ stage: 'meeting' });
    beforeLeadUpdate = otherSalesChangesStage('lost');
    const res = await patch({ stage: 'meeting', notes: 'メモ' });
    expect(res.status).toBe(409);
    expect(stageOf(LEAD_ID)).toBe('lost');
    expect(sessionDb.rows('sales_leads').find((row) => row.id === LEAD_ID)?.notes).toBeNull();
    expect(stageHistory()).toEqual([{ from_stage: 'meeting', to_stage: 'lost' }]);
  });

  it('続けて送り直すと、読み直した今のステージを from_stage として残す', async () => {
    beforeLeadUpdate = otherSalesChangesStage('proposal');
    expect((await patch({ stage: 'won' })).status).toBe(409);
    expect((await patch({ stage: 'won' })).status).toBe(200);
    expect(stageHistory()).toEqual([
      { from_stage: 'approach', to_stage: 'proposal' },
      { from_stage: 'proposal', to_stage: 'won' },
    ]);
  });

  it('404 NOT_FOUND: 読んでから書くまでにリードが消えた。書かず、記録しない', async () => {
    beforeLeadUpdate = () => sessionDb.from('sales_leads').delete().eq('id', LEAD_ID);
    const res = await patch({ stage: 'meeting' });
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('NOT_FOUND');
    expect(stageOf(OTHER_LEAD_ID)).toBe('approach');
    expect(stageHistory()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it('500: 0 行のあとの読み直しに失敗した (409 や 404 にしない)。記録しない', async () => {
    beforeLeadUpdate = otherSalesChangesStage('proposal');
    // select の 0 回目 = こちらの読み、1 回目 = 読み直し (別の担当者の更新は select を使わない)
    leadSelectFault = (index) => (index === 1 ? { message: 'connection reset by peer', code: '08006' } : null);
    const res = await patch({ stage: 'won' });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('connection reset');
    expect(auditRows()).toEqual([]);
  });
});

describe('PATCH /api/admin/sales/leads/[id]: ステージを送らない更新', () => {
  it('ステージに条件を付けずに書き、活動履歴は残さない', async () => {
    const res = await patch({ notes: '次回訪問は来週' });
    expect(res.status).toBe(200);
    const updates = sessionDb.recorded('sales_leads', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].eq).toEqual([['id', LEAD_ID]]);
    expect(stageHistory()).toEqual([]);
  });

  it('別の担当者がステージを変えていても、ステージ以外の更新は書ける (ステージの履歴に関わらない)', async () => {
    beforeLeadUpdate = otherSalesChangesStage('proposal');
    const res = await patch({ notes: '次回訪問は来週' });
    expect(res.status).toBe(200);
    expect(stageOf(LEAD_ID)).toBe('proposal');
    expect(sessionDb.rows('sales_leads').find((row) => row.id === LEAD_ID)?.notes).toBe('次回訪問は来週');
  });

  it('404: 読んでから書くまでにリードが消えた', async () => {
    beforeLeadUpdate = () => sessionDb.from('sales_leads').delete().eq('id', LEAD_ID);
    const res = await patch({ notes: 'x' });
    expect(res.status).toBe(404);
    expect(auditRows()).toEqual([]);
  });
});

describe('PATCH /api/admin/sales/leads/[id]: 見つからない・失敗', () => {
  it('無いリードは 404 で、書かない', async () => {
    const res = await patch({ stage: 'meeting' }, uuid(999));
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('NOT_FOUND');
    expect(sessionDb.recorded('sales_leads', 'update')).toHaveLength(0);
  });

  it('最初の読み込みに失敗したら 500 (404 にしない)。書かない', async () => {
    leadSelectFault = (index) => (index === 0 ? { message: 'timeout', code: '57014' } : null);
    const res = await patch({ stage: 'meeting' });
    expect(res.status).toBe(500);
    expect((await json(res)).error?.code).toBe('INTERNAL_ERROR');
    expect(sessionDb.recorded('sales_leads', 'update')).toHaveLength(0);
    expect(stageOf(LEAD_ID)).toBe('approach');
  });

  it('更新に失敗したら 500 (404 にしない)。活動履歴も監査ログも残さない', async () => {
    leadUpdateFault = { message: 'boom', code: 'XX000' };
    const res = await patch({ stage: 'meeting' });
    expect(res.status).toBe(500);
    expect((await json(res)).error?.code).toBe('INTERNAL_ERROR');
    expect(stageOf(LEAD_ID)).toBe('approach');
    expect(stageHistory()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
});
