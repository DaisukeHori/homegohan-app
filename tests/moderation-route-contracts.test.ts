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
 *
 * #1101 追加観点 (「削除」は行を消さずに隠す):
 *  - delete_* アクション (delete_only / delete_and_warn / delete_and_temp_ban / delete_and_perm_ban) は、
 *    通報されたコンテンツ (meals / recipes) に hidden_at / hidden_by / hidden_reason を書く。
 *    approve / escalate は何も隠さない
 *  - 隠すのは判定の保存のあと・BAN の前。隠せなかったら BAN せず 500 OP_CONTENT_HIDE_FAILED
 *    (成功を装わない。DB の生のエラー文は本文に出さない)
 *  - 通報にコンテンツが紐づかない (content_id が null) ときは、隠さずに続行する
 *  - 監査ログの details に content_id と hidden を記録する
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';

const mockRequireRole = vi.fn();
const mockGetSupabaseAdmin = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

// 構造化ログ (app_logs への書き込み) は呼ばれたことだけ確かめる
vi.mock('@/lib/db-logger', () => ({
  generateRequestId: () => 'req-test',
  createLogger: () => ({
    withUser: () => ({
      error: (...args: unknown[]) => mockLoggerError(...args),
    }),
  }),
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

type QueryBuilderMock = {
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
};

/** 指定テーブルへの `.from()` 呼び出しの、クエリビルダー (呼び出し順) */
function buildersFor(fake: ReturnType<typeof createFakeSupabase>, table: string): QueryBuilderMock[] {
  const builders: QueryBuilderMock[] = [];
  fake.from.mock.calls.forEach((call, i) => {
    if (call[0] === table) builders.push(fake.from.mock.results[i]!.value as QueryBuilderMock);
  });
  return builders;
}

/** 指定テーブルを `.from()` した呼び出しが、全体の何番目か (呼び出し順の比較用)。無ければ -1 */
function firstCallIndex(fake: ReturnType<typeof createFakeSupabase>, table: string): number {
  return fake.from.mock.calls.findIndex((call) => call[0] === table);
}

/** 監査ログ (admin_audit_logs) に INSERT された行 */
function auditInsertPayload(fake: ReturnType<typeof createFakeSupabase>) {
  const [builder] = buildersFor(fake, 'admin_audit_logs');
  expect(builder, 'admin_audit_logs に INSERT されていない').toBeDefined();
  return builder.insert.mock.calls[0]?.[0] as { severity: string; details: Record<string, unknown> };
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
            meal_id: 'meal-1',
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
    const json = (await res.json()) as { data: { user_id: string; content_url: string; content_id: string } };
    expect(json.data.user_id).toBe('owner-x');
    expect(json.data.content_url).toBe('https://example.com/a.jpg');
    // #1101: 隠す対象のコンテンツ本体の ID (通報の ID ではない)
    expect(json.data.content_id).toBe('meal-1');
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
            meal_id: 'meal-1',
            meals: { user_id: 'owner-x', photo_url: null },
          },
          error: null,
        },
        { data: null, error: null }, // resolveModerationItem の update
      ],
      meals: [{ data: null, error: null }], // hideModeratedContent の update (#1101)
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

    // #1101: コンテンツは BAN より先に隠す
    expect(firstCallIndex(fakeSupabase, 'meals')).toBeGreaterThanOrEqual(0);
    expect(firstCallIndex(fakeSupabase, 'meals')).toBeLessThan(firstCallIndex(fakeSupabase, 'user_profiles'));

    // #1041 round-2 (D): 'banned' roles RPC はもう使わない
    expect(fakeSupabase.rpc).not.toHaveBeenCalled();

    // #1041 round-2 (D): frozen_at/frozen_reason/frozen_by を更新し、roles には触れないこと
    const updatePayload = updatePayloadForNthCall(fakeSupabase, 'user_profiles', 2) as Record<string, unknown>;
    expect(updatePayload).toBeTruthy();
    expect(updatePayload.frozen_at).toEqual(expect.any(String));
    expect(updatePayload.frozen_by).toBe('admin-1');
    expect(updatePayload).not.toHaveProperty('roles');
    // #1030: unban_at も user_profiles に永続化されること (判定時比較による自動解除のため)
    expect(updatePayload.unban_at).toEqual(expect.any(String));

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

  // #1041 round-3 (W1): unbanAt の監査ログ欠落
  it('#1041 round-3 (W1): delete_and_temp_ban 成功時、unbanAt が admin_audit_logs.details.unban_at に記録される', async () => {
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
        { data: null, error: null },
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await POST(
      postRequest({ action: 'delete_and_temp_ban', ban_duration_days: 7, resolution_note: 'bad content' }),
      { params: { type: 'food', id: 'flag-1' } },
    );

    expect(res.status).toBe(200);

    const auditCallIndex = fakeSupabase.from.mock.calls.findIndex((c) => c[0] === 'admin_audit_logs');
    expect(auditCallIndex).toBeGreaterThanOrEqual(0);
    const auditBuilder = fakeSupabase.from.mock.results[auditCallIndex]!.value as { insert: ReturnType<typeof vi.fn> };
    const insertPayload = auditBuilder.insert.mock.calls[0]?.[0] as { details: Record<string, unknown> };
    expect(insertPayload.details.unban_at).toEqual(expect.any(String));
  });

  // #1041 round-3 (W2): orphan 所有者時の BAN skip 偽成功
  it('#1041 round-3 (W2): delete_and_temp_ban でコンテンツ所有者が特定できない (meals が null) 場合、422 OP_BAN_TARGET_UNRESOLVED を返す (200 偽成功にしない)', async () => {
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
            user_id: 'reporter-orphan',
            meals: null, // コンテンツ (meal) が削除済み等で所有者を特定できない
          },
          error: null,
        },
        { data: null, error: null }, // resolveModerationItem の update
      ],
      admin_audit_logs: [{ data: null, error: null }],
    });

    const res = await POST(
      postRequest({ action: 'delete_and_temp_ban', ban_duration_days: 7, resolution_note: 'orphan content' }),
      { params: { type: 'food', id: 'flag-1' } },
    );

    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string }; data: { status: string; ban_applied: boolean | null } };
    expect(json.error.code).toBe('OP_BAN_TARGET_UNRESOLVED');
    expect(json.data.ban_applied).toBeNull();
    // モデレーション判定 (status 更新) 自体は保存されている
    expect(json.data.status).toBe('rejected');

    // user_profiles (applyUserBan) には一切触れないこと (所有者不明のため BAN を試みない)
    expect(fakeSupabase.from.mock.calls.some((c) => c[0] === 'user_profiles')).toBe(false);
  });
});

