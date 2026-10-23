/**
 * 営業リードの API の読み込みの DB の失敗と、記録の書き込みの失敗の回帰テスト (#1917 の整合の候補 C19・C20)
 *
 * 以前は次のようになっていた:
 *  - GET /api/admin/sales/leads/[id] と POST /api/admin/sales/leads/[id]/activities は、リードの読み込みの
 *    DB の失敗 (`error`) も「行が無い」と同じに扱い、404 NOT_FOUND を返した。一時的な失敗でリードが消えたように見えた
 *    (PATCH は同じ失敗を 500 にするので食い違った)
 *  - GET の活動履歴の読み込みの失敗は、空の履歴として 200 で返した (履歴が無いように見えた)
 *  - PATCH のステージの変更の活動履歴 (stage_change) の書き込みの結果を見ず、失敗しても何も残らなかった
 *  - POST の活動の追加のあとのリードの updated_at の更新の結果を見ず、失敗しても何も残らなかった
 *
 * 直したあとの不変条件:
 *  - リード・活動履歴の読み込みの DB の失敗は 500 INTERNAL_ERROR (DB の生の文面は本文に出さない)。404 は行が無いときだけ
 *  - UUID の形でない id は DB に渡さず 404 NOT_FOUND (GET・PATCH・活動の GET・POST)。uuid 型の列に渡すと 22P02 で失敗し、
 *    「DB の失敗は 500」に入ってしまうため (形の違う id は「そのリードは無い」と同じ)。PATCH・POST は本文の検査 (400) が先
 *  - 500 / 404 のときは、監査ログも活動も書かない
 *  - 記録の書き込み (stage_change・updated_at) の失敗は、本体 (リードの更新・活動の追加) が書けているので応答は成功のまま
 *    (監査ログと同じ fail-open)。失敗は db-logger に error で残す
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type SchemaDb } from './helpers/schema-checked-db';
import { jsonRequest, makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';

let sessionUser: FakeUser | null = null;
let sessionDb: SchemaDb;
/** sales_leads への update を、DB に送らずに失敗させる (読み込みは成功させたまま、書き込みだけの失敗の再現) */
let leadUpdateFault: DbError | null = null;

const mockLoggerError = vi.fn();
const loggerRouteNames: string[] = [];

vi.mock('@/lib/db-logger', () => ({
  createLogger: (routeName: string) => {
    loggerRouteNames.push(routeName);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: (...args: unknown[]) => mockLoggerError(...args),
      withUser: () => logger,
    };
    return logger;
  },
  generateRequestId: () => 'req_test',
}));

function faultInjectingFrom(table: string) {
  const query = sessionDb.from(table);
  if (table !== 'sales_leads') return query;
  const update = query.update.bind(query);
  query.update = (values) => {
    const built = update(values);
    const fault = leadUpdateFault;
    if (fault) {
      const failed = { data: null, error: fault, count: null };
      built.then = <T1 = unknown, T2 = never>(
        onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
        onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
      ): PromiseLike<T1 | T2> => Promise.resolve(failed).then(onfulfilled, onrejected);
    }
    return built;
  };
  return query;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ ...makeClient(sessionDb, sessionUser), from: faultInjectingFrom }),
  getSupabaseAdmin: () => makeClient(sessionDb, null),
}));

const leadRoute = await import('@/app/api/admin/sales/leads/[id]/route');
const activitiesRoute = await import('@/app/api/admin/sales/leads/[id]/activities/route');

const ACTOR_ID = uuid(1);
const LEAD_ID = uuid(100);
const MISSING_LEAD_ID = uuid(999);
/** DB の生のエラー文 (本文に出てはいけない) */
const RAW_DB_MESSAGE = 'connection reset by peer';
const DB_FAILURE: DbError = { message: RAW_DB_MESSAGE, code: '08006' };

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

const EXISTING_ACTIVITY = {
  id: uuid(500),
  lead_id: LEAD_ID,
  actor_id: ACTOR_ID,
  activity_type: 'note',
  details: { summary: '初回の電話' },
  created_at: '2026-10-02T00:00:00Z',
};

function setup(errors: Record<string, DbError> = {}) {
  sessionUser = { id: ACTOR_ID };
  sessionDb = createSchemaDb({
    tables: {
      user_profiles: [profileRow(ACTOR_ID, { roles: ['sales'] })],
      sales_leads: [lead(LEAD_ID, 'approach')],
      sales_lead_activities: [EXISTING_ACTIVITY],
      admin_audit_logs: [],
    },
    errors,
  });
}

