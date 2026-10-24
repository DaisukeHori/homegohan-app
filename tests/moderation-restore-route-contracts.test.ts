/**
 * #1538 POST /api/admin/moderation/[type]/[id]/restore の contract テスト (段 A)
 * 設計: docs/design/operator/13-hidden-content-restore.md §8・§10.1.1 (P-1〜P-24)・§13.2 (RT-1〜RT-18)
 *
 * 通報の読み取り・通報と行の更新は service-role の偽物 (adminFake)、監査ログは本人の権限の偽物 (userFake) に積む。
 * 「本人の client で監査ログを書く」「順は 通報 → 行」「失敗を成功と装わない」「応答に生のエラー文を出さない」を確かめる。
 * 部品の単体は tests/hidden-content-restore.test.ts、本物の DB は tests/integration/operator/admin-moderation-restore.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase, type FakeSupabase } from './helpers/fake-supabase';

const mockRequireRole = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

// 構造化ログ (app_logs への書き込み) は呼ばれたことと引数だけ確かめる
vi.mock('@/lib/db-logger', () => ({
  generateRequestId: () => 'req-test',
  createLogger: () => ({
    withUser: () => ({
      error: (...args: unknown[]) => mockLoggerError(...args),
    }),
  }),
}));

let adminFake: FakeSupabase;
let userFake: FakeSupabase;
const mockGetSupabaseAdmin = vi.fn();
const mockCreateClient = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { POST } = await import('@/app/api/admin/moderation/[type]/[id]/restore/route');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const adminActor = { id: 'admin-1', email: 'admin@example.com', roles: ['admin'], organization_id: null };
const moderatorActor = { id: 'mod-1', email: 'mod@example.com', roles: ['content_moderator'], organization_id: null };

const RECENT = new Date(Date.now() - 3 * MS_PER_DAY).toISOString();
const LATER = new Date(Date.now() - 1 * MS_PER_DAY).toISOString();
const OLD = new Date(Date.now() - 92 * MS_PER_DAY).toISOString();
const SENTINEL = 'permission denied for table moderation_flags (sentinel-1538)';
const NOTE = '申し立てを確認。規約違反ではなかった';

type Json = Record<string, unknown>;

function restoreRequest(body: unknown, rawBody?: string): Request {
  return new Request('http://localhost/api/admin/moderation/food/flag-1/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest-agent' },
    body: rawBody ?? JSON.stringify(body),
  });
}

const call = (type: string, id: string, request: Request) => POST(request, { params: Promise.resolve({ type, id }) });

function foodFlagRow(overrides: Json = {}): Json {
  return {
    id: 'flag-1',
    status: 'rejected',
    reason: null,
    resolution_note: null,
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-01-01T00:00:00Z',
    user_id: 'reporter-x',
    meal_id: 'meal-1',
    meals: { user_id: 'owner-x', photo_url: null, hidden_at: RECENT },
    ...overrides,
  };
}

function recipeFlagRow(overrides: Json = {}): Json {
  return {
    id: 'rflag-1',
    status: 'rejected',
    reason: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    reporter_id: 'reporter-x',
    recipe_id: 'recipe-1',
    recipes: { user_id: 'owner-y', image_url: null, hidden_at: RECENT },
    ...overrides,
  };
}

function mealDbRow(overrides: Json = {}): Json {
  return {
    id: 'meal-1', user_id: 'owner-x', hidden_at: RECENT, hidden_by: 'moderator-0', hidden_reason: 'moderation:delete_only',
    paste_group_id: null, photo_url: 'https://example.com/a.jpg', memo: 'メモ', ...overrides,
  };
}

type Queue = Array<{ data?: unknown; error?: unknown }>;

function seedFakes(adminQueues: Record<string, Queue>, auditResult: { error?: unknown } = { error: null }) {
  adminFake = createFakeSupabase(adminQueues);
  userFake = createFakeSupabase({ admin_audit_logs: [{ data: null, error: auditResult.error ?? null }] });
}

/** 複製なしの food が最後まで戻る流れの積み方。上書きしたい結果だけ渡す */
function plainFoodQueues(overrides: { flag?: Queue[number]; meal?: Queue; flags?: Queue } = {}) {
  return {
    moderation_flags: [overrides.flag ?? { data: foodFlagRow(), error: null }, ...(overrides.flags ?? [{ data: [{ id: 'flag-1' }], error: null }])],
    meals: overrides.meal ?? [{ data: mealDbRow(), error: null }, { data: [{ id: 'meal-1' }], error: null }],
  };
}

