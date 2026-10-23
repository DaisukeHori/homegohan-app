/**
 * #1912 組織のプランの段階は運営だけが変える: 運営の PATCH /api/admin/organizations/[id] の route テスト
 *
 * 組織の管理者の経路 (PUT /api/org/settings) は plan を受け取らず (tests/org-settings-keys.test.tsx)、DB のトリガーも
 * ログインした利用者の変更を拒む (tests/integration/rls/ai-plan-feature-caps-rpc.test.ts)。プランを変える経路はここだけ。
 *
 *  - admin / super_admin だけが通る。未ログインは 401、ほかのロール (組織の管理者 org_admin を含む) は 403 で、組織に触れない
 *  - 本文は { plan } だけ (ORG_PLAN_VALUES のどれか)。値の外・ほかのキー・壊れた JSON・UUID でない ID は 400 で、組織に触れない
 *  - 書くのは service_role の client (運営の JWT はログインした利用者なので、利用者の client だとトリガーに止められる)。
 *    ここでは、利用者の client の DB に organizations を入れず、service_role の DB にだけ入れて、どちらで書いたかを見分ける
 *  - 変えたら admin.organization.plan_change を運営本人の client で 1 行記録する (details = 変える前と後)。今と同じプランなら書かず記録もしない
 *  - 無い組織は 404。DB の失敗は 500 (汎用の文)
 *  - 同時の変更: 更新は「直前に読んだ plan のままなら書く」条件つき。読んでから書くまでに別の運営が変えていたら 0 行で、
 *    読み直した値が送られたプランと同じなら 200 (書かず記録もしない)、違えば 409 CONFLICT_STALE_DATA。
 *    監査の from / to は、書いた時点の実際の変化と必ず一致する (from が古い値で残らない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type SchemaDb } from './helpers/schema-checked-db';
import { jsonRequest, makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';
import { ORG_PLAN_VALUES } from '@/lib/org-plans';

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: vi.fn() }),
  generateRequestId: () => 'req_test',
}));

let sessionUser: FakeUser | null = null;
/** 運営本人の client が見る DB (本人の user_profiles と監査ログだけ。organizations は入れない) */
let sessionDb: SchemaDb;
/** service_role の client が見る DB (組織) */
let serviceDb: SchemaDb;

/**
 * 読んでから書くまでの間に割り込む処理 (別の運営の操作の再現)。設定すると、route の service_role の client が
 * organizations の更新 (update) を DB に送る直前に 1 回だけ実行し、終わってから更新を流す
 */
let beforeOrganizationUpdate: (() => PromiseLike<unknown>) | null = null;

/**
 * organizations への service_role のクエリを、種類 (select / update) と種類ごとの何回目 (0 始まり) で選んで失敗させる。
 * 返したエラーを DB に送らずに返す (読み直しだけの失敗など、テーブル全体の失敗では作れない場面の再現)
 */
let organizationFault: ((kind: 'select' | 'update', index: number) => DbError | null) | null = null;

/** organizations のクエリが DB に送られる直前に beforeOrganizationUpdate / organizationFault を挟む */
function interleavingFrom(table: string) {
  const query = serviceDb.from(table);
  if (table !== 'organizations') return query;
  let isUpdate = false;
  const update = query.update.bind(query);
  query.update = (values) => {
    isUpdate = true;
    return update(values);
  };
  type Result = Awaited<ReturnType<typeof query.single>>;
  const wrap = (terminal: () => Promise<Result>) => async (): Promise<Result> => {
    const kind = isUpdate ? 'update' : 'select';
    const interleave = isUpdate ? beforeOrganizationUpdate : null;
    if (interleave) {
      beforeOrganizationUpdate = null;
      await interleave();
    }
    const index = organizationQueryCount[kind];
    organizationQueryCount[kind] += 1;
    const fault = organizationFault?.(kind, index) ?? null;
    if (fault) return { data: null, error: fault, count: null };
    return terminal();
  };
  query.single = wrap(query.single.bind(query));
  query.maybeSingle = wrap(query.maybeSingle.bind(query));
  return query;
}

/** route (と割り込んだ別の運営) が organizations へ送った select / update の回数 */
const organizationQueryCount = { select: 0, update: 0 };

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
  getSupabaseAdmin: () => ({ ...makeClient(serviceDb, null), from: interleavingFrom }),
}));