interface ResponseBody {
  data?: Record<string, unknown> & { activities?: unknown[] };
  error?: { code: string; message: string };
}
const json = (res: Response) => res.json() as Promise<ResponseBody>;
const auditRows = () => sessionDb.rows('admin_audit_logs');
const activityRows = () => sessionDb.rows('sales_lead_activities');
/** db-logger の error() に渡ったメッセージ (第 1 引数) */
const loggedMessages = () => mockLoggerError.mock.calls.map((call) => call[0]);

function getLead(id = LEAD_ID) {
  return leadRoute.GET(new NextRequest(`http://localhost/api/admin/sales/leads/${id}`), {
    params: Promise.resolve({ id }),
  });
}

function patchLead(body: unknown, id = LEAD_ID) {
  return leadRoute.PATCH(new NextRequest(jsonRequest(`http://localhost/api/admin/sales/leads/${id}`, 'PATCH', body)), {
    params: Promise.resolve({ id }),
  });
}

function listActivities(id = LEAD_ID) {
  return activitiesRoute.GET(new NextRequest(`http://localhost/api/admin/sales/leads/${id}/activities`), {
    params: Promise.resolve({ id }),
  });
}

function addActivity(id = LEAD_ID) {
  return activitiesRoute.POST(
    new NextRequest(
      jsonRequest(`http://localhost/api/admin/sales/leads/${id}/activities`, 'POST', {
        activity_type: 'call',
        details: { summary: '提案の日程を決めた' },
      }),
    ),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  leadUpdateFault = null;
  mockLoggerError.mockClear();
  loggerRouteNames.length = 0;
  setup();
});

describe('GET /api/admin/sales/leads/[id]: 読み込みの失敗は 500、行が無いときだけ 404', () => {
  it('読めたら 200 で、活動履歴と一緒に返し、閲覧を監査ログに残す', async () => {
    const res = await getLead();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toMatchObject({ id: LEAD_ID, stage: 'approach' });
    expect(body.data?.activities).toEqual([EXISTING_ACTIVITY]);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ action_type: 'admin.sales.lead.view', target_id: LEAD_ID });
  });

  it('リードの行が無いときは 404 NOT_FOUND で、記録しない', async () => {
    const res = await getLead(MISSING_LEAD_ID);
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('NOT_FOUND');
    expect(auditRows()).toEqual([]);
  });

  it('リードの読み込みが DB の失敗なら 500 INTERNAL_ERROR (404 にしない)。生の文面を出さず、記録しない', async () => {
    setup({ sales_leads: DB_FAILURE });
    const res = await getLead();
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain(RAW_DB_MESSAGE);
    expect(auditRows()).toEqual([]);
    // 原因は構造化ログにだけ残る
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(loggerRouteNames).toContain('GET /api/admin/sales/leads/[id]');
  });

  it('活動履歴の読み込みが DB の失敗なら 500 (空の履歴として 200 にしない)。記録しない', async () => {
    setup({ sales_lead_activities: DB_FAILURE });
    const res = await getLead();
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body).not.toHaveProperty('data');
    expect(JSON.stringify(body)).not.toContain(RAW_DB_MESSAGE);
    expect(auditRows()).toEqual([]);
  });
});

