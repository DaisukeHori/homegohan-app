/**
 * tests/api/add-from-photo-sandbox-route.test.ts
 *
 * Issue #1109: POST /api/meal-plans/add-from-photo の sandbox 適格性チェックが
 * user_profiles を .eq('user_id', ...) で引いていた不具合の回帰テスト。
 *
 * user_profiles の主キーは id で、user_id 列は存在しない。そのため PostgREST は
 * 42703 (undefined_column) を返すが、旧実装は error を見ずに data だけを使っていたので
 * profile が常に null になり、次の 2 つのゲートが無条件で素通りしていた (fail-open)。
 *   - ツアー完了/スキップ済み → 409 already_finished
 *   - 管理者ロール           → 403 admin_role
 * 残る防御は user_has_non_sandbox_activity RPC だけだった。
 *
 * このテストの Supabase モック (tests/helpers/fake-sandbox-supabase.ts) は、実テーブルと
 * 同じく user_profiles を id でしか引けないように作ってある。user_id など存在しない列で
 * 引くと 42703 を返すので、旧実装のままだと拒否系のテストがすべて落ちる。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSandboxDb,
  eligibleProfile,
  type FakeSandboxDbOptions,
} from '../helpers/fake-sandbox-supabase';

const USER_ID = 'user-1';

// db-logger はモックする (app_logs への書き込みを避け、fail-closed 時にログが残ることを確認する)
const loggerError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
    withUser: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: loggerError }),
  }),
  generateRequestId: () => 'req_test',
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentClient: any;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentClient,
}));

import { POST } from '../../src/app/api/meal-plans/add-from-photo/route';

// ── ヘルパー ─────────────────────────────────────────────────────────────────

/** add-from-photo が user_daily_meals / planned_meals に対して行う操作の結果 */
const photoTables: FakeSandboxDbOptions['tables'] = {
  user_daily_meals: ({ op }) =>
    op === 'insert'
      ? { data: { id: 'daily-1' }, error: null }
      : // 同じ日付の user_daily_meals はまだ無い
        { data: null, error: { code: 'PGRST116', message: 'no rows' } },
  planned_meals: ({ op }) => {
    if (op === 'insert') return { data: { id: 'meal-1' }, error: null };
    if (op === 'delete') return { data: null, error: null };
    return { data: [], error: null };
  },
};

function setup(options: Omit<FakeSandboxDbOptions, 'userId' | 'tables'> = {}) {
  const db = createFakeSandboxDb({
    userId: USER_ID,
    profile: eligibleProfile(USER_ID),
    ...options,
    tables: photoTables,
  });
  currentClient = db.client;
  return db;
}

const baseBody = {
  dayDate: '2026-07-10',
  mealType: 'dinner',
  dishes: [{ name: '鶏の唐揚げ', cal: 400, role: 'main', ingredient: '鶏もも肉' }],
  totalCalories: 780,
  imageUrl: null,
  nutritionalAdvice: 'バランスのよい和食です',
};