const route = await import('@/app/api/admin/organizations/[id]/route');

const ACTOR_ID = uuid(1);
const ORG_ID = uuid(100);
const OTHER_ORG_ID = uuid(200);
const AUDIT_ACTION = 'admin.organization.plan_change';
const CLIENT_IP = '203.0.113.19';

const ALLOWED_ROLES = ['admin', 'super_admin'] as const;
const DENIED_ROLES = ['user', 'support', 'sales', 'finance', 'content_moderator', 'org_admin'] as const;

function organization(id: string, plan: string | null) {
  return {
    id,
    name: `組織 ${id.slice(-3)}`,
    plan,
    owner_id: uuid(9),
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };
}

function setup(options: { roles?: string[] | null; plan?: string | null; serviceErrors?: Record<string, DbError> } = {}) {
  const roles = options.roles === undefined ? ['admin'] : options.roles;
  sessionUser = roles === null ? null : { id: ACTOR_ID };
  sessionDb = createSchemaDb({
    tables: {
      user_profiles: roles === null ? [] : [profileRow(ACTOR_ID, { roles })],
      admin_audit_logs: [],
    },
  });
  serviceDb = createSchemaDb({
    tables: {
      organizations: [
        organization(ORG_ID, options.plan === undefined ? 'standard' : options.plan),
        organization(OTHER_ORG_ID, 'standard'),
      ],
    },
    errors: options.serviceErrors,
  });
}

function patch(body: unknown, id = ORG_ID) {
  return route.PATCH(
    jsonRequest(`http://localhost/api/admin/organizations/${id}`, 'PATCH', body, { 'x-forwarded-for': CLIENT_IP }),
    { params: Promise.resolve({ id }) },
  );
}

const planOf = (id: string) => serviceDb.rows('organizations').find((row) => row.id === id)?.plan;
const auditRows = () => sessionDb.rows('admin_audit_logs');
const json = (res: Response) => res.json() as Promise<Record<string, any>>;

beforeEach(() => {
  beforeOrganizationUpdate = null;
  organizationFault = null;
  organizationQueryCount.select = 0;
  organizationQueryCount.update = 0;
  setup();
});

describe('PATCH /api/admin/organizations/[id]: 権限', () => {
  it('401: 未ログイン。組織に触れない', async () => {
    setup({ roles: null });
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('AUTH_UNAUTHENTICATED');
    expect(serviceDb.recorded('organizations')).toHaveLength(0);
    expect(planOf(ORG_ID)).toBe('standard');
  });

  it.each(DENIED_ROLES)('403: %s ロールだけのユーザー。組織に触れない', async (role) => {
    setup({ roles: [role] });
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('OP_PERMISSION_DENIED');
    expect(serviceDb.recorded('organizations')).toHaveLength(0);
    expect(planOf(ORG_ID)).toBe('standard');
    expect(auditRows()).toEqual([]);
  });

  it.each(ALLOWED_ROLES)('%s ロールはプランを変えられる', async (role) => {
    setup({ roles: [role] });
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(200);
    expect(planOf(ORG_ID)).toBe('premium');
  });
});

