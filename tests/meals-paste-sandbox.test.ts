/**
 * #1627 POST /api/meals/paste — ハンズオンのお試しの記録は、家族に貼り付けられない
 *
 * お試しの記録 (meals.is_sandbox = true。#1604 から add-from-photo が作り、応答で mealId を返す) を家族に貼ると、
 * paste_meal_to_family は is_sandbox を写さないので、家族の側では本物の記録 (is_sandbox = false) になってしまう。
 * DB の paste_meal_to_family が RAISE EXCEPTION 'MEAL_SANDBOX' で拒否し (migration 20261015100000)、
 * この route は 403 MEAL_SANDBOX を返す。実 DB での拒否は tests/integration/rls/paste-meal-sandbox.test.ts。
 */
import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';
import { MembershipErrorCode, mapPgErrorToHttp, membershipErrorMessage } from '@/lib/errors/membership-errors';

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
}));

const { POST } = await import('@/app/api/meals/paste/route');

const SOURCE_MEAL_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222';

function pasteRequest() {
  return new Request('http://localhost/api/meals/paste', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_meal_id: SOURCE_MEAL_ID, target_user_ids: [TARGET_USER_ID] }),
  });
}

function withRpcResult(result: { data?: unknown; error?: unknown }) {
  fakeSupabase = createFakeSupabase({}, [result]);
  fakeSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
}

describe('POST /api/meals/paste — お試しの記録 (#1627)', () => {
  it('DB が MEAL_SANDBOX で拒否したら 403 MEAL_SANDBOX。貼り付けた (200) ように見せない', async () => {
    withRpcResult({ data: null, error: { message: 'MEAL_SANDBOX', code: 'P0001' } });

    const res = await POST(pasteRequest());
    const json = (await res.json()) as { error: { code: string; message: string }; data?: unknown };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('MEAL_SANDBOX');
    expect(json.error.message).toContain('お試しの記録');
    expect(json).not.toHaveProperty('data');
    expect(fakeSupabase.rpc).toHaveBeenCalledWith('paste_meal_to_family', {
      p_source_meal_id: SOURCE_MEAL_ID,
      p_target_user_ids: [TARGET_USER_ID],
    });
  });

  it('隠した食事 (MEAL_HIDDEN) は従来どおり MEAL_HIDDEN。MEAL_SANDBOX に化けない', async () => {
    withRpcResult({ data: null, error: { message: 'MEAL_HIDDEN', code: 'P0001' } });

    const res = await POST(pasteRequest());
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe(MembershipErrorCode.MEAL_HIDDEN);
  });

  it('持ち主でない (NOT_MEAL_OWNER) は従来どおり INSUFFICIENT_PERMISSION。MEAL_SANDBOX に化けない', async () => {
    withRpcResult({ data: null, error: { message: 'NOT_MEAL_OWNER', code: 'P0001' } });

    const res = await POST(pasteRequest());
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe(MembershipErrorCode.INSUFFICIENT_PERMISSION);
  });

  it('お試しでない食事は従来どおり 200 で paste_group_id を返す', async () => {
    const groupId = '33333333-3333-4333-8333-333333333333';
    withRpcResult({ data: groupId, error: null });

    const res = await POST(pasteRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { paste_group_id: groupId, inserted_count: 1 } });
  });

  it('mapPgErrorToHttp でも MEAL_SANDBOX は 403 に解決し、画面の文はコードそのものでない日本語', () => {
    expect(mapPgErrorToHttp('MEAL_SANDBOX')).toEqual({ code: MembershipErrorCode.MEAL_SANDBOX, status: 403 });
    expect(mapPgErrorToHttp('ERROR: MEAL_SANDBOX', 'P0001')).toEqual({ code: MembershipErrorCode.MEAL_SANDBOX, status: 403 });
    const text = membershipErrorMessage(MembershipErrorCode.MEAL_SANDBOX);
    expect(text).toContain('お試しの記録');
    expect(text).not.toContain('MEAL_SANDBOX');
  });
});