describe('POST /api/admin/sales/leads/[id]/activities: 読み込みの失敗は 500、行が無いときだけ 404', () => {
  it('リードがあれば 201 で活動を追加し、リードの updated_at を進め、監査ログに残す', async () => {
    const res = await addActivity();
    expect(res.status).toBe(201);
    expect(activityRows().filter((row) => row.activity_type === 'call')).toHaveLength(1);
    expect(sessionDb.rows('sales_leads')[0].updated_at).not.toBe('2026-10-01T00:00:00Z');
    expect(auditRows()).toHaveLength(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('リードの行が無いときは 404 NOT_FOUND で、活動を書かず、記録しない', async () => {
    const res = await addActivity(MISSING_LEAD_ID);
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('NOT_FOUND');
    expect(sessionDb.recorded('sales_lead_activities', 'insert')).toHaveLength(0);
    expect(auditRows()).toEqual([]);
  });

  it('リードの読み込みが DB の失敗なら 500 INTERNAL_ERROR (404 にしない)。活動を書かず、記録しない', async () => {
    setup({ sales_leads: DB_FAILURE });
    const res = await addActivity();
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain(RAW_DB_MESSAGE);
    expect(sessionDb.recorded('sales_lead_activities', 'insert')).toHaveLength(0);
    expect(activityRows()).toEqual([EXISTING_ACTIVITY]);
    expect(auditRows()).toEqual([]);
    expect(loggerRouteNames).toContain('POST /api/admin/sales/leads/[id]/activities');
  });

  it('追加のあとの updated_at の更新に失敗しても 201 のまま (活動は書けている)。失敗は db-logger に error で残す', async () => {
    leadUpdateFault = DB_FAILURE;
    const res = await addActivity();
    expect(res.status).toBe(201);
    expect(activityRows().filter((row) => row.activity_type === 'call')).toHaveLength(1);
    expect(sessionDb.rows('sales_leads')[0].updated_at).toBe('2026-10-01T00:00:00Z');
    expect(auditRows()).toHaveLength(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(loggedMessages()[0]).toContain('updated_at の更新に失敗しました');
  });
});

describe('PATCH /api/admin/sales/leads/[id]: ステージの変更の活動履歴の書き込みの失敗', () => {
  it('stage_change の書き込みが成功したときは、ログに error を残さない', async () => {
    const res = await patchLead({ stage: 'meeting' });
    expect(res.status).toBe(200);
    expect(activityRows().filter((row) => row.activity_type === 'stage_change')).toHaveLength(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('stage_change の書き込みに失敗しても 200 のまま (リードは更新できている)。失敗は db-logger に error で残し、監査ログも残す', async () => {
    setup({ sales_lead_activities: DB_FAILURE });
    const res = await patchLead({ stage: 'meeting' });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id: LEAD_ID, stage: 'meeting' });
    expect(sessionDb.rows('sales_leads')[0].stage).toBe('meeting');
    expect(sessionDb.recorded('sales_lead_activities', 'insert')).toHaveLength(1);
    expect(activityRows()).toEqual([EXISTING_ACTIVITY]);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(loggedMessages()[0]).toContain('stage_change');
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ lead_id: LEAD_ID, from_stage: 'approach', to_stage: 'meeting' });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ action_type: 'admin.sales.lead.update', target_id: LEAD_ID });
  });
});

describe('UUID の形でない id: DB に渡さず 404 NOT_FOUND (22P02 を「DB の失敗」の 500 にしない)', () => {
  const NOT_A_UUID = 'not-a-uuid';
  /** 本物の Postgres が uuid 型の列に UUID でない文字列を渡されたときに返すエラー */
  const INVALID_UUID_FAILURE: DbError = { message: `invalid input syntax for type uuid: "${NOT_A_UUID}"`, code: '22P02' };

  beforeEach(() => {
    // DB に渡れば 22P02 で失敗する状態にする (守りが外れると 500 になる)
    setup({ sales_leads: INVALID_UUID_FAILURE, sales_lead_activities: INVALID_UUID_FAILURE });
  });

  /** リード・活動履歴のテーブルに 1 回も問い合わせていない */
  function expectNoLeadQueries() {
    expect(sessionDb.recorded('sales_leads')).toHaveLength(0);
    expect(sessionDb.recorded('sales_lead_activities')).toHaveLength(0);
  }

  it('GET /[id] は 404 NOT_FOUND で、DB に問い合わせず、記録しない', async () => {
    const res = await getLead(NOT_A_UUID);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toEqual({ code: 'NOT_FOUND', message: 'リードが見つかりません' });
    expectNoLeadQueries();
    expect(auditRows()).toEqual([]);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('PATCH /[id] は 404 NOT_FOUND で、DB に問い合わせず、書かず、記録しない', async () => {
    const res = await patchLead({ stage: 'meeting' }, NOT_A_UUID);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toEqual({ code: 'NOT_FOUND', message: 'リードが見つかりません' });
    expectNoLeadQueries();
    expect(sessionDb.rows('sales_leads')[0].stage).toBe('approach');
    expect(auditRows()).toEqual([]);
  });

  it('PATCH /[id] は本文の検査が先 (行が無い UUID と同じく 400 → 404 の順)', async () => {
    const res = await patchLead({ stage: 'INVALID_STAGE' }, NOT_A_UUID);
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe('VALIDATION_ERROR');
    expectNoLeadQueries();
  });

  it('GET /[id]/activities は 404 NOT_FOUND で、DB に問い合わせない', async () => {
    const res = await listActivities(NOT_A_UUID);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toEqual({ code: 'NOT_FOUND', message: 'リードが見つかりません' });
    expectNoLeadQueries();
  });

  it('POST /[id]/activities は 404 NOT_FOUND で、活動を書かず、記録しない', async () => {
    const res = await addActivity(NOT_A_UUID);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toEqual({ code: 'NOT_FOUND', message: 'リードが見つかりません' });
    expectNoLeadQueries();
    expect(activityRows()).toEqual([EXISTING_ACTIVITY]);
    expect(auditRows()).toEqual([]);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('UUID の形の id は守りを通って DB に届き、DB の失敗は従来どおり 500 INTERNAL_ERROR', async () => {
    const res = await getLead(LEAD_ID);
    expect(res.status).toBe(500);
    expect((await json(res)).error?.code).toBe('INTERNAL_ERROR');
    expect(sessionDb.recorded('sales_leads')).toHaveLength(1);
  });
});
