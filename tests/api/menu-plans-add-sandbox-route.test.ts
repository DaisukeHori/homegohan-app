/**
 * tests/api/menu-plans-add-sandbox-route.test.ts
 *
 * POST /api/menu-plans/add の sandbox 適格性チェックの route レベル回帰テスト。
 *
 * #1025 でこの route の判定は fail-closed に直っていたが、同じ判定のコピーを持つ
 * meal-plans/add-from-photo は直っていなかった (#1109)。#1109 で判定を共通ヘルパー
 * (src/lib/handson-tour/sandbox-eligibility.ts) に集約したので、集約後も
 * この route の応答 (ステータス・error の形・書き込みの有無) が変わらないことを固定する。
 *
 * Supabase モックは tests/helpers/fake-sandbox-supabase.ts。user_profiles は実テーブルと
 * 同じく id でしか引けない (user_id で引くと 42703)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeSandboxDb,
  eligibleProfile,
  type FakeSandboxDbOptions,
} from '../helpers/fake-sandbox-supabase';

const USER_ID = 'user-1';

// db-logger はモックする (app_logs への書き込みを避ける)
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
  generateRequestId: () => 'req_test',
}));

vi.mock('@/lib/badges/awardBadge', () => ({
  awardBadge: vi.fn(async () => ({
    awarded: false,
    badge_id: null,
    obtained_at: null,
    name: null,
    icon_url: null,
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentClient: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentAdminClient: any;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentClient,
  getSupabaseAdmin: () => currentAdminClient,
}));

import { POST } from '../../src/app/api/menu-plans/add/route';

// ── ヘルパー ─────────────────────────────────────────────────────────────────

/** menu-plans/add が利用者セッションで行う weekly_menu_requests の操作の結果 */
const sessionTables: FakeSandboxDbOptions['tables'] = {
  weekly_menu_requests: ({ op }) =>
    op === 'insert' ? { data: { id: 'req-1' }, error: null } : { data: null, error: null },
};

function setup(options: Omit<FakeSandboxDbOptions, 'userId' | 'tables'> = {}) {
  const db = createFakeSandboxDb({
    userId: USER_ID,
    profile: eligibleProfile(USER_ID),
    ...options,
    tables: sessionTables,
  });
  currentClient = db.client;

  // weekly_menus への INSERT だけは service_role で行う
  const admin = createFakeSandboxDb({
    userId: USER_ID,
    tables: { weekly_menus: () => ({ data: { id: 'menu-1' }, error: null }) },
  });
  currentAdminClient = admin.client;

  return { ...db, admin };
}

const menuBody = {
  date_offset_days: 1,
  meal_type: 'dinner',
  dish_name: '豚肉と野菜の生姜焼き',
  calories: 620,
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://homegohan-app.vercel.app/api/menu-plans/add?source=handson_tour', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postSandbox() {
  const res = await POST(makeRequest({ ...menuBody, sandbox: true }));
  return { status: res.status, json: await res.json() };
}

const FINISHED_AT = '2026-07-01T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── テスト ───────────────────────────────────────────────────────────────────

describe('POST /api/menu-plans/add の sandbox 適格性チェック (共通ヘルパー集約後も同じ応答)', () => {
  it('未認証なら 401 を返し、DB には何も触れない', async () => {
    const db = setup();
    db.client.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('no session') });

    const { status, json } = await postSandbox();

    expect(status).toBe(401);
    expect(json.error).toMatchObject({ code: 'unauthorized' });
    expect(db.client.from).not.toHaveBeenCalled();
  });

  it('適格ユーザーは 200 で献立を追加でき、user_profiles は主キー id で引かれる', async () => {
    const db = setup();

    const { status, json } = await postSandbox();

    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, menu_id: 'menu-1' });
    expect(db.state.profileFilters).toEqual([['id', USER_ID]]);
    expect(db.state.writes.some((w) => w.table === 'weekly_menu_requests' && w.op === 'insert')).toBe(true);
  });

  it.each([
    [
      'ツアー完了済み',
      { profile: eligibleProfile(USER_ID, { handson_tour_completed_at: FINISHED_AT }) },
      409,
      { code: 'sandbox_not_eligible', reason: 'already_finished' },
    ],
    [
      'ツアースキップ済み',
      { profile: eligibleProfile(USER_ID, { handson_tour_skipped_at: FINISHED_AT }) },
      409,
      { code: 'sandbox_not_eligible', reason: 'already_finished' },
    ],
    [
      '管理者ロール',
      { profile: eligibleProfile(USER_ID, { roles: ['user', 'admin'] }) },
      403,
      { code: 'sandbox_not_eligible', reason: 'admin_role' },
    ],
    [
      'プロファイルの行なし',
      { profile: null },
      404,
      { code: 'profile_not_found' },
    ],
    [
      'プロファイル取得の失敗',
      { profileFailure: { code: '57014', message: 'statement timeout' } },
      404,
      { code: 'profile_not_found' },
    ],
    [
      '既存の通常データあり',
      { rpcResult: { data: true, error: null } },
      409,
      { code: 'sandbox_not_eligible', reason: 'existing_user' },
    ],
    [
      '既存データ判定 RPC の失敗',
      { rpcResult: { data: null, error: { code: '42501', message: 'permission denied' } } },
      409,
      { code: 'sandbox_not_eligible', reason: 'existing_user' },
    ],
  ] as const)('%s は拒否され、何も書き込まれない', async (_label, overrides, expectedStatus, expectedError) => {
    const db = setup(overrides as Omit<FakeSandboxDbOptions, 'userId' | 'tables'>);

    const { status, json } = await postSandbox();

    expect(status).toBe(expectedStatus);
    expect(json.error).toMatchObject(expectedError);
    expect(db.state.writes).toEqual([]);
    expect(db.admin.state.writes).toEqual([]);
  });

  it('sandbox でない通常の追加では適格性チェックをしない', async () => {
    // 管理者ロールでも通常の献立追加は従来どおり使える
    const db = setup({ profile: eligibleProfile(USER_ID, { roles: ['admin'] }) });

    const res = await POST(makeRequest(menuBody));

    expect(res.status).toBe(200);
    expect(db.state.profileFilters).toEqual([]);
    expect(db.state.rpcCalls).toEqual([]);
  });
});
