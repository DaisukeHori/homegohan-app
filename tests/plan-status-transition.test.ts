/**
 * #1041 (プラン状態遷移一方向ロック) 回帰防止テスト
 *
 *  1. src/lib/super-admin/plans-schemas.ts の isAllowedPlanStatusTransition ユニットテスト
 *  2. PATCH /api/super-admin/plans/[id] contract テスト
 *     — 従来は public/private 到達後 status キー自体が恒久的に disallowedKeys
 *       扱いとなり、publish/unpublish/deprecate が一切できなくなっていた。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAN_STATUSES,
  PLAN_UPDATE_FIELD_LABELS,
  PlanUpdateSchema,
  isAllowedPlanStatusTransition,
  planStatusLockedFieldsMessage,
  planStatusTransitionMessage,
} from '@/lib/super-admin/plans-schemas';
import { englishIdentifiersOutsideParentheses } from './helpers/api-error-text-scan';
import { createFakeSupabase } from './helpers/fake-supabase';
import { createFakePlanSubscribersDb } from './helpers/fake-plan-subscribers-db';

/** route は UUID の形でない id を DB に渡さず 404 にする (#1917) ので、id は UUID の形にする */
const PLAN_ID = '88888888-8888-4888-8888-888888888882';

describe('isAllowedPlanStatusTransition', () => {
  it('draft --> public / private を許可する', () => {
    expect(isAllowedPlanStatusTransition('draft', 'public')).toBe(true);
    expect(isAllowedPlanStatusTransition('draft', 'private')).toBe(true);
  });

  it('public <--> private のトグルを許可する', () => {
    expect(isAllowedPlanStatusTransition('public', 'private')).toBe(true);
    expect(isAllowedPlanStatusTransition('private', 'public')).toBe(true);
  });

  it('public / private --> deprecated (廃止) を許可する', () => {
    expect(isAllowedPlanStatusTransition('public', 'deprecated')).toBe(true);
    expect(isAllowedPlanStatusTransition('private', 'deprecated')).toBe(true);
  });

  it('deprecated --> private (緊急ロールバック) のみ許可し、public へは戻さない', () => {
    expect(isAllowedPlanStatusTransition('deprecated', 'private')).toBe(true);
    expect(isAllowedPlanStatusTransition('deprecated', 'public')).toBe(false);
  });

  it('draft --> deprecated は許可しない', () => {
    expect(isAllowedPlanStatusTransition('draft', 'deprecated')).toBe(false);
  });

  it('同一ステータスへの遷移は許可扱い (no-op)', () => {
    expect(isAllowedPlanStatusTransition('public', 'public')).toBe(true);
  });
});

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  // #1127: 廃止 (--> deprecated) の前に、service_role で契約者数を数えるようになった。
  // このファイルが確かめるのは状態遷移の規則なので、契約者のいない DB を渡す
  // (契約者がいるときの動きは tests/plan-deprecate-subscribers-route.test.ts)
  // プランの更新 (subscription_plans) も service_role の client で書く (運営の直接の書き込みを塞いだ。#1917 の続き)。
  // プランの行は本人のセッションの読み取りと同じ代わりの DB (fakeSupabase) の順の結果を使う
  getSupabaseAdmin: () => {
    const subscribers = createFakePlanSubscribersDb().client;
    return { from: (table: string) => (table === 'subscription_plans' ? fakeSupabase.from(table) : subscribers.from(table)) };
  },
}));