type Builder = Record<'select' | 'eq' | 'gte' | 'in' | 'update' | 'insert', ReturnType<typeof vi.fn>>;
function buildersFor(fake: FakeSupabase, table: string): Builder[] {
  const list: Builder[] = [];
  fake.from.mock.calls.forEach((c, i) => {
    if (c[0] === table) list.push(fake.from.mock.results[i]!.value as Builder);
  });
  return list;
}
const tablesCalled = (fake: FakeSupabase) => fake.from.mock.calls.map((c) => String(c[0]));
const updatesOf = (fake: FakeSupabase, table: string) => buildersFor(fake, table).filter((b) => b.update.mock.calls.length > 0);

function auditRow() {
  const [builder] = buildersFor(userFake, 'admin_audit_logs');
  expect(builder, 'admin_audit_logs に INSERT されていない').toBeDefined();
  return builder.insert.mock.calls[0]?.[0] as {
    actor_id: string; action_type: string; target_id: string; target_type: string; severity: string; user_agent: string | null; details: Json;
  };
}
const auditCount = () => buildersFor(userFake, 'admin_audit_logs').length;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(adminActor);
  mockGetSupabaseAdmin.mockImplementation(() => adminFake);
  mockCreateClient.mockImplementation(() => Promise.resolve(userFake));
  seedFakes({});
});

