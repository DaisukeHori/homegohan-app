/**
 * #1101 POST /api/meals/paste — 運営が隠した食事は、家族に貼り付けられない
 *
 * 運営のモデレーションで「削除」(= 隠す) された食事を、持ち主が家族に貼り付け直すと、
 * 写した新しい行 (家族のメンバーの持ち物) は隠れていないので、隠した内容が家族に見え直してしまう。
 * DB の paste_meal_to_family が RAISE EXCEPTION 'MEAL_HIDDEN' で拒否し (migration 20261008200500)、
 * この route は 403 MEAL_HIDDEN を返す。実 DB での拒否は tests/integration/rls/hidden-content-visibility.test.ts (F)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';

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

describe('POST /api/meals/paste — 隠された食事 (#1101)', () => {
  beforeEach(() => {
    withRpcResult({ data: null, error: null });
  });

  it('DB が MEAL_HIDDEN で拒否したら 403 MEAL_HIDDEN。貼り付けた (200) ように見せない', async () => {
    withRpcResult({ data: null, error: { message: 'MEAL_HIDDEN', code: 'P0001' } });

    const res = await POST(pasteRequest());
    const json = (await res.json()) as { error: { code: string; message: string }; data?: unknown };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('MEAL_HIDDEN');
    expect(json.error.message).toContain('運営により非表示');
    expect(json).not.toHaveProperty('data');
    expect(fakeSupabase.rpc).toHaveBeenCalledWith('paste_meal_to_family', {
      p_source_meal_id: SOURCE_MEAL_ID,
      p_target_user_ids: [TARGET_USER_ID],
    });
  });

  it('持ち主でない (NOT_MEAL_OWNER) は従来どおり INSUFFICIENT_PERMISSION。MEAL_HIDDEN に化けない', async () => {
    withRpcResult({ data: null, error: { message: 'NOT_MEAL_OWNER', code: 'P0001' } });

    const res = await POST(pasteRequest());
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe(MembershipErrorCode.INSUFFICIENT_PERMISSION);
  });

  it('隠れていない食事は従来どおり 200 で paste_group_id を返す', async () => {
    const groupId = '33333333-3333-4333-8333-333333333333';
    withRpcResult({ data: groupId, error: null });

    const res = await POST(pasteRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { paste_group_id: groupId, inserted_count: 1 } });
  });

  it('mapPgErrorToHttp でも MEAL_HIDDEN は 403 に解決する (ほかの route がメッセージ照合だけで扱っても 500 にならない)', () => {
    expect(mapPgErrorToHttp('MEAL_HIDDEN')).toEqual({ code: MembershipErrorCode.MEAL_HIDDEN, status: 403 });
  });
});