function makeRequest(body: Record<string, unknown>, source = 'handson_tour'): Request {
  return new Request(`https://homegohan-app.vercel.app/api/meal-plans/add-from-photo?source=${source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postSandbox() {
  const res = await POST(makeRequest({ ...baseBody, sandbox: true }));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── テスト ───────────────────────────────────────────────────────────────────

describe('#1109: POST /api/meal-plans/add-from-photo の sandbox 適格性チェック', () => {
  it('未認証なら 401 を返し、DB には何も触れない', async () => {
    const db = setup();
    db.client.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('no session') });

    const { status } = await postSandbox();

    expect(status).toBe(401);
    expect(db.client.from).not.toHaveBeenCalled();
    expect(db.client.rpc).not.toHaveBeenCalled();
  });

  it('適格ユーザーは 200 で保存でき、user_daily_meals は is_sandbox=true で作られる', async () => {
    const db = setup();

    const { status, json } = await postSandbox();

    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, dailyMealId: 'daily-1', mealId: 'meal-1' });
    const dailyInsert = db.state.writes.find((w) => w.table === 'user_daily_meals' && w.op === 'insert');
    expect(dailyInsert?.payload).toMatchObject({ user_id: USER_ID, day_date: '2026-07-10', is_sandbox: true });
  });

  it('user_profiles は主キー id で引く (user_id 列は存在しない) (#1109)', async () => {
    const db = setup();

    await postSandbox();

    expect(db.state.profileFilters).toEqual([['id', USER_ID]]);
  });

  it('ツアー完了済みユーザーは 409 / already_finished で拒否され、何も書き込まれない (#1109)', async () => {
    const db = setup({
      profile: eligibleProfile(USER_ID, { handson_tour_completed_at: '2026-07-01T00:00:00.000Z' }),
    });

    const { status, json } = await postSandbox();

    expect(status).toBe(409);
    expect(json.error).toMatchObject({ code: 'sandbox_not_eligible', reason: 'already_finished' });
    expect(db.state.writes).toEqual([]);
  });

  it('ツアースキップ済みユーザーも 409 / already_finished で拒否され、何も書き込まれない (#1109)', async () => {
    const db = setup({
      profile: eligibleProfile(USER_ID, { handson_tour_skipped_at: '2026-07-01T00:00:00.000Z' }),
    });

    const { status, json } = await postSandbox();

    expect(status).toBe(409);
    expect(json.error).toMatchObject({ code: 'sandbox_not_eligible', reason: 'already_finished' });
    expect(db.state.writes).toEqual([]);
  });

  it.each(['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'])(
    '%s ロールのユーザーは 403 / admin_role で拒否され、何も書き込まれない (#1109)',
    async (role) => {
      const db = setup({ profile: eligibleProfile(USER_ID, { roles: ['user', role] }) });

      const { status, json } = await postSandbox();

      expect(status).toBe(403);
      expect(json.error).toMatchObject({ code: 'sandbox_not_eligible', reason: 'admin_role' });
      expect(db.state.writes).toEqual([]);
    },
  );

  it('プロファイルの行が無いときは 404 / profile_not_found で拒否される (fail-closed) (#1109)', async () => {
    const db = setup({ profile: null });

    const { status, json } = await postSandbox();

    expect(status).toBe(404);
    expect(json.error).toMatchObject({ code: 'profile_not_found' });
    expect(db.state.writes).toEqual([]);
    expect(loggerError).toHaveBeenCalled();
  });

  it('プロファイルの取得自体が失敗したときも 404 / profile_not_found で拒否される (fail-closed) (#1109)', async () => {
    const db = setup({
      profileFailure: { code: '57014', message: 'canceling statement due to statement timeout' },
    });

    const { status, json } = await postSandbox();

    expect(status).toBe(404);
    expect(json.error).toMatchObject({ code: 'profile_not_found' });
    expect(db.state.writes).toEqual([]);
    expect(loggerError).toHaveBeenCalled();
  });

  it('既存の通常データがあるユーザーは 409 / existing_user で拒否され、何も書き込まれない', async () => {
    const db = setup({ rpcResult: { data: true, error: null } });

    const { status, json } = await postSandbox();

    expect(status).toBe(409);
    expect(json.error).toMatchObject({ code: 'sandbox_not_eligible', reason: 'existing_user' });
    expect(db.state.rpcCalls).toEqual(['user_has_non_sandbox_activity']);
    expect(db.state.writes).toEqual([]);
  });

  it('既存データ判定の RPC が失敗したときは 409 / existing_user で拒否される (fail-closed) (#1109)', async () => {
    const db = setup({ rpcResult: { data: null, error: { code: '42501', message: 'permission denied' } } });

    const { status, json } = await postSandbox();

    expect(status).toBe(409);
    expect(json.error).toMatchObject({ code: 'sandbox_not_eligible', reason: 'existing_user' });
    expect(db.state.writes).toEqual([]);
    expect(loggerError).toHaveBeenCalled();
  });

  it('sandbox でない通常の保存では適格性チェックをせず、user_daily_meals は is_sandbox=false で作られる', async () => {
    // 管理者ロールでも通常の写真保存は従来どおり使える
    const db = setup({ profile: eligibleProfile(USER_ID, { roles: ['admin'] }) });

    const res = await POST(makeRequest(baseBody, 'normal'));

    expect(res.status).toBe(200);
    expect(db.state.profileFilters).toEqual([]);
    expect(db.state.rpcCalls).toEqual([]);
    const dailyInsert = db.state.writes.find((w) => w.table === 'user_daily_meals' && w.op === 'insert');
    expect(dailyInsert?.payload).toMatchObject({ is_sandbox: false });
  });
});