describe('PATCH /api/admin/organizations/[id]: 変更と監査', () => {
  it.each(ORG_PLAN_VALUES.filter((plan) => plan !== 'standard'))(
    'standard → %s: service_role で対象の組織だけを書き、返す。監査を運営本人の client で 1 行残す',
    async (plan) => {
      const res = await patch({ plan });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.organization).toMatchObject({ id: ORG_ID, plan });
      expect(Object.keys(body.organization).sort()).toEqual(['created_at', 'id', 'name', 'plan', 'updated_at']);

      expect(planOf(ORG_ID)).toBe(plan);
      expect(planOf(OTHER_ORG_ID)).toBe('standard');
      const updates = serviceDb.recorded('organizations', 'update');
      expect(updates).toHaveLength(1);
      // 直前に読んだプラン (standard) のままのときだけ書く条件つきの更新
      expect(updates[0].eq).toEqual([
        ['id', ORG_ID],
        ['plan', 'standard'],
      ]);
      expect(updates[0].isNull).toEqual([]);
      expect(Object.keys(updates[0].values as Record<string, unknown>).sort()).toEqual(['plan', 'updated_at']);

      expect(auditRows()).toEqual([
        expect.objectContaining({
          actor_id: ACTOR_ID,
          action_type: AUDIT_ACTION,
          target_id: ORG_ID,
          target_type: 'organization',
          details: { from: 'standard', to: plan },
          severity: 'warn',
          ip_address: CLIENT_IP,
        }),
      ]);
    },
  );

  it('大文字の UUID の ID は小文字にそろえて書き、監査の target_id も小文字', async () => {
    const res = await patch({ plan: 'enterprise' }, ORG_ID.toUpperCase());
    expect(res.status).toBe(200);
    expect(planOf(ORG_ID)).toBe('enterprise');
    expect(auditRows().map((row) => row.target_id)).toEqual([ORG_ID]);
  });

  it('今と同じプランなら書かず、記録もしない (200 で今の行を返す)', async () => {
    setup({ plan: 'premium' });
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(200);
    expect((await json(res)).organization).toMatchObject({ id: ORG_ID, plan: 'premium' });
    expect(serviceDb.recorded('organizations', 'update')).toHaveLength(0);
    expect(auditRows()).toEqual([]);
  });

  it('一覧に無い値 (null・内部の値) の組織も、ORG_PLAN_VALUES のどれかへ変えられる。監査の from は元の値', async () => {
    setup({ plan: 'org_pro' });
    expect((await patch({ plan: 'standard' })).status).toBe(200);
    expect(planOf(ORG_ID)).toBe('standard');
    expect(auditRows().map((row) => row.details)).toEqual([{ from: 'org_pro', to: 'standard' }]);

    setup({ plan: null });
    expect((await patch({ plan: 'premium' })).status).toBe(200);
    expect(planOf(ORG_ID)).toBe('premium');
    expect(auditRows().map((row) => row.details)).toEqual([{ from: null, to: 'premium' }]);
    // 読んだ値が NULL のときは .is(plan, null) で比べる (PostgREST の eq.null は NULL に一致しない)
    const [nullUpdate] = serviceDb.recorded('organizations', 'update');
    expect(nullUpdate.eq).toEqual([['id', ORG_ID]]);
    expect(nullUpdate.isNull).toEqual(['plan']);
  });
});

describe('PATCH /api/admin/organizations/[id]: 同時の変更 (読んでから書くまでに別の運営が変えた)', () => {
  /** 別の運営 (同じ運営の権限) が、こちらの更新の直前に同じ組織のプランを変える */
  const otherOperatorChanges = (plan: string) => () => patch({ plan });

  it('409 CONFLICT_STALE_DATA: 別の運営が違うプランへ先に変えた。上書きせず、こちらの監査を残さない (監査は実際の変化だけ)', async () => {
    beforeOrganizationUpdate = otherOperatorChanges('enterprise');
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe('CONFLICT_STALE_DATA');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);

    // 先に変えた運営の値が残る (こちらは上書きしない)
    expect(planOf(ORG_ID)).toBe('enterprise');
    // こちらの更新は「直前に読んだ standard のままなら」の条件つきで、0 行だった
    const updates = serviceDb.recorded('organizations', 'update');
    expect(updates.map((q) => q.eq)).toEqual([
      [
        ['id', ORG_ID],
        ['plan', 'standard'],
      ],
      [
        ['id', ORG_ID],
        ['plan', 'standard'],
      ],
    ]);
    // 監査は先に変えた運営の 1 行だけで、実際の変化 (standard → enterprise) と一致する
    expect(auditRows().map((row) => row.details)).toEqual([{ from: 'standard', to: 'enterprise' }]);
  });

  it('続けて送り直すと、読み直した今の値 (先の運営の変更) を from として記録する', async () => {
    beforeOrganizationUpdate = otherOperatorChanges('enterprise');
    expect((await patch({ plan: 'premium' })).status).toBe(409);
    expect((await patch({ plan: 'premium' })).status).toBe(200);
    expect(planOf(ORG_ID)).toBe('premium');
    // 監査の列は実際の変化の列 (standard → enterprise → premium) と一致し、from が古い値 (standard) で残らない
    expect(auditRows().map((row) => row.details)).toEqual([
      { from: 'standard', to: 'enterprise' },
      { from: 'enterprise', to: 'premium' },
    ]);
  });

  it('200: 別の運営が同じプランへ先に変えた。書かず、こちらの監査も残さない (今の行を返す)', async () => {
    beforeOrganizationUpdate = otherOperatorChanges('premium');
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(200);
    expect((await json(res)).organization).toMatchObject({ id: ORG_ID, plan: 'premium' });
    expect(planOf(ORG_ID)).toBe('premium');
    // 先の運営の 1 行だけ (こちらの standard → premium は書いていないので記録しない)
    expect(auditRows().map((row) => row.details)).toEqual([{ from: 'standard', to: 'premium' }]);
  });

  it('409: 読んだ値が NULL で、書く前に別の運営が値を入れた。上書きせず、記録は先の運営の 1 行だけ', async () => {
    setup({ plan: null });
    beforeOrganizationUpdate = otherOperatorChanges('standard');
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('CONFLICT_STALE_DATA');
    expect(planOf(ORG_ID)).toBe('standard');
    expect(auditRows().map((row) => row.details)).toEqual([{ from: null, to: 'standard' }]);
  });

  it('404 NOT_FOUND: 読んでから書くまでに組織が消えた。書かず、記録しない', async () => {
    beforeOrganizationUpdate = () => serviceDb.from('organizations').delete().eq('id', ORG_ID);
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
    expect(planOf(ORG_ID)).toBeUndefined();
    expect(planOf(OTHER_ORG_ID)).toBe('standard');
    expect(auditRows()).toEqual([]);
  });

  it('500: 0 行のあとの読み直しに失敗した。汎用の文だけを返し、記録しない', async () => {
    beforeOrganizationUpdate = otherOperatorChanges('enterprise');
    // select の 0 回目 = こちらの読み、1 回目 = 別の運営の読み、2 回目 = こちらの読み直し
    organizationFault = (kind, index) =>
      kind === 'select' && index === 2 ? { message: 'connection reset by peer', code: '08006' } : null;
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: '組織のプランを変更できませんでした' });
    expect(JSON.stringify(body)).not.toContain('connection reset');
    expect(planOf(ORG_ID)).toBe('enterprise');
    expect(auditRows().map((row) => row.details)).toEqual([{ from: 'standard', to: 'enterprise' }]);
  });

});

