/**
 * #1912 plan_key の形とプランの種別 (plan_type) の食い違いを運営のプランの作成で断る
 *
 * 利用者の画面の表示名 (packages/shared の planDisplayName) は plan_key の形 (isOrgPlanKey) だけで
 * 「組織のプラン」か「有料プラン」かを決める。運営の画面で
 *   - 個人・家族のプランに standard / premium / enterprise や org_ で始まる key を付けると「組織のプラン」と出る
 *   - 組織のプランに org_ で始まらない key を付けると「有料プラン」と出る
 * ので、POST /api/super-admin/plans の PlanCreateSchema で両方向を 400 にする。
 * 更新 (PATCH /api/super-admin/plans/[id]) は plan_key・plan_type を受けず (PlanUpdateSchema に無い)、行の値は変わらない。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORG_PLAN_DISPLAY_NAME,
  ORG_PLAN_VALUES_WIRE,
  ORG_SUBSCRIPTION_PLAN_KEY_PREFIX,
  isOrgPlanKey,
  planDisplayName,
} from '@homegohan/shared';
import {
  OFFICIAL_PLAN_KEYS,
  ORG_PLAN_KEY_PREFIX_MESSAGE,
  PERSONAL_FAMILY_PLAN_KEY_MESSAGE,
  PLAN_TYPES,
  PlanCreateSchema,
} from '@/lib/super-admin/plans-schemas';
import { createFakeSupabase } from './helpers/fake-supabase';

/** route は UUID の形でない id を DB に渡さず 404 にする (#1917) ので、id は UUID の形にする */
const PLAN_ID = '88888888-8888-4888-8888-888888888885';

type PlanType = (typeof PLAN_TYPES)[number];

/** 今ある行 (operator/01-data-model.md §3.2 の seed・src/app/super-admin/plans/new/page.tsx の OFFICIAL_PLANS) の plan_key と種別 */
const EXISTING_ROWS: ReadonlyArray<{ plan_key: (typeof OFFICIAL_PLAN_KEYS)[number]; plan_type: PlanType }> = [
  { plan_key: 'free', plan_type: 'personal' },
  { plan_key: 'pro', plan_type: 'personal' },
  { plan_key: 'family_basic', plan_type: 'family' },
  { plan_key: 'family_pro', plan_type: 'family' },
  { plan_key: 'family_addon', plan_type: 'family' },
  { plan_key: 'org_starter', plan_type: 'org' },
  { plan_key: 'org_standard', plan_type: 'org' },
  { plan_key: 'org_pro', plan_type: 'org' },
  { plan_key: 'org_enterprise', plan_type: 'org' },
];

const NON_ORG_PLAN_TYPES: readonly PlanType[] = ['personal', 'family'];

/** 組織のプランの値 (isOrgPlanKey に当たる) で、個人・家族のプランに付けてはいけない key */
const ORG_SHAPED_KEYS: readonly string[] = [
  ...ORG_PLAN_VALUES_WIRE,
  'org_starter',
  'org_standard',
  'org_new_2027',
  `${ORG_SUBSCRIPTION_PLAN_KEY_PREFIX}x`,
];

/** org_ で始まらず、組織のプランに付けてはいけない key (organizations.plan の値 standard / premium / enterprise も含む) */
const NON_ORG_PREFIX_KEYS: readonly string[] = [
  'pro',
  'free',
  'family_basic',
  'family_addon',
  ...ORG_PLAN_VALUES_WIRE,
  'organization_pro',
  'pro_org_',
];

function createInput(plan_key: string, plan_type: PlanType) {
  return { plan_key, plan_type, display_name: 'テストのプラン' };
}

function planKeyIssueMessages(plan_key: string, plan_type: PlanType): string[] {
  const result = PlanCreateSchema.safeParse(createInput(plan_key, plan_type));
  if (result.success) return [];
  return result.error.issues
    .filter((issue) => issue.path.length === 1 && issue.path[0] === 'plan_key')
    .map((issue) => issue.message);
}

