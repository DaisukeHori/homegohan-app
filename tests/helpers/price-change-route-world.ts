/**
 * POST /api/super-admin/plans/[id]/price-change の単体テストの道具 (#1917)
 *
 * route は予約 (begin_plan_price_change) → Stripe の同期 (Edge Function) → 履歴と価格の書き込み (apply_plan_price_change) →
 * 監査 (admin_audit_logs) の順に動き、apply まで行かなかったときは予約を消す (release_plan_price_change)。
 * ここでは DB の関数を名前ごとの結果で返す偽の client と、本文・Edge Function の応答の組み立てを持つ。
 * DB の関数の中身 (ロック・履歴の old_*) は tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts が実 DB で確かめる。
 */
import { vi } from 'vitest';
import { createFakeSupabase, type FakeQueryResult, type FakeSupabase } from './fake-supabase';
import { PLAN_PRICE_CHANGE_RPC } from '@/lib/super-admin/plan-price-change-reservation';

/** route は UUID の形でない id を DB に渡さず 404 にする (#1917) ので、id は UUID の形にする */
export const PLAN_ID = '88888888-8888-4888-8888-888888888883';
export const RESERVATION_TOKEN = '11111111-1111-4111-8111-111111111111';
export const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

/** begin がロックの下で読んで返すプランの値 (src/lib/super-admin/plan-price-change-reservation.ts の ReservedPlan と同じ形) */
export interface ExistingPlan {
  id: string;
  plan_key: string;
  status: string;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_yearly_price_id: string | null;
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
}

export function existingPlan(): ExistingPlan {
  return {
    id: PLAN_ID,
    plan_key: 'pro',
    status: 'public',
    stripe_product_id: 'prod_123',
    // 月額の Price ID (#1102: stripe_price_id は月額)
    stripe_price_id: 'price_old',
    // 年額の Price ID (#1102)
    stripe_yearly_price_id: 'price_year_old',
    monthly_price_jpy: 1000,
    yearly_price_jpy: 10000,
  };
}

/** begin の結果: 予約できた */
export function reserved(plan: ExistingPlan = existingPlan()): FakeQueryResult {
  return { data: { result: 'reserved', token: RESERVATION_TOKEN, plan }, error: null };
}

/** apply の結果: 書けた (previous は apply がロックの下で読んだ、この更新の直前の値) */
export function applied(previous: Partial<ExistingPlan> = {}): FakeQueryResult {
  const plan = { ...existingPlan(), ...previous };
  return {
    data: {
      result: 'applied',
      previous: {
        monthly_price_jpy: plan.monthly_price_jpy,
        yearly_price_jpy: plan.yearly_price_jpy,
        stripe_price_id: plan.stripe_price_id,
        stripe_yearly_price_id: plan.stripe_yearly_price_id,
      },
    },
    error: null,
  };
}

export interface RpcScenario {
  begin?: FakeQueryResult;
  apply?: FakeQueryResult;
  release?: FakeQueryResult;
}

/**
 * DB の関数を名前で答える偽の client (createClient と getSupabaseAdmin の両方に使う)。
 * 監査ログ (admin_audit_logs) の INSERT は from で受ける
 */
export function priceChangeSupabase(scenario: RpcScenario = {}, auditResult: FakeQueryResult = { data: null, error: null }): FakeSupabase {
  const fake = createFakeSupabase({ admin_audit_logs: [auditResult] });
  fake.rpc = vi.fn((fn: string) => {
    if (fn === PLAN_PRICE_CHANGE_RPC.begin) return Promise.resolve(scenario.begin ?? reserved());
    if (fn === PLAN_PRICE_CHANGE_RPC.apply) return Promise.resolve(scenario.apply ?? applied());
    if (fn === PLAN_PRICE_CHANGE_RPC.release) return Promise.resolve(scenario.release ?? { data: true, error: null });
    return Promise.reject(new Error(`price-change-route-world: 知らない DB の関数 ${fn}`));
  });
  return fake;
}

/** 名前の DB の関数に渡した引数 (呼んだ順) */
export function rpcArgs(fake: FakeSupabase, fn: string): Array<Record<string, unknown>> {
  return fake.rpc.mock.calls.filter((call) => call[0] === fn).map((call) => call[1] as Record<string, unknown>);
}

/** DB の関数を呼んだ順の名前 */
export function rpcOrder(fake: FakeSupabase): string[] {
  return fake.rpc.mock.calls.map((call) => String(call[0]));
}

/** apply に渡した引数 (1 回目。呼ばれていなければ undefined) */
export function applyArgs(fake: FakeSupabase): Record<string, unknown> | undefined {
  return rpcArgs(fake, PLAN_PRICE_CHANGE_RPC.apply)[0];
}

/** 監査ログの INSERT の引数 (1 回目。呼ばれていなければ undefined) */
export function auditLogInsertPayload(fake: FakeSupabase): Record<string, unknown> | undefined {
  for (let i = 0; i < fake.from.mock.calls.length; i++) {
    if (fake.from.mock.calls[i]![0] !== 'admin_audit_logs') continue;
    const builder = fake.from.mock.results[i]!.value as { insert: ReturnType<typeof vi.fn> };
    if (builder.insert.mock.calls.length > 0) return builder.insert.mock.calls[0]![0] as Record<string, unknown>;
  }
  return undefined;
}

/** 監査ログの details */
export function auditDetails(fake: FakeSupabase): Record<string, unknown> | undefined {
  return auditLogInsertPayload(fake)?.details as Record<string, unknown> | undefined;
}

export function priceChangeRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/super-admin/plans/${PLAN_ID}/price-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      new_monthly_price_jpy: 1200,
      applies_to: 'new_only',
      reason: 'price update',
      effective_at: '2026-08-01T00:00:00.000Z',
      ...body,
    }),
  }) as never;
}

/** Edge Function (stripe-price-sync) の 200 応答。{ month, year } を返す (変えなかった interval は null) */
export function edgeOk(body: { month?: unknown; year?: unknown }) {
  return {
    ok: true,
    json: () => Promise.resolve({ success: true, month: null, year: null, ...body }),
  };
}

export function stubEdge(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Edge Function へ送ったリクエストボディ */
export function edgeRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}