describe('PATCH /api/admin/organizations/[id]: 入力の誤り・見つからない・失敗', () => {
  it.each([
    ['有料の plan_key', { plan: 'pro' }],
    ['free', { plan: 'free' }],
    ['組織の内部の plan_key', { plan: 'org_pro' }],
    ['null', { plan: null }],
    ['大文字', { plan: 'Premium' }],
    ['plan が無い', {}],
    ['ほかのキーも送る', { plan: 'premium', name: '名前も変える' }],
    ['オブジェクトでない', ['premium']],
  ])('400 VALIDATION_ERROR: %s。組織に触れず、記録しない', async (_label, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    expect(serviceDb.recorded('organizations')).toHaveLength(0);
    expect(planOf(ORG_ID)).toBe('standard');
    expect(auditRows()).toEqual([]);
  });

  it('400 INVALID_JSON: 本文が JSON でない', async () => {
    const res = await patch('{not json');
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('INVALID_JSON');
    expect(serviceDb.recorded('organizations')).toHaveLength(0);
  });

  it('400 VALIDATION_ERROR: ID が UUID でない。組織に触れない', async () => {
    const res = await patch({ plan: 'premium' }, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    expect(serviceDb.recorded('organizations')).toHaveLength(0);
  });

  it('404 NOT_FOUND: 組織が無い。書かず、記録しない', async () => {
    const res = await patch({ plan: 'premium' }, uuid(999));
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
    expect(serviceDb.recorded('organizations', 'update')).toHaveLength(0);
    expect(auditRows()).toEqual([]);
  });

  it('500: DB の失敗は汎用の文だけを返し、記録しない', async () => {
    setup({ serviceErrors: { organizations: { message: 'connection reset by peer', code: '08006' } } });
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: '組織のプランを変更できませんでした' });
    expect(JSON.stringify(body)).not.toContain('connection reset');
    expect(auditRows()).toEqual([]);
  });

  it('500: 読みは通り、更新だけが失敗した。汎用の文だけを返し、記録しない', async () => {
    organizationFault = (kind) => (kind === 'update' ? { message: 'connection reset by peer', code: '08006' } : null);
    const res = await patch({ plan: 'premium' });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: '組織のプランを変更できませんでした' });
    expect(JSON.stringify(body)).not.toContain('connection reset');
    expect(planOf(ORG_ID)).toBe('standard');
    expect(auditRows()).toEqual([]);
  });
});