const { PATCH } = await import('@/app/api/super-admin/plans/[id]/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

function patchRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/super-admin/plans/${PLAN_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function existingPlan(overrides: Record<string, unknown>) {
  return {
    id: PLAN_ID,
    plan_key: 'pro',
    display_name: 'Pro',
    plan_type: 'personal',
    status: 'public',
    ends_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
});

describe('PATCH /api/super-admin/plans/[id] (#1041 状態遷移一方向ロック修正)', () => {
  it('public --> private のトグルは 200 で成功する (旧: 422 で恒久ロック)', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [
        { data: existingPlan({ status: 'public' }), error: null },
        { data: existingPlan({ status: 'private' }), error: null },
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await PATCH(patchRequest({ status: 'private' }), { params: { id: PLAN_ID } });
    expect(res.status).toBe(200);
  });

  it('private --> public の再公開は 200 で成功する', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [
        { data: existingPlan({ status: 'private' }), error: null },
        { data: existingPlan({ status: 'public' }), error: null },
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await PATCH(patchRequest({ status: 'public' }), { params: { id: PLAN_ID } });
    expect(res.status).toBe(200);
  });

  it('public --> deprecated は ends_at 指定があれば 200 で成功する', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [
        { data: existingPlan({ status: 'public' }), error: null },
        { data: existingPlan({ status: 'deprecated' }), error: null },
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await PATCH(
      patchRequest({ status: 'deprecated', ends_at: '2027-01-01T00:00:00.000Z' }),
      { params: { id: PLAN_ID } },
    );
    expect(res.status).toBe(200);
  });

  it('public --> deprecated で ends_at 未指定なら 400 (廃止予定日必須)', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'public', ends_at: null }), error: null }],
    });

    const res = await PATCH(patchRequest({ status: 'deprecated' }), { params: { id: PLAN_ID } });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_DEPRECATE_ENDS_AT_REQUIRED');
  });

  it('deprecated --> public は許可されない遷移として 422', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'deprecated' }), error: null }],
    });

    const res = await PATCH(patchRequest({ status: 'public' }), { params: { id: PLAN_ID } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('OP_PLAN_INVALID_TRANSITION');
    // 状態の値は「画面の名前 (値)」の形で括弧の中 (運営の画面 (plans/[id]/page.tsx) は message をそのまま alert に出す。#1917 の続き)
    expect(json.error.message).toBe('プランの状態を 廃止 (deprecated) から 公開中 (public) へ変えることはできません');
    expect(englishIdentifiersOutsideParentheses(json.error.message)).toEqual([]);
  });

  it('deprecated --> private (un-deprecate) は許可される', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [
        { data: existingPlan({ status: 'deprecated' }), error: null },
        { data: existingPlan({ status: 'private' }), error: null },
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await PATCH(patchRequest({ status: 'private' }), { params: { id: PLAN_ID } });
    expect(res.status).toBe(200);
  });

  it('public 中に status 以外の価格系フィールドを変更しようとすると引き続き 422 (price-change API 誘導)', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'public' }), error: null }],
    });

    const res = await PATCH(patchRequest({ stripe_product_id: 'prod_x' }), { params: { id: PLAN_ID } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_STATUS_LOCKED');
  });

  it('公開中のプランで変えられない項目を送ると、項目名を「画面の名前 (項目名)」の形で括弧に入れた文を返す (#1917 の続き)', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'public' }), error: null }],
    });

    const res = await PATCH(patchRequest({ trial_days: 7, max_members: 10 }), { params: { id: PLAN_ID } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('OP_PLAN_STATUS_LOCKED');
    expect(json.error.message).toBe(
      '公開中・非公開のプランでは、次の項目は変更できません: メンバーの数の上限 (max_members)、試用の日数 (trial_days)。価格の変更は price-change API を使ってください。',
    );
    expect(englishIdentifiersOutsideParentheses(json.error.message)).toEqual([]);
  });

  it('deprecated 中に status 以外を変更しようとすると 422 (廃止済みロック)', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'deprecated' }), error: null }],
    });

    const res = await PATCH(patchRequest({ display_name: 'New Name' }), { params: { id: PLAN_ID } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_DEPRECATED_LOCKED');
  });
});

describe('プランの状態・項目の失敗の文 (#1917 の続き: 英字の値・項目名を括弧の外に出さない)', () => {
  it('全部の状態の組み合わせの遷移の文に、括弧の外の英字が無い', () => {
    for (const from of PLAN_STATUSES) {
      for (const to of PLAN_STATUSES) {
        const message = planStatusTransitionMessage(from, to);
        expect(englishIdentifiersOutsideParentheses(message), message).toEqual([]);
        expect(message).toContain(`(${from})`);
        expect(message).toContain(`(${to})`);
      }
    }
  });

  it('表に無い状態の値も括弧の中に入れる', () => {
    const message = planStatusTransitionMessage('archived_x', 'public');
    expect(message).toBe('プランの状態を 不明な状態 (archived_x) から 公開中 (public) へ変えることはできません');
    expect(englishIdentifiersOutsideParentheses(message)).toEqual([]);
  });

  it('更新の項目の名前の表は PlanUpdateSchema の全部の項目を持ち、全部の項目の文に括弧の外の英字が無い', () => {
    const keys = Object.keys(PlanUpdateSchema.shape).sort();
    expect(Object.keys(PLAN_UPDATE_FIELD_LABELS).sort()).toEqual(keys);
    const message = planStatusLockedFieldsMessage(keys);
    expect(englishIdentifiersOutsideParentheses(message), message).toEqual([]);
    for (const key of keys) expect(message).toContain(`${PLAN_UPDATE_FIELD_LABELS[key as keyof typeof PLAN_UPDATE_FIELD_LABELS]} (${key})`);
  });

  it('表に無い項目名も括弧の中に入れる', () => {
    const message = planStatusLockedFieldsMessage(['unknown_field']);
    expect(message).toContain('項目 (unknown_field)');
    expect(englishIdentifiersOutsideParentheses(message)).toEqual([]);
  });
});
