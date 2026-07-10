/**
 * #1041 (F4-04) 回帰防止 contract テスト
 * GET/POST /api/admin/moderation/[type]/[id]
 *
 * 検証観点:
 *  - ai_content は未サポートのため 404 (実在しない moderation_items を叩かない)
 *  - 対象が存在しない場合は 404、DB エラー時は 500 (fail-closed。以前は
 *    全エラーが 404 に丸められ、テーブル未作成時と実障害時が区別できなかった)
 *  - BAN 対象ユーザーはコンテンツ所有者 (meals.user_id) であり、
 *    フラグ行自身の user_id (通報者) を誤って BAN しないこと
 *
 * #1041 round-2 追加観点:
 *  - (A) NOT_FOUND レスポンスの body が複数リクエストで使い回されず、毎回
 *    非空の body を持つこと (module スコープ singleton ReadableStream 枯渇の回帰防止)
 *  - (D/F) 特権操作 (embed 所有者取得・status/BAN 更新) が requireRole 通過後に
 *    service-role (`getSupabaseAdmin()`) を経由すること
 *  - (D) BAN が `admin_set_user_roles` (roles=['banned']) ではなく
 *    `user_profiles.frozen_at/frozen_reason/frozen_by` を更新すること
 *    (freeze route と同じ機構)。BAN 失敗時は success:true を返さないこと
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';

const mockRequireRole = vi.fn();
const mockGetSupabaseAdmin = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { GET, POST } = await import('@/app/api/admin/moderation/[type]/[id]/route');

const adminActor = { id: 'admin-1', email: 'admin@example.com', roles: ['admin'], organization_id: null };
const superAdminActor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

/** N 回目に指定テーブルへ `.from()` された呼び出しの `.update()` 引数を取得する */
function updatePayloadForNthCall(
  fake: ReturnType<typeof createFakeSupabase>,
  table: string,
  occurrence: number,
): unknown {
  let count = 0;
  for (let i = 0; i < fake.from.mock.calls.length; i++) {
    if (fake.from.mock.calls[i][0] === table) {
      count++;
      if (count === occurrence) {
        const builder = fake.from.mock.results[i]!.value as { update: ReturnType<typeof vi.fn> };
        return builder.update.mock.calls[0]?.[0];
      }
    }
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(adminActor);
  mockGetSupabaseAdmin.mockImplementation(() => fakeSupabase);
});