describe('POST /api/admin/moderation/[type]/[id]/restore — 入口 (RT-1〜RT-4)', () => {
  it('RT-1: 401 未認証 / 403 ロール不足', async () => {
    const { AuthError, ForbiddenError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    const unauth = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(unauth.status).toBe(401);
    expect(((await unauth.json()) as { error: { code: string } }).error.code).toBe('AUTH_UNAUTHENTICATED');

    mockRequireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED'));
    const forbidden = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe('OP_PERMISSION_DENIED');
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockRequireRole).toHaveBeenCalledWith(['admin', 'super_admin', 'content_moderator']);
  });

  it('RT-1: 400 type が不正 / 501 ai_content (本文の検証より前・本文が不正でも) / 400 INVALID_JSON', async () => {
    const badType = await call('unknown', 'x', restoreRequest({ restore_note: NOTE }));
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const ai = await call('ai_content', 'x', restoreRequest(null, 'これは JSON ではない'));
    expect(ai.status).toBe(501);
    expect(((await ai.json()) as { error: { code: string } }).error.code).toBe('OP_NOT_SUPPORTED');
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();

    const invalidJson = await call('food', 'flag-1', restoreRequest(null, '{"restore_note": '));
    expect(invalidJson.status).toBe(400);
    expect(((await invalidJson.json()) as { error: { code: string } }).error.code).toBe('INVALID_JSON');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('RT-1: 400 VALIDATION_ERROR (restore_note 無し・空白だけ・5001 字)。details に Zod の flatten。Supabase の client を作らない', async () => {
    for (const body of [{}, { restore_note: '   \n ' }, { restore_note: 'あ'.repeat(5001) }, { restore_note: 5 }]) {
      const res = await call('food', 'flag-1', restoreRequest(body));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string; details: { fieldErrors: Record<string, string[]> } } };
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.details.fieldErrors.restore_note?.length).toBeGreaterThan(0);
    }
    // 5000 字ちょうどと前後の空白は通る (本文の検証を通って、先の通報の読み取りまで進む)
    seedFakes({ moderation_flags: [{ data: null, error: null }] });
    const edge = await call('food', 'flag-1', restoreRequest({ restore_note: `  ${'あ'.repeat(5000)}  ` }));
    expect(edge.status).toBe(404);
  });

  it('RT-1: 400 INVALID_CHARACTER (NULL 文字)。認証にも Supabase にも触れない', async () => {
    const res = await call('food', 'flag-1', restoreRequest({ restore_note: 'メモ\u0000' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_CHARACTER');
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('RT-2: 通報が無ければ 404。通報の読み取りが失敗したら 500 (404 に丸めない)。どちらも何も更新せず監査ログも残さない', async () => {
    seedFakes({ moderation_flags: [{ data: null, error: null }] });
    const notFound = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    seedFakes({ moderation_flags: [{ data: null, error: { message: SENTINEL } }] });
    const failed = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(failed.status).toBe(500);
    const text = JSON.stringify(await failed.json());
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).not.toContain(SENTINEL);
    expect(updatesOf(adminFake, 'moderation_flags')).toHaveLength(0);
    expect(tablesCalled(adminFake)).toEqual(['moderation_flags']);
    expect(auditCount()).toBe(0);
  });

  it('RT-3: 通報の content_id が null なら 410 OP_CONTENT_GONE。行が無ければ 410。何も更新せず監査ログも残さない', async () => {
    seedFakes({ moderation_flags: [{ data: foodFlagRow({ meal_id: null, meals: null }), error: null }] });
    const noContent = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(noContent.status).toBe(410);
    expect(((await noContent.json()) as { error: { code: string } }).error.code).toBe('OP_CONTENT_GONE');
    expect(tablesCalled(adminFake)).toEqual(['moderation_flags']);

    seedFakes({ moderation_flags: [{ data: foodFlagRow(), error: null }], meals: [{ data: null, error: null }] });
    const gone = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe('OP_CONTENT_GONE');
    expect(updatesOf(adminFake, 'moderation_flags')).toHaveLength(0);
    expect(updatesOf(adminFake, 'meals')).toHaveLength(0);
    expect(auditCount()).toBe(0);
  });

  it('RT-4: 行が隠れていなければ 409 OP_CONTENT_NOT_HIDDEN。隠してから 90 日なら 409 OP_CONTENT_RESTORE_WINDOW_EXPIRED (data.hidden_at)。何も更新せず監査ログも残さない', async () => {
    seedFakes({
      moderation_flags: [{ data: foodFlagRow(), error: null }],
      meals: [{ data: mealDbRow({ hidden_at: null, hidden_by: null, hidden_reason: null }), error: null }],
    });
    const notHidden = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(notHidden.status).toBe(409);
    const notHiddenJson = (await notHidden.json()) as { error: { code: string; message: string }; data: Json };
    expect(notHiddenJson.error.code).toBe('OP_CONTENT_NOT_HIDDEN');
    expect(notHiddenJson.error.message).toBe('このコンテンツはすでに表示されています');
    expect(notHiddenJson.data).toEqual({ content_hidden: false });
    expect(auditCount()).toBe(0);

    const ninety = new Date(Date.now() - 90 * MS_PER_DAY).toISOString();
    seedFakes({ moderation_flags: [{ data: foodFlagRow(), error: null }], meals: [{ data: mealDbRow({ hidden_at: ninety }), error: null }] });
    const expired = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(expired.status).toBe(409);
    const expiredJson = (await expired.json()) as { error: { code: string; message: string }; data: Json };
    expect(expiredJson.error.code).toBe('OP_CONTENT_RESTORE_WINDOW_EXPIRED');
    expect(expiredJson.error.message).toBe('隠してから 89 日を過ぎたため戻せません (保管期間 90 日で完全に削除されます)');
    expect(expiredJson.data).toEqual({ content_hidden: true, hidden_at: ninety });
    expect(updatesOf(adminFake, 'moderation_flags')).toHaveLength(0);
    expect(updatesOf(adminFake, 'meals')).toHaveLength(0);
    expect(auditCount()).toBe(0);
  });
});

describe('POST /api/admin/moderation/[type]/[id]/restore — 戻す (RT-5〜RT-7, RT-12, RT-13, RT-17)', () => {
  it('RT-5: food (複製なし): 通報 → 行の順で更新し、200。監査ログは admin.moderation.restore・info・target_type moderation_item:food・details。本人の client で書き、request を渡す', async () => {
    seedFakes(plainFoodQueues());

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: `  ${NOTE}  ` }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { success: true, content_hidden: false, restored_ids: ['meal-1'], approved_flag_ids: ['flag-1'] },
    });
    // 通報 (moderation_flags) の更新が、行 (meals) の更新より先
    const order = tablesCalled(adminFake);
    expect(order).toEqual(['moderation_flags', 'meals', 'moderation_flags', 'meals']);
    expect(updatesOf(adminFake, 'moderation_flags')[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', resolved_by: 'admin-1', resolution_note: NOTE }),
    );
    expect(updatesOf(adminFake, 'meals')[0].update).toHaveBeenCalledWith({ hidden_at: null, hidden_by: null, hidden_reason: null });
    // 監査ログは本人の client だけに書く
    expect(userFake.from).toHaveBeenCalledTimes(1);
    expect(adminFake.from.mock.calls.some((c) => c[0] === 'admin_audit_logs')).toBe(false);
    const audit = auditRow();
    expect(audit).toMatchObject({
      actor_id: 'admin-1',
      action_type: 'admin.moderation.restore',
      target_id: 'flag-1',
      target_type: 'moderation_item:food',
      severity: 'info',
      user_agent: 'vitest-agent',
    });
    expect(audit.details).toMatchObject({
      moderation_type: 'food',
      flag_id: 'flag-1',
      content_id: 'meal-1',
      content_user_id: 'owner-x',
      restore_note: NOTE,
      hidden_at_before: RECENT,
      hidden_by_before: 'moderator-0',
      hidden_reason_before: 'moderation:delete_only',
      target_ids: ['meal-1'],
      restored_ids: ['meal-1'],
      restored: true,
      restore_error: null,
      approved_flag_ids: ['flag-1'],
      status_saved: true,
      status_error: null,
      restore_window_days: 89,
    });
  });

  it('RT-6: food (複製あり): 同じ paste_group_id で通報された行の hidden_at 以後の行を gte で読み、同じ時刻の行をまとめて 1 文で更新する。approved_flag_ids に複製の通報も入る。別の時刻 t2 の同じ中身の行 (S-24) は先に別の 1 文で戻り、restored_ids と target_ids に入る', async () => {
    seedFakes({
      moderation_flags: [
        { data: foodFlagRow(), error: null },
        { data: [{ id: 'flag-1' }, { id: 'flag-2' }, { id: 'flag-3' }], error: null },
      ],
      meals: [
        { data: mealDbRow({ paste_group_id: 'group-1' }), error: null },
        {
          data: [
            { id: 'meal-1', hidden_at: RECENT, photo_url: 'https://example.com/a.jpg', memo: 'メモ' },
            { id: 'meal-2', hidden_at: RECENT, photo_url: 'https://example.com/edited.jpg', memo: '書き換え' },
            { id: 'meal-3', hidden_at: LATER, photo_url: 'https://example.com/a.jpg', memo: 'メモ' },
            { id: 'meal-4', hidden_at: LATER, photo_url: 'https://example.com/other.jpg', memo: '別' },
          ],
          error: null,
        },
        { data: [{ id: 'meal-3' }], error: null },
        { data: [{ id: 'meal-1' }, { id: 'meal-2' }], error: null },
      ],
    });

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { restored_ids: string[]; approved_flag_ids: string[] } };
    expect(json.data.restored_ids).toEqual(['meal-3', 'meal-1', 'meal-2']);
    expect(json.data.approved_flag_ids).toEqual(['flag-1', 'flag-2', 'flag-3']);
    const [groupRead] = buildersFor(adminFake, 'meals').slice(1, 2);
    expect(groupRead.gte).toHaveBeenCalledWith('hidden_at', RECENT);
    expect(groupRead.eq).toHaveBeenCalledWith('paste_group_id', 'group-1');
    // 通報の更新の対象は meal-4 を含まない (中身も時刻も違う行)
    expect(updatesOf(adminFake, 'moderation_flags')[0].in).toHaveBeenCalledWith('meal_id', ['meal-1', 'meal-2', 'meal-3']);
    const mealUpdates = updatesOf(adminFake, 'meals');
    expect(mealUpdates).toHaveLength(2);
    expect(mealUpdates[0].in).toHaveBeenCalledWith('id', ['meal-3']);
    expect(mealUpdates[0].eq).toHaveBeenCalledWith('hidden_at', LATER);
    expect(mealUpdates[1].in).toHaveBeenCalledWith('id', ['meal-1', 'meal-2']);
    expect(mealUpdates[1].eq).toHaveBeenCalledWith('hidden_at', RECENT);
    expect(auditRow().details).toMatchObject({ target_ids: ['meal-1', 'meal-2', 'meal-3'], restored_ids: ['meal-3', 'meal-1', 'meal-2'] });
  });

  it('RT-7: recipe: recipe_flags は reviewed_by / reviewed_at で approved (resolution_note を書かない)。meals には触らない', async () => {
    seedFakes({
      recipe_flags: [{ data: recipeFlagRow(), error: null }, { data: [{ id: 'rflag-1' }], error: null }],
      recipes: [
        { data: { id: 'recipe-1', user_id: 'owner-y', hidden_at: RECENT, hidden_by: 'moderator-0', hidden_reason: 'moderation:delete_only' }, error: null },
        { data: [{ id: 'recipe-1' }], error: null },
      ],
    });

    const res = await call('recipe', 'rflag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(200);
    const payload = updatesOf(adminFake, 'recipe_flags')[0].update.mock.calls[0]?.[0] as Json;
    expect(payload).toMatchObject({ status: 'approved', reviewed_by: 'admin-1' });
    expect(payload).not.toHaveProperty('resolution_note');
    expect(payload).not.toHaveProperty('resolved_by');
    expect(tablesCalled(adminFake)).toEqual(['recipe_flags', 'recipes', 'recipe_flags', 'recipes']);
    expect(adminFake.from.mock.calls.some((c) => c[0] === 'meals' || c[0] === 'moderation_flags')).toBe(false);
    expect(auditRow().target_type).toBe('moderation_item:recipe');
  });

  it('RT-12: content_moderator でも 200 (隠す操作と同じ 3 ロール)。super_admin 限定の分岐は無い', async () => {
    mockRequireRole.mockResolvedValue(moderatorActor);
    seedFakes(plainFoodQueues());
    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(res.status).toBe(200);
    expect(auditRow().actor_id).toBe('mod-1');
  });

  it('RT-13: user_profiles (BAN) には触らない', async () => {
    seedFakes(plainFoodQueues());
    await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    const tables = [...tablesCalled(adminFake), ...tablesCalled(userFake)];
    expect(tables).not.toContain('user_profiles');
    expect(tables.every((table) => ['moderation_flags', 'meals', 'admin_audit_logs'].includes(table))).toBe(true);
  });

  it('RT-17: recipe で持ち主 (recipes.user_id) が null の行 (S-23) も 200。recipe_flags は approved。監査ログの content_user_id は null', async () => {
    seedFakes({
      recipe_flags: [
        { data: recipeFlagRow({ recipes: { user_id: null, image_url: null, hidden_at: RECENT } }), error: null },
        { data: [{ id: 'rflag-1' }], error: null },
      ],
      recipes: [
        { data: { id: 'recipe-1', user_id: null, hidden_at: RECENT, hidden_by: null, hidden_reason: 'moderation:delete_only' }, error: null },
        { data: [{ id: 'recipe-1' }], error: null },
      ],
    });

    const res = await call('recipe', 'rflag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(200);
    expect(auditRow().details).toMatchObject({ content_user_id: null, hidden_by_before: null, restored: true, approved_flag_ids: ['rflag-1'] });
  });
});

describe('POST /api/admin/moderation/[type]/[id]/restore — 失敗 (RT-8, RT-9, RT-11, RT-14〜RT-16)', () => {
  it('RT-8: 通報の更新が失敗したら 500 INTERNAL_ERROR (固定の文)。行は更新しない。監査ログは warn・status_saved false・status_error に元のエラー文。応答の本文に生のエラー文を出さない', async () => {
    seedFakes(plainFoodQueues({ flags: [{ data: null, error: { message: SENTINEL } }] }));

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain('通報の状態を更新できませんでした。コンテンツはまだ非表示のままです。もう一度同じ操作を実行してください。');
    expect(text).toContain('INTERNAL_ERROR');
    expect(updatesOf(adminFake, 'meals')).toHaveLength(0);
    const audit = auditRow();
    expect(audit.severity).toBe('warn');
    expect(audit.details).toMatchObject({
      status_saved: false, status_error: SENTINEL, restored: false, approved_flag_ids: [], target_ids: ['meal-1'], restored_ids: [],
    });
  });

  it('RT-9: 行の更新が失敗したら 500 OP_CONTENT_RESTORE_FAILED (固定の文・data.approved_flag_ids)。監査ログは warn・status_saved true・restored false・restore_error・target_ids・restored_ids (先に書いた組の行。無ければ空)。構造化ログに step: rows', async () => {
    seedFakes(plainFoodQueues({ meal: [{ data: mealDbRow(), error: null }, { data: null, error: { message: SENTINEL } }] }));

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string }; data: Json };
    expect(json.error.code).toBe('OP_CONTENT_RESTORE_FAILED');
    expect(json.error.message).toBe('コンテンツを表示に戻せませんでした。通報の状態は承認済みにしました。もう一度同じ操作を実行してください。');
    expect(json.data).toEqual({ content_hidden: true, approved_flag_ids: ['flag-1'] });
    expect(JSON.stringify(json)).not.toContain(SENTINEL);
    const audit = auditRow();
    expect(audit.severity).toBe('warn');
    expect(audit.details).toMatchObject({
      status_saved: true, restored: false, restore_error: SENTINEL, approved_flag_ids: ['flag-1'], target_ids: ['meal-1'], restored_ids: [],
    });
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ step: 'rows', flag_id: 'flag-1', content_id: 'meal-1' });
  });

  it('RT-9: 通報された行の組が失敗したときは、先に書いた (b) の組の行が restored_ids に残る', async () => {
    seedFakes({
      moderation_flags: [{ data: foodFlagRow(), error: null }, { data: [{ id: 'flag-1' }], error: null }],
      meals: [
        { data: mealDbRow({ paste_group_id: 'group-1' }), error: null },
        { data: [{ id: 'meal-3', hidden_at: LATER, photo_url: 'https://example.com/a.jpg', memo: 'メモ' }], error: null },
        { data: [{ id: 'meal-3' }], error: null },
        { data: null, error: { message: SENTINEL } },
      ],
    });

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(500);
    expect(auditRow().details).toMatchObject({ restored: false, restored_ids: ['meal-3'], target_ids: ['meal-1', 'meal-3'] });
  });

  it('RT-11: 監査ログの INSERT に失敗しても 200 (fail-open)', async () => {
    seedFakes(plainFoodQueues(), { error: { message: 'audit down' } });
    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(res.status).toBe(200);
    expect(buildersFor(userFake, 'admin_audit_logs')).toHaveLength(1);
  });

  it('RT-14: 行の読み取りが失敗したら (P-8) 500 INTERNAL_ERROR「コンテンツの状態を読み取れませんでした。…」(data を付けない)。通報も行も更新しない。監査ログは warn・status_saved false・status_error null・restored false・restore_error に元のエラー文・hidden_at_before null。構造化ログに step: read', async () => {
    seedFakes({ moderation_flags: [{ data: foodFlagRow(), error: null }], meals: [{ data: null, error: { message: SENTINEL } }] });

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string }; data?: Json };
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(json.error.message).toBe('コンテンツの状態を読み取れませんでした。もう一度同じ操作を実行してください。');
    expect(json).not.toHaveProperty('data');
    expect(JSON.stringify(json)).not.toContain(SENTINEL);
    expect(updatesOf(adminFake, 'moderation_flags')).toHaveLength(0);
    expect(updatesOf(adminFake, 'meals')).toHaveLength(0);
    const audit = auditRow();
    expect(audit.severity).toBe('warn');
    expect(audit.details).toMatchObject({
      status_saved: false, status_error: null, restored: false, restore_error: SENTINEL, hidden_at_before: null,
    });
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ step: 'read' });
  });

  it('RT-15: food (複製あり) で同じまとまりの読み取りが失敗したら (P-15) 500 INTERNAL_ERROR (RT-14 と同じ文・data なし)。通報も行も更新しない。監査ログは warn・status_saved false・restore_error・hidden_at_before は読んだ行の値。構造化ログに step: read', async () => {
    seedFakes({
      moderation_flags: [{ data: foodFlagRow(), error: null }],
      meals: [{ data: mealDbRow({ paste_group_id: 'group-1' }), error: null }, { data: null, error: { message: SENTINEL } }],
    });

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { message: string }; data?: Json };
    expect(json.error.message).toBe('コンテンツの状態を読み取れませんでした。もう一度同じ操作を実行してください。');
    expect(json).not.toHaveProperty('data');
    expect(updatesOf(adminFake, 'moderation_flags')).toHaveLength(0);
    expect(updatesOf(adminFake, 'meals')).toHaveLength(0);
    expect(auditRow().details).toMatchObject({ status_saved: false, restore_error: SENTINEL, hidden_at_before: RECENT, restored: false });
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ step: 'read' });
  });

  it('RT-16: 行の更新が 0 行で、読み直しが失敗したら (P-22) 500 OP_CONTENT_RESTORE_FAILED (固定の文・data.approved_flag_ids)。監査ログは warn・status_saved true・restored false・restore_error。構造化ログに step: reread', async () => {
    seedFakes(plainFoodQueues({ meal: [{ data: mealDbRow(), error: null }, { data: [], error: null }, { data: null, error: { message: SENTINEL } }] }));

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string }; data: Json };
    expect(json.error.code).toBe('OP_CONTENT_RESTORE_FAILED');
    expect(json.data).toEqual({ content_hidden: true, approved_flag_ids: ['flag-1'] });
    expect(auditRow().details).toMatchObject({ status_saved: true, restored: false, restore_error: SENTINEL, approved_flag_ids: ['flag-1'] });
    expect(auditRow().severity).toBe('warn');
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ step: 'reread' });
  });
});