describe('PlanCreateSchema: plan_key の形と plan_type (#1912)', () => {
  it('今ある行の plan_key と種別はすべて通る', () => {
    expect(EXISTING_ROWS.map((row) => row.plan_key)).toEqual([...OFFICIAL_PLAN_KEYS]);
    for (const row of EXISTING_ROWS) {
      const result = PlanCreateSchema.safeParse(createInput(row.plan_key, row.plan_type));
      expect({ ...row, success: result.success }).toEqual({ ...row, success: true });
    }
  });

  it('運営が新しく作る個人・家族のプランの key (組織のプランの値でないもの) は通る', () => {
    for (const plan_type of NON_ORG_PLAN_TYPES) {
      for (const plan_key of ['pro_2027', 'family_large', 'standard_plus', 'my_org', 'premium2']) {
        expect(isOrgPlanKey(plan_key)).toBe(false);
        expect({ plan_key, plan_type, success: PlanCreateSchema.safeParse(createInput(plan_key, plan_type)).success })
          .toEqual({ plan_key, plan_type, success: true });
      }
    }
  });

  it('個人・家族のプランに組織のプランの値 (standard / premium / enterprise・org_ で始まる key) を付けると plan_key の文で断る', () => {
    for (const plan_type of NON_ORG_PLAN_TYPES) {
      for (const plan_key of ORG_SHAPED_KEYS) {
        expect(isOrgPlanKey(plan_key)).toBe(true);
        expect({ plan_key, plan_type, messages: planKeyIssueMessages(plan_key, plan_type) })
          .toEqual({ plan_key, plan_type, messages: [PERSONAL_FAMILY_PLAN_KEY_MESSAGE] });
      }
    }
  });

  it('組織のプランに org_ で始まらない key を付けると plan_key の文で断る', () => {
    for (const plan_key of NON_ORG_PREFIX_KEYS) {
      expect(plan_key.startsWith(ORG_SUBSCRIPTION_PLAN_KEY_PREFIX)).toBe(false);
      expect({ plan_key, messages: planKeyIssueMessages(plan_key, 'org') })
        .toEqual({ plan_key, messages: [ORG_PLAN_KEY_PREFIX_MESSAGE] });
    }
  });

  it('文は断った理由 (使えない値・付けるべき接頭辞) を示す', () => {
    for (const value of ORG_PLAN_VALUES_WIRE) {
      expect(PERSONAL_FAMILY_PLAN_KEY_MESSAGE).toContain(value);
    }
    expect(PERSONAL_FAMILY_PLAN_KEY_MESSAGE).toContain(ORG_SUBSCRIPTION_PLAN_KEY_PREFIX);
    expect(ORG_PLAN_KEY_PREFIX_MESSAGE).toContain(ORG_SUBSCRIPTION_PLAN_KEY_PREFIX);
  });

  it('組織のプランの試用期間の検査はそのまま (org_ で始まる key でも trial_days > 0 は trial_days の文で断る)', () => {
    const result = PlanCreateSchema.safeParse({ ...createInput('org_new_2027', 'org'), trial_days: 7 });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))).toEqual(['trial_days']);
  });

  it('通る組み合わせは、利用者の画面の表示名が種別と一致する (組織のプランだけが「組織のプラン」)', () => {
    const candidates = [...new Set([...ORG_SHAPED_KEYS, ...NON_ORG_PREFIX_KEYS, ...OFFICIAL_PLAN_KEYS, 'pro_2027'])];
    for (const plan_type of PLAN_TYPES) {
      for (const plan_key of candidates) {
        if (!PlanCreateSchema.safeParse(createInput(plan_key, plan_type)).success) continue;
        expect({ plan_key, plan_type, orgName: planDisplayName(plan_key) === ORG_PLAN_DISPLAY_NAME })
          .toEqual({ plan_key, plan_type, orgName: plan_type === 'org' });
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// route: POST は 400 OP_INVALID_INPUT で DB に触れない・PATCH は plan_key / plan_type を行に書かない
// ─────────────────────────────────────────────────────────────────────────────

const mockRequireRole = vi.fn();
const mockRecordAdminAudit = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/admin/audit', () => ({
  recordAdminAudit: (...args: unknown[]) => mockRecordAdminAudit(...args),
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  getSupabaseAdmin: () => fakeSupabase,
}));

const { POST } = await import('@/app/api/super-admin/plans/route');
const { PATCH } = await import('@/app/api/super-admin/plans/[id]/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

function jsonRequest(method: 'POST' | 'PATCH', url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
  mockRecordAdminAudit.mockResolvedValue(undefined);
});

describe('POST /api/super-admin/plans: plan_key の形 (#1912)', () => {
  it.each<[string, string, PlanType, string]>([
    ['個人のプランに standard', 'standard', 'personal', PERSONAL_FAMILY_PLAN_KEY_MESSAGE],
    ['家族のプランに org_ で始まる key', 'org_family', 'family', PERSONAL_FAMILY_PLAN_KEY_MESSAGE],
    ['組織のプランに org_ で始まらない key', 'enterprise', 'org', ORG_PLAN_KEY_PREFIX_MESSAGE],
  ])('400 OP_INVALID_INPUT: %s (行を作らない)', async (_label, plan_key, plan_type, message) => {
    fakeSupabase = createFakeSupabase({});
    const res = await POST(jsonRequest('POST', 'http://localhost/api/super-admin/plans', createInput(plan_key, plan_type)));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error).toMatchObject({ code: 'OP_INVALID_INPUT', message });
    expect(fakeSupabase.from).not.toHaveBeenCalled();
    expect(mockRecordAdminAudit).not.toHaveBeenCalled();
  });

  it('201: 組織のプランに org_ で始まる key は作れて、送った plan_key と plan_type をそのまま書く', async () => {
    const created = { id: 'plan-new', plan_key: 'org_new_2027', plan_type: 'org', status: 'draft' };
    fakeSupabase = createFakeSupabase({ subscription_plans: [{ data: created, error: null }] });
    const res = await POST(jsonRequest('POST', 'http://localhost/api/super-admin/plans', createInput('org_new_2027', 'org')));
    expect(res.status).toBe(201);
    const builder = fakeSupabase.from.mock.results[0]?.value as { insert: ReturnType<typeof vi.fn> };
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ plan_key: 'org_new_2027', plan_type: 'org' }));
  });
});

