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
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
}));

const { GET, POST } = await import('@/app/api/admin/moderation/[type]/[id]/route');

const adminActor = { id: 'admin-1', email: 'admin@example.com', roles: ['admin'], organization_id: null };
const superAdminActor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(adminActor);
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

  it('food: 見つからない場合は 404', async () => {
    fakeSupabase = createFakeSupabase({ moderation_flags: [{ data: null, error: null }] });
    const res = await GET(new Request('http://localhost/api/admin/moderation/food/x'), {
      params: { type: 'food', id: 'x' },
    });
    expect(res.status).toBe(404);
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
  });

  it('403: 権限不足', async () => {
    const { ForbiddenError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED'));
    fakeSupabase = createFakeSupabase({});
    const res = await GET(new Request('http://localhost/api/admin/moderation/food/x'), {
      params: { type: 'food', id: 'x' },
    });
    expect(res.status).toBe(403);
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

  it('delete_and_temp_ban: BAN 対象は meals.user_id (コンテンツ所有者) であり、フラグの user_id (通報者) ではない', async () => {
    fakeSupabase = createFakeSupabase(
      {
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
        user_profiles: [{ data: { roles: ['user'] }, error: null }],
        admin_audit_logs: [{ data: null, error: null }],
      },
      [{ data: null, error: null }], // admin_set_user_roles rpc
    );

    const res = await POST(
      postRequest({ action: 'delete_and_temp_ban', ban_duration_days: 7, resolution_note: 'bad content' }),
      { params: { type: 'food', id: 'flag-1' } },
    );

    expect(res.status).toBe(200);
    expect(fakeSupabase.rpc).toHaveBeenCalledWith(
      'admin_set_user_roles',
      expect.objectContaining({ p_user_id: 'owner-x' }),
    );
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

  it('delete_and_perm_ban は super_admin なら許可される', async () => {
    mockRequireRole.mockResolvedValue(superAdminActor);
    fakeSupabase = createFakeSupabase(
      {
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
        user_profiles: [{ data: { roles: ['user'] }, error: null }],
        admin_audit_logs: [{ data: null, error: null }],
      },
      [{ data: null, error: null }],
    );

    const res = await POST(postRequest({ action: 'delete_and_perm_ban' }), {
      params: { type: 'food', id: 'flag-1' },
    });
    expect(res.status).toBe(200);
    expect(fakeSupabase.rpc).toHaveBeenCalledWith(
      'admin_set_user_roles',
      expect.objectContaining({ p_user_id: 'owner-y' }),
    );
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
