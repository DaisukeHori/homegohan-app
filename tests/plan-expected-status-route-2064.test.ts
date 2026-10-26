/**
 * #2064 (R1) PATCH /api/super-admin/plans/[id] の expected_status (画面が見ていた status) のテスト
 *
 * 以前の route は、状態の変更の本文に画面が見ていた status を受けず、DB から読んだ status だけで遷移を検査していた。
 * 画面の status が古い (状態の変更のあとの読み直しが失敗した・画面を開いているあいだに別の運営が廃止した) と、
 * 画面は「公開中」のまま「非公開にする」を出し、確認の文も「このプランを非公開にしますか？」のまま { status: 'private' } を送る。
 * route は DB の deprecated と private で遷移を検査し、deprecated → private (廃止の取り消し) は許されるので、
 * 運営が廃止したプランの廃止が、確認の文に出ないまま取り消されていた (監査には status_from=deprecated → private)。
 *   - expected_status が DB の status と違えば、書かずに 409 CONFLICT_STALE_DATA (監査も残さない)
 *   - expected_status が DB の status と同じなら、これまでどおり書く (expected_status は列に書かない・監査の changes にも入れない)
 *   - expected_status を送らない呼び出しは、これまでと同じ
 *   - expected_status はプランの状態の 4 値のどれかでなければ 400
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';
import { createFakePlanSubscribersDb } from './helpers/fake-plan-subscribers-db';

/** route は UUID の形でない id を DB に渡さず 404 にする (#1917) ので、id は UUID の形にする */
const PLAN_ID = '20642064-2064-4064-8064-206420642064';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    withUser: () => ({ error: vi.fn() }),
  }),
  generateRequestId: () => 'req_test',
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;
const mockGetSupabaseAdmin = vi.fn();
/** service_role の client で subscription_plans に触れた回数の記録 (プランの更新は service_role で書く) */
let adminPlanWrites: string[] = [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { PATCH } = await import('@/app/api/super-admin/plans/[id]/route');

const actor = { id: 'sa-2064', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };
const ENDS_AT = '2027-01-01T00:00:00.000Z';

interface ResponseBody {
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function existingPlan(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAN_ID,
    plan_key: 'pro_2064',
    display_name: 'Pro 2064',
    plan_type: 'personal',
    status: 'public',
    ends_at: null,
    ...overrides,
  };
}

function patchRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/super-admin/plans/${PLAN_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

/** 1 回目の subscription_plans が既存プランの取得、2 回目が条件つきの更新 (書いたあとの行) */
async function patch(body: Record<string, unknown>, plan: Record<string, unknown>) {
  fakeSupabase = createFakeSupabase({
    subscription_plans: [
      { data: plan, error: null },
      { data: { ...plan, status: body.status ?? plan.status, ...(body.ends_at !== undefined ? { ends_at: body.ends_at } : {}) }, error: null },
    ],
    admin_audit_logs: [{ data: null, error: null }],
  });
  const res = await PATCH(patchRequest(body), { params: Promise.resolve({ id: PLAN_ID }) } as never);
  return { res, json: (await res.json()) as ResponseBody };
}

/** fakeSupabase.from が呼ばれたテーブルの並び */
function tablesTouched() {
  return fakeSupabase.from.mock.calls.map((call) => call[0] as string);
}

/** 2 回目の subscription_plans (条件つきの更新) の update に渡した値 */
function updatedValues(): Record<string, unknown> {
  const builder = fakeSupabase.from.mock.results[1]!.value as { update: ReturnType<typeof vi.fn> };
  expect(builder.update).toHaveBeenCalledTimes(1);
  return builder.update.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
  const subscribersDb = createFakePlanSubscribersDb({});
  mockGetSupabaseAdmin.mockImplementation(() => ({
    from: (table: string) => {
      if (table !== 'subscription_plans') return subscribersDb.client.from(table);
      adminPlanWrites.push(table);
      return fakeSupabase.from(table);
    },
  }));
  adminPlanWrites = [];
});

describe('expected_status が DB の status と違えば、書かずに 409 CONFLICT_STALE_DATA (#2064)', () => {
  it('画面は公開中のまま「非公開にする」(expected_status=public) だが DB は廃止: 廃止を取り消さない (書かない・監査も残さない)', async () => {
    const { res, json } = await patch({ status: 'private', expected_status: 'public' }, existingPlan({ status: 'deprecated', ends_at: ENDS_AT }));

    expect(res.status).toBe(409);
    expect(json.error?.code).toBe('CONFLICT_STALE_DATA');
    // 読んだだけで、更新も監査も無い
    expect(tablesTouched()).toEqual(['subscription_plans']);
    expect(adminPlanWrites).toEqual([]);
  });

  it('画面は下書きのまま「公開する」だが DB は非公開: private → public を書かない', async () => {
    const { res, json } = await patch({ status: 'public', expected_status: 'draft' }, existingPlan({ status: 'private' }));

    expect(res.status).toBe(409);
    expect(json.error?.code).toBe('CONFLICT_STALE_DATA');
    expect(tablesTouched()).toEqual(['subscription_plans']);
  });

  it('画面は公開中のまま「廃止する」だが DB はもう廃止: 422 (廃止済みは変えられない) でなく 409 にする', async () => {
    const { res, json } = await patch(
      { status: 'deprecated', ends_at: ENDS_AT, expected_status: 'public' },
      existingPlan({ status: 'deprecated', ends_at: ENDS_AT }),
    );

    expect(res.status).toBe(409);
    expect(json.error?.code).toBe('CONFLICT_STALE_DATA');
    expect(tablesTouched()).toEqual(['subscription_plans']);
  });

  it('画面は廃止のまま「廃止を取り消す」だが DB はもう非公開: 書かない', async () => {
    const { res, json } = await patch({ status: 'private', expected_status: 'deprecated' }, existingPlan({ status: 'private' }));

    expect(res.status).toBe(409);
    expect(json.error?.code).toBe('CONFLICT_STALE_DATA');
    expect(tablesTouched()).toEqual(['subscription_plans']);
  });
});

describe('expected_status が DB の status と同じなら、これまでどおり書く (#2064)', () => {
  it('公開中 → 非公開: 200。status を書き、expected_status は列に書かず、監査の status_from は public', async () => {
    const { res, json } = await patch({ status: 'private', expected_status: 'public' }, existingPlan({ status: 'public' }));

    expect(res.status).toBe(200);
    expect(json.data?.status).toBe('private');
    const values = updatedValues();
    expect(values.status).toBe('private');
    expect(values).not.toHaveProperty('expected_status');
    expect(tablesTouched()).toEqual(['subscription_plans', 'subscription_plans', 'admin_audit_logs']);
    const auditBuilder = fakeSupabase.from.mock.results[2]!.value as { insert: ReturnType<typeof vi.fn> };
    const auditRow = auditBuilder.insert.mock.calls[0]![0] as { details: { changes: Record<string, unknown>; status_from?: string; status_to?: string } };
    expect(auditRow.details.status_from).toBe('public');
    expect(auditRow.details.status_to).toBe('private');
    expect(auditRow.details.changes).not.toHaveProperty('expected_status');
  });

  it('廃止 → 非公開 (廃止の取り消し): 廃止中に受ける項目 (status だけ) に expected_status を数えない', async () => {
    const { res, json } = await patch({ status: 'private', expected_status: 'deprecated' }, existingPlan({ status: 'deprecated', ends_at: ENDS_AT }));

    expect(res.status).toBe(200);
    expect(json.data?.status).toBe('private');
    expect(updatedValues().status).toBe('private');
  });

  it('公開中 → 廃止: 公開中・非公開で受ける項目に expected_status を数えない', async () => {
    const { res } = await patch({ status: 'deprecated', ends_at: ENDS_AT, expected_status: 'public' }, existingPlan({ status: 'public' }));

    expect(res.status).toBe(200);
    expect(updatedValues()).toMatchObject({ status: 'deprecated', ends_at: ENDS_AT });
  });

  it('下書き → 公開: 200', async () => {
    const { res } = await patch({ status: 'public', expected_status: 'draft' }, existingPlan({ status: 'draft' }));

    expect(res.status).toBe(200);
    expect(updatedValues().status).toBe('public');
  });
});

describe('expected_status を送らない呼び出しは、これまでと同じ', () => {
  it('{ status: private } だけなら、DB の status (deprecated) で遷移を検査して書く (これまでの API の形を変えない)', async () => {
    const { res } = await patch({ status: 'private' }, existingPlan({ status: 'deprecated', ends_at: ENDS_AT }));

    expect(res.status).toBe(200);
    expect(updatedValues().status).toBe('private');
  });
});

describe('expected_status の形', () => {
  it.each([['unknown'], [''], [1], [null]])('プランの状態の 4 値でない値 (%j) は 400 で、読みも書きもしない', async (value) => {
    const { res, json } = await patch({ status: 'private', expected_status: value }, existingPlan({ status: 'public' }));

    expect(res.status).toBe(400);
    expect(json.error?.code).toBe('OP_INVALID_INPUT');
    expect(adminPlanWrites).toEqual([]);
  });
});