// ─── #1101: delete_* は通報されたコンテンツを「隠す」(行を消さない) ──────────────────────

describe('POST /api/admin/moderation/[type]/[id] — delete_* はコンテンツを隠す (#1101)', () => {
  function postRequest(body: Record<string, unknown>, type = 'food', id = 'flag-1') {
    return new Request(`http://localhost/api/admin/moderation/${type}/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** moderation_flags から取得される行 (通報されたコンテンツ meal-1 の所有者は owner-x、通報者は reporter-x) */
  function foodFlagRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'flag-1',
      status: 'pending',
      reason: null,
      resolution_note: null,
      resolved_by: null,
      resolved_at: null,
      created_at: '2026-01-01T00:00:00Z',
      user_id: 'reporter-x',
      meal_id: 'meal-1',
      meals: { user_id: 'owner-x', photo_url: null },
      ...overrides,
    };
  }

  const ok = { data: null, error: null };

  it.each(['delete_only', 'delete_and_warn'] as const)(
    '%s: 通報された食事 (meals) を隠す。行は消さず、BAN もしない。解決メモ (運営の自由記述) は hidden_reason に入れない',
    async (action) => {
      fakeSupabase = createFakeSupabase({
        moderation_flags: [{ data: foodFlagRow(), error: null }, ok],
        meals: [ok],
        admin_audit_logs: [ok],
      });
      const before = Date.now();

      const res = await POST(postRequest({ action, resolution_note: 'internal note: repeat offender' }), {
        params: { type: 'food', id: 'flag-1' },
      });

      // 成功時の本文は今までどおり (隠したかどうかは本文に足さない)
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { success: true, status: 'rejected', ban_applied: null } });

      const mealBuilders = buildersFor(fakeSupabase, 'meals');
      expect(mealBuilders).toHaveLength(1);
      const [meal] = mealBuilders;
      const payload = meal.update.mock.calls[0][0] as Record<string, unknown>;
      expect(Date.parse(payload.hidden_at as string)).toBeGreaterThanOrEqual(before);
      expect(payload).toMatchObject({ hidden_by: 'admin-1', hidden_reason: `moderation:${action}` });
      expect(JSON.stringify(payload)).not.toContain('internal note');
      // 通報の ID (flag-1) ではなく、コンテンツ本体の ID (meal-1) の行を、まだ隠れていない場合だけ更新する
      expect(meal.eq).toHaveBeenCalledWith('id', 'meal-1');
      expect(meal.is).toHaveBeenCalledWith('hidden_at', null);
      // 行は消さない
      expect(meal.delete).not.toHaveBeenCalled();
      // BAN はしない
      expect(firstCallIndex(fakeSupabase, 'user_profiles')).toBe(-1);

      const audit = auditInsertPayload(fakeSupabase);
      expect(audit.details).toMatchObject({ action, content_id: 'meal-1', hidden: true, hide_error: null });
      expect(audit.severity).toBe('info');
    },
  );

  it.each([
    { action: 'delete_and_temp_ban', actor: adminActor, extra: { ban_duration_days: 7 } },
    { action: 'delete_and_perm_ban', actor: superAdminActor, extra: {} },
  ] as const)('$action: コンテンツを隠してから BAN する (隠す → BAN の順)', async ({ action, actor, extra }) => {
    mockRequireRole.mockResolvedValue(actor);
    fakeSupabase = createFakeSupabase({
      moderation_flags: [{ data: foodFlagRow(), error: null }, ok],
      meals: [ok],
      user_profiles: [{ data: { id: 'owner-x', roles: ['user'] }, error: null }, ok],
      admin_audit_logs: [ok],
    });

    const res = await POST(postRequest({ action, ...extra }), { params: { type: 'food', id: 'flag-1' } });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { ban_applied: boolean } }).data.ban_applied).toBe(true);
    expect(firstCallIndex(fakeSupabase, 'meals')).toBeGreaterThanOrEqual(0);
    expect(firstCallIndex(fakeSupabase, 'meals')).toBeLessThan(firstCallIndex(fakeSupabase, 'user_profiles'));
    expect(buildersFor(fakeSupabase, 'meals')[0].update.mock.calls[0][0]).toMatchObject({
      hidden_by: actor.id,
      hidden_reason: `moderation:${action}`,
    });
    expect(auditInsertPayload(fakeSupabase).details).toMatchObject({ content_id: 'meal-1', hidden: true });
  });

  it.each(['approve', 'escalate'] as const)(
    '%s: 何も隠さない (meals に触らない)。監査ログは content_id を残し、hidden: false',
    async (action) => {
      // meals のキューを用意しない = 触れば fake-supabase が例外を投げる
      fakeSupabase = createFakeSupabase({
        moderation_flags: [{ data: foodFlagRow(), error: null }, ok],
        admin_audit_logs: [ok],
      });

      const res = await POST(postRequest({ action }), { params: { type: 'food', id: 'flag-1' } });

      expect(res.status).toBe(200);
      expect(firstCallIndex(fakeSupabase, 'meals')).toBe(-1);
      expect(auditInsertPayload(fakeSupabase).details).toMatchObject({
        content_id: 'meal-1',
        hidden: false,
        hide_error: null,
      });
    },
  );

  it('delete_only: 隠せなかったら 500 OP_CONTENT_HIDE_FAILED。成功を装わず、DB の生のエラー文は本文に出さない。判定は保存済みで、監査ログと構造化ログに失敗を残す', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [{ data: foodFlagRow(), error: null }, ok],
      meals: [{ data: null, error: { message: 'permission denied for table meals' } }],
      admin_audit_logs: [ok],
    });

    const res = await POST(postRequest({ action: 'delete_only' }), { params: { type: 'food', id: 'flag-1' } });

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('permission denied');
    const json = JSON.parse(text) as { error: { code: string; message: string }; data: Record<string, unknown> };
    expect(json.error.code).toBe('OP_CONTENT_HIDE_FAILED');
    expect(json.error.message).toContain('非表示にできませんでした');
    // success: true を返さない。判定が保存済みであることと、隠せていないことだけを返す
    expect(json.data).toEqual({ status: 'rejected', content_hidden: false, ban_applied: null });

    // 判定 (status の更新) は隠す前に保存されている
    const flags = buildersFor(fakeSupabase, 'moderation_flags');
    expect(flags).toHaveLength(2); // 取得 + 更新
    expect(flags[1].update.mock.calls[0][0]).toMatchObject({ status: 'rejected', resolved_by: 'admin-1' });

    const audit = auditInsertPayload(fakeSupabase);
    expect(audit.details).toMatchObject({
      content_id: 'meal-1',
      hidden: false,
      hide_error: 'permission denied for table meals',
    });
    expect(audit.severity).toBe('warn');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ content_id: 'meal-1', flag_id: 'flag-1' });
  });

  it('delete_and_temp_ban: 隠せなかったときは BAN しない (user_profiles に触らない)。500 OP_CONTENT_HIDE_FAILED、ban_applied は null', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [{ data: foodFlagRow(), error: null }, ok],
      meals: [{ data: null, error: { message: 'connection reset' } }],
      admin_audit_logs: [ok],
    });

    const res = await POST(postRequest({ action: 'delete_and_temp_ban', ban_duration_days: 7 }), {
      params: { type: 'food', id: 'flag-1' },
    });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string }; data: Record<string, unknown> };
    expect(json.error.code).toBe('OP_CONTENT_HIDE_FAILED');
    expect(json.error.message).toContain('BAN はまだ実行していません');
    expect(json.data).toEqual({ status: 'rejected', content_hidden: false, ban_applied: null });
    // 隠れていないコンテンツが残ったまま持ち主だけ止めない
    expect(firstCallIndex(fakeSupabase, 'user_profiles')).toBe(-1);
    expect(fakeSupabase.rpc).not.toHaveBeenCalled();

    const audit = auditInsertPayload(fakeSupabase);
    expect(audit.details).toMatchObject({ hidden: false, ban_applied: null, unban_at: null });
    expect(audit.details.ban_error).toEqual(expect.stringContaining('BAN を実行していません'));
  });

  it('通報にコンテンツが紐づかない (meal_id が null) ときは、隠さずに 200 で続行する。監査ログは content_id: null, hidden: false', async () => {
    fakeSupabase = createFakeSupabase({
      moderation_flags: [{ data: foodFlagRow({ meal_id: null, meals: null }), error: null }, ok],
      admin_audit_logs: [ok],
    });

    const res = await POST(postRequest({ action: 'delete_only' }), { params: { type: 'food', id: 'flag-1' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true, status: 'rejected', ban_applied: null } });
    expect(firstCallIndex(fakeSupabase, 'meals')).toBe(-1);
    expect(auditInsertPayload(fakeSupabase).details).toMatchObject({ content_id: null, hidden: false, hide_error: null });
  });

  it('recipe: 通報されたレシピ (recipes) を隠す (meals には触らない)', async () => {
    fakeSupabase = createFakeSupabase({
      recipe_flags: [
        {
          data: {
            id: 'rflag-1',
            status: 'pending',
            reason: null,
            reviewed_by: null,
            reviewed_at: null,
            created_at: '2026-01-02T00:00:00Z',
            reporter_id: 'reporter-x',
            recipe_id: 'recipe-1',
            recipes: { user_id: 'owner-r', image_url: null },
          },
          error: null,
        },
        ok,
      ],
      recipes: [ok],
      admin_audit_logs: [ok],
    });

    const res = await POST(postRequest({ action: 'delete_only' }, 'recipe', 'rflag-1'), {
      params: { type: 'recipe', id: 'rflag-1' },
    });

    expect(res.status).toBe(200);
    expect(firstCallIndex(fakeSupabase, 'meals')).toBe(-1);
    const [recipe] = buildersFor(fakeSupabase, 'recipes');
    expect(recipe.update.mock.calls[0][0]).toMatchObject({
      hidden_by: 'admin-1',
      hidden_reason: 'moderation:delete_only',
    });
    expect(recipe.eq).toHaveBeenCalledWith('id', 'recipe-1');
    expect(recipe.is).toHaveBeenCalledWith('hidden_at', null);
    expect(auditInsertPayload(fakeSupabase).details).toMatchObject({
      moderation_type: 'recipe',
      content_id: 'recipe-1',
      hidden: true,
    });
  });
});