describe('PATCH /api/super-admin/plans/[id]: plan_key / plan_type は変えられない (#1912)', () => {
  it('下書きのプランに plan_key / plan_type を送っても、更新の値に入らない (送った他の項目だけを書く)', async () => {
    const existing = { id: PLAN_ID, plan_key: 'pro_2027', display_name: 'Pro 2027', plan_type: 'personal', status: 'draft', ends_at: null };
    fakeSupabase = createFakeSupabase({
      subscription_plans: [
        { data: existing, error: null },
        { data: { ...existing, display_name: '新しい名前' }, error: null },
      ],
    });
    const res = await PATCH(
      jsonRequest('PATCH', `http://localhost/api/super-admin/plans/${PLAN_ID}`, {
        plan_key: 'org_pro_2027',
        plan_type: 'org',
        display_name: '新しい名前',
      }),
      { params: Promise.resolve({ id: PLAN_ID }) },
    );
    expect(res.status).toBe(200);
    const updateBuilder = fakeSupabase.from.mock.results[1]?.value as { update: ReturnType<typeof vi.fn> };
    expect(updateBuilder.update).toHaveBeenCalledTimes(1);
    const updateData = updateBuilder.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateData).toMatchObject({ display_name: '新しい名前' });
    expect(Object.keys(updateData).sort()).toEqual(['display_name', 'updated_at']);
  });
});
