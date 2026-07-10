/**
 * #1041 (プラン状態遷移一方向ロック) 回帰防止テスト
 *
 *  1. src/lib/super-admin/plans-schemas.ts の isAllowedPlanStatusTransition ユニットテスト
 *  2. PATCH /api/super-admin/plans/[id] contract テスト
 *     — 従来は public/private 到達後 status キー自体が恒久的に disallowedKeys
 *       扱いとなり、publish/unpublish/deprecate が一切できなくなっていた。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedPlanStatusTransition } from '@/lib/super-admin/plans-schemas';
import { createFakeSupabase } from './helpers/fake-supabase';

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
}));

const { PATCH } = await import('@/app/api/super-admin/plans/[id]/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

function patchRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/super-admin/plans/plan-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function existingPlan(overrides: Record<string, unknown>) {
  return {
    id: 'plan-1',
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

    const res = await PATCH(patchRequest({ status: 'private' }), { params: { id: 'plan-1' } });
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

    const res = await PATCH(patchRequest({ status: 'public' }), { params: { id: 'plan-1' } });
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
      { params: { id: 'plan-1' } },
    );
    expect(res.status).toBe(200);
  });

  it('public --> deprecated で ends_at 未指定なら 400 (廃止予定日必須)', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'public', ends_at: null }), error: null }],
    });

    const res = await PATCH(patchRequest({ status: 'deprecated' }), { params: { id: 'plan-1' } });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_DEPRECATE_ENDS_AT_REQUIRED');
  });

  it('deprecated --> public は許可されない遷移として 422', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'deprecated' }), error: null }],
    });

    const res = await PATCH(patchRequest({ status: 'public' }), { params: { id: 'plan-1' } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_INVALID_TRANSITION');
  });

  it('deprecated --> private (un-deprecate) は許可される', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [
        { data: existingPlan({ status: 'deprecated' }), error: null },
        { data: existingPlan({ status: 'private' }), error: null },
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await PATCH(patchRequest({ status: 'private' }), { params: { id: 'plan-1' } });
    expect(res.status).toBe(200);
  });

  it('public 中に status 以外の価格系フィールドを変更しようとすると引き続き 422 (price-change API 誘導)', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'public' }), error: null }],
    });

    const res = await PATCH(patchRequest({ stripe_product_id: 'prod_x' }), { params: { id: 'plan-1' } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_STATUS_LOCKED');
  });

  it('deprecated 中に status 以外を変更しようとすると 422 (廃止済みロック)', async () => {
    fakeSupabase = createFakeSupabase({
      subscription_plans: [{ data: existingPlan({ status: 'deprecated' }), error: null }],
    });

    const res = await PATCH(patchRequest({ display_name: 'New Name' }), { params: { id: 'plan-1' } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_DEPRECATED_LOCKED');
  });
});