describe('POST /api/admin/moderation/[type]/[id]/restore — 0 行 (raced) (RT-10, RT-18)', () => {
  /** 通報された行の組の更新が 0 行になり、読み直しが rereadRow を返す流れ */
  function racedQueues(rereadRow: unknown, approved: Array<{ id: string }> = [{ id: 'flag-1' }]) {
    return plainFoodQueues({
      meal: [{ data: mealDbRow(), error: null }, { data: [], error: null }, { data: rereadRow, error: null }],
      flags: [{ data: approved, error: null }],
    });
  }

  it('RT-10: 通報を approved にしたあとで (approved_flag_ids が空でない) 通報された行の更新が 0 行なら読み直し: 無ければ 410 / hidden_at null なら 409 OP_CONTENT_NOT_HIDDEN / 期限切れなら 409 WINDOW_EXPIRED (data.hidden_at) / 戻せるなら 409 CONFLICT_STALE_DATA。4 つとも監査ログを warn で 1 行残し、approved_flag_ids・restored false・restore_error (固定の文) を持つ (P-18〜P-21)', async () => {
    const cases: Array<{ name: string; reread: unknown; status: number; code: string; error: string }> = [
      { name: 'gone', reread: null, status: 410, code: 'OP_CONTENT_GONE', error: 'raced: the content row was deleted before it was restored' },
      {
        name: 'not_hidden',
        reread: mealDbRow({ hidden_at: null, hidden_by: null, hidden_reason: null }),
        status: 409,
        code: 'OP_CONTENT_NOT_HIDDEN',
        error: 'raced: the content row was already restored by another operation',
      },
      { name: 'window_expired', reread: mealDbRow({ hidden_at: OLD }), status: 409, code: 'OP_CONTENT_RESTORE_WINDOW_EXPIRED', error: 'raced: the restore window ended before the content row was updated' },
      { name: 'restorable', reread: mealDbRow({ hidden_at: LATER }), status: 409, code: 'CONFLICT_STALE_DATA', error: 'raced: the content row was hidden again by another operation' },
    ];
    for (const c of cases) {
      seedFakes(racedQueues(c.reread));
      const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
      const json = (await res.json()) as { error: { code: string }; data?: Json };
      expect(res.status, c.name).toBe(c.status);
      expect(json.error.code, c.name).toBe(c.code);
      if (c.name === 'window_expired') expect(json.data).toEqual({ content_hidden: true, hidden_at: OLD });
      expect(auditCount(), c.name).toBe(1);
      const audit = auditRow();
      expect(audit.severity, c.name).toBe('warn');
      expect(audit.details, c.name).toMatchObject({ approved_flag_ids: ['flag-1'], restored: false, restore_error: c.error, status_saved: true });
    }
  });

  it('RT-18: 通報の更新が 0 件 (approved_flag_ids が空) で、通報された行の更新も 0 行・ほかの組も 0 行なら、409 / 410 を返し監査ログを残さない (何も書いていない: §6.6)', async () => {
    seedFakes(racedQueues(mealDbRow({ hidden_at: null, hidden_by: null, hidden_reason: null }), []));
    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OP_CONTENT_NOT_HIDDEN');
    expect(auditCount()).toBe(0);

    seedFakes(racedQueues(null, []));
    const gone = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));
    expect(gone.status).toBe(410);
    expect(auditCount()).toBe(0);
  });

  it('RT-18: ほかの組の行だけ戻っていれば (restored_ids が空でない) warn で残す', async () => {
    seedFakes({
      moderation_flags: [{ data: foodFlagRow(), error: null }, { data: [], error: null }],
      meals: [
        { data: mealDbRow({ paste_group_id: 'group-1' }), error: null },
        { data: [{ id: 'meal-3', hidden_at: LATER, photo_url: 'https://example.com/a.jpg', memo: 'メモ' }], error: null },
        { data: [{ id: 'meal-3' }], error: null },
        { data: [], error: null },
        { data: mealDbRow({ hidden_at: null, hidden_by: null, hidden_reason: null }), error: null },
      ],
    });

    const res = await call('food', 'flag-1', restoreRequest({ restore_note: NOTE }));

    expect(res.status).toBe(409);
    expect(auditCount()).toBe(1);
    expect(auditRow().severity).toBe('warn');
    expect(auditRow().details).toMatchObject({ restored_ids: ['meal-3'], approved_flag_ids: [], restored: false });
  });
});