describe('GET /api/admin/moderation/[type]/[id]', () => {
  it('ai_content は未サポートのため 404 (存在しないテーブルを叩かない)', async () => {
    fakeSupabase = createFakeSupabase({});
    const res = await GET(new Request('http://localhost/api/admin/moderation/ai_content/x'), {
      params: { type: 'ai_content', id: 'x' },
    });
    expect(res.status).toBe(404);
    expect(fakeSupabase.from).not.toHaveBeenCalled();
  });

  it('food: 見つからない場合は 404 (service-role 経由)', async () => {
    fakeSupabase = createFakeSupabase({ moderation_flags: [{ data: null, error: null }] });
    const res = await GET(new Request('http://localhost/api/admin/moderation/food/x'), {
      params: { type: 'food', id: 'x' },
    });
    expect(res.status).toBe(404);
    // #1041 round-2 (D/F): requireRole 通過後に service-role が使われること
    expect(mockGetSupabaseAdmin).toHaveBeenCalled();
  });

  it('food: DB エラー時は 404 ではなく 500 を返す (fail-closed)', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [{ data: null, error: { message: 'connection lost' } }],
    });
    const res = await GET(new Request('http://localhost/api/admin/moderation/food/x'), {
      params: { type: 'food', id: 'x' },
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('INTERNAL_ERROR');
  });

  it('food: 正常時は meals 由来の user_id / content_url を含めて返す', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [
        {
          data: {
            id: 'flag-1',
            status: 'pending',
            reason: null,
            resolution_note: null,
            resolved_by: null,
            resolved_at: null,
            created_at: '2026-01-01T00:00:00Z',
            user_id: 'reporter-x',
            meals: { user_id: 'owner-x', photo_url: 'https://example.com/a.jpg' },
          },
          error: null,
        },
      ],
    });
    const res = await GET(new Request('http://localhost/api/admin/moderation/food/flag-1'), {
      params: { type: 'food', id: 'flag-1' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { user_id: string; content_url: string } };
    expect(json.data.user_id).toBe('owner-x');
    expect(json.data.content_url).toBe('https://example.com/a.jpg');
  });

  it('401: 未認証', async () => {
    const { AuthError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    fakeSupabase = createFakeSupabase({});
    const res = await GET(new Request('http://localhost/api/admin/moderation/food/x'), {
      params: { type: 'food', id: 'x' },
    });
    expect(res.status).toBe(401);
    // 認可前に service-role へ切り替わってはならない (権限昇格穴の防止)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('403: 権限不足', async () => {
    const { ForbiddenError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED'));
    fakeSupabase = createFakeSupabase({});
    const res = await GET(new Request('http://localhost/api/admin/moderation/food/x'), {
      params: { type: 'food', id: 'x' },
    });
    expect(res.status).toBe(403);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('#1041 round-2 (A): NOT_FOUND body は複数リクエストで使い回さず、毎回 body を持つ (ReadableStream 枯渇の回帰防止)', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });

    const res1 = await GET(new Request('http://localhost/api/admin/moderation/food/x'), {
      params: { type: 'food', id: 'x' },
    });
    const text1 = await res1.text();
    expect(res1.status).toBe(404);
    expect(text1.length).toBeGreaterThan(0);
    expect(JSON.parse(text1).error.code).toBe('NOT_FOUND');

    const res2 = await GET(new Request('http://localhost/api/admin/moderation/food/y'), {
      params: { type: 'food', id: 'y' },
    });
    const text2 = await res2.text();
    expect(res2.status).toBe(404);
    expect(text2.length).toBeGreaterThan(0);
    expect(JSON.parse(text2).error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/admin/moderation/[type]/[id] (審査確定)', () => {
  function postRequest(body: Record<string, unknown>) {
    return new Request('http://localhost/api/admin/moderation/food/flag-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('delete_and_temp_ban: BAN 対象は meals.user_id (コンテンツ所有者) であり、フラグの user_id (通報者) ではない。frozen_at 機構で BAN する', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [
        {
          data: {
            id: 'flag-1',
            status: 'pending',
            reason: null,
            resolution_note: null,
            resolved_by: null,
            resolved_at: null,
            created_at: '2026-01-01T00:00:00Z',
            // フラグ行自身の user_id は通報者。BAN 対象にしてはならない。
            user_id: 'reporter-x',
            meals: { user_id: 'owner-x', photo_url: null },
          },
          error: null,
        },
        { data: null, error: null }, // resolveModerationItem の update
      ],
      user_profiles: [
        { data: { id: 'owner-x', roles: ['user'] }, error: null }, // applyUserBan: 存在確認
        { data: null, error: null }, // applyUserBan: frozen_at 更新
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await POST(
      postRequest({ action: 'delete_and_temp_ban', ban_duration_days: 7, resolution_note: 'bad content' }),
      { params: { type: 'food', id: 'flag-1' } },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { success: boolean; ban_applied: boolean } };
    expect(json.data.success).toBe(true);
    expect(json.data.ban_applied).toBe(true);

    // #1041 round-2 (D): 'banned' roles RPC はもう使わない
    expect(fakeSupabase.rpc).not.toHaveBeenCalled();

    // #1041 round-2 (D): frozen_at/frozen_reason/frozen_by を更新し、roles には触れないこと
    const updatePayload = updatePayloadForNthCall(fakeSupabase, 'user_profiles', 2) as Record<string, unknown>;
    expect(updatePayload).toBeTruthy();
    expect(updatePayload.frozen_at).toEqual(expect.any(String));
    expect(updatePayload.frozen_by).toBe('admin-1');
    expect(updatePayload).not.toHaveProperty('roles');

    // #1041 round-2 (D/F): service-role を使うこと
    expect(mockGetSupabaseAdmin).toHaveBeenCalled();
  });

  it('#1041 round-2 (D): BAN 適用 (frozen_at 更新) が失敗した場合、success:true を返さない', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [
        {
          data: {
            id: 'flag-1',
            status: 'pending',
            reason: null,
            resolution_note: null,
            resolved_by: null,
            resolved_at: null,
            created_at: '2026-01-01T00:00:00Z',
            user_id: 'reporter-x',
            meals: { user_id: 'owner-x', photo_url: null },
          },
          error: null,
        },
        { data: null, error: null },
      ],
      user_profiles: [
        { data: { id: 'owner-x', roles: ['user'] }, error: null },
        { data: null, error: { message: 'update failed' } }, // frozen_at 更新失敗
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await POST(postRequest({ action: 'delete_and_temp_ban', ban_duration_days: 7 }), {
      params: { type: 'food', id: 'flag-1' },
    });

    expect(res.status).not.toBe(200);
    const json = (await res.json()) as { error: { code: string }; data: { ban_applied: boolean } };
    expect(json.error.code).toBe('OP_BAN_FAILED');
    expect(json.data.ban_applied).toBe(false);
  });

  it('ban_duration_days なしで delete_and_temp_ban は 400', async () => {
    fakeSupabase = createFakeSupabase({});
    const res = await POST(postRequest({ action: 'delete_and_temp_ban' }), {
      params: { type: 'food', id: 'flag-1' },
    });
    expect(res.status).toBe(400);
  });

  it('delete_and_perm_ban は super_admin 以外だと 403', async () => {
    mockRequireRole.mockResolvedValue(adminActor); // admin (not super_admin)
    fakeSupabase = createFakeSupabase({});
    const res = await POST(postRequest({ action: 'delete_and_perm_ban' }), {
      params: { type: 'food', id: 'flag-1' },
    });
    expect(res.status).toBe(403);
  });

  it('delete_and_perm_ban は super_admin なら許可される (frozen_at, unbanAt なし)', async () => {
    mockRequireRole.mockResolvedValue(superAdminActor);
    fakeSupabase = createFakeSupabase({
      moderation_flags: [
        {
          data: {
            id: 'flag-1',
            status: 'pending',
            reason: null,
            resolution_note: null,
            resolved_by: null,
            resolved_at: null,
            created_at: '2026-01-01T00:00:00Z',
            user_id: 'reporter-y',
            meals: { user_id: 'owner-y', photo_url: null },
          },
          error: null,
        },
        { data: null, error: null },
      ],
      user_profiles: [
        { data: { id: 'owner-y', roles: ['user'] }, error: null },
        { data: null, error: null },
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await POST(postRequest({ action: 'delete_and_perm_ban' }), {
      params: { type: 'food', id: 'flag-1' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { ban_applied: boolean } };
    expect(json.data.ban_applied).toBe(true);
    expect(fakeSupabase.rpc).not.toHaveBeenCalled();
  });

  it('super_admin を BAN しようとした場合は失敗する (frozen_at 更新は実行しない)', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [
        {
          data: {
            id: 'flag-1',
            status: 'pending',
            reason: null,
            resolution_note: null,
            resolved_by: null,
            resolved_at: null,
            created_at: '2026-01-01T00:00:00Z',
            user_id: 'reporter-z',
            meals: { user_id: 'owner-super', photo_url: null },
          },
          error: null,
        },
        { data: null, error: null },
      ],
      user_profiles: [{ data: { id: 'owner-super', roles: ['user', 'super_admin'] }, error: null }],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await POST(postRequest({ action: 'delete_and_temp_ban', ban_duration_days: 3 }), {
      params: { type: 'food', id: 'flag-1' },
    });
    expect(res.status).not.toBe(200);
    const json = (await res.json()) as { data: { ban_applied: boolean } };
    expect(json.data.ban_applied).toBe(false);
  });

  it('ai_content への POST は 404', async () => {
    fakeSupabase = createFakeSupabase({});
    const req = new Request('http://localhost/api/admin/moderation/ai_content/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    const res = await POST(req, { params: { type: 'ai_content', id: 'x' } });
    expect(res.status).toBe(404);
  });

  it('対象が見つからない場合は 404', async () => {
    fakeSupabase = createFakeSupabase({ moderation_flags: [{ data: null, error: null }] });
    const res = await POST(postRequest({ action: 'approve' }), { params: { type: 'food', id: 'missing' } });
    expect(res.status).toBe(404);
  });
});
