// @vitest-environment node
/**
 * #1172 第 2 段: src/app/api の残りの route が、DB の生のエラー文・例外の文面を本文に返さないことの回帰テスト
 *
 * 修正前:
 *   DB (Supabase / PostgREST) がエラーを返すと、route は `NextResponse.json({ error: error.message }, { status: 500 })` で
 *   その文面をそのまま返していた。RPC のエラーを `{ error: { code, message: rpcError.message } }` で返す route や、
 *   内部の関数が受け取った DB のエラー文を route がそのまま本文にする route もあった。
 * 修正後:
 *   500 は共通ヘルパー internalError() (src/lib/api/errors.ts) で返す。本文は汎用メッセージだけで、
 *   元のエラーは handler の名前で構造化ログ (app_logs) にだけ残る。
 *   4xx で理由を伝える route は、こちらで決めた固定の文を返す。
 *
 * 置き換えた箇所は多いので、ここでは代表の route と、手で直した形 (RPC のコードの振り分け・運営 API の入れ子の形・
 * 内部の関数の結果) を確かめる。全 route の本文に生のエラー文を入れていないかは、ソースの走査
 * (tests/api-raw-error-message-scan.test.ts。よくある書き方の見張り) が見る。
 *
 * Supabase には接続しない (createClient をモック)。構造化ログもモックなので app_logs へは書かない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';

// ---- モックの状態 -----------------------------------------------------------------

type QueryResult = { data?: unknown; error?: unknown; count?: number | null };

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  /** from() が呼ばれるたびに 1 つずつ使う結果。最後の 1 つは使い回す */
  queue: [] as Array<{ data?: unknown; error?: unknown; count?: number | null }>,
  /** rpc() の結果 */
  rpcResult: { data: null, error: null } as { data: unknown; error: unknown },
  /** 設定すると、from() がこの例外を投げる (catch 経由の 500 を再現する) */
  fromThrows: null as Error | null,
  logCalls: [] as Array<{
    routeName: string;
    userId?: string;
    message: string;
    error: unknown;
    metadata?: Record<string, unknown>;
  }>,
  requireRole: vi.fn(),
}));

/** どのメソッドをチェーンしても自分を返し、await されると結果を返すクエリビルダーのモック */
function makeBuilder(result: QueryResult) {
  const settled = { data: null, error: null, count: null, ...result };
  const proxy: unknown = new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(settled).then(resolve, reject);
      }
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    from: () => {
      if (h.fromThrows) throw h.fromThrows;
      const next = h.queue.length > 1 ? h.queue.shift()! : (h.queue[0] ?? {});
      return makeBuilder(next);
    },
    rpc: async () => h.rpcResult,
  };
}

vi.mock('@/lib/supabase/server', () => ({
  // createClient() は async の route と同期の route の両方がある。await しても、しなくても同じクライアントになるようにする
  createClient: () => {
    const client = makeClient();
    return Object.assign(Promise.resolve(client), client);
  },
}));

// 構造化ログ: app_logs へは書かず、呼び出しを記録する
vi.mock('@/lib/db-logger', () => ({
  createLogger: (routeName: string) => {
    const make = (userId?: string) => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: string, error?: unknown, metadata?: Record<string, unknown>) => {
        h.logCalls.push({ routeName, userId, message, error, metadata });
      },
    });
    return { ...make(), withUser: (userId: string) => make(userId) };
  },
  generateRequestId: () => 'req_test',
}));

vi.mock('@/lib/auth/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/helpers')>()),
  requireRole: h.requireRole,
}));

import * as pantry from '@/app/api/pantry/route';
import * as shoppingList from '@/app/api/shopping-list/route';
import * as notificationPreferences from '@/app/api/notification-preferences/route';
import * as performanceSports from '@/app/api/performance/sports/route';
import * as performancePlans from '@/app/api/performance/plans/route';
import * as performanceCheckins from '@/app/api/performance/checkins/route';
import * as performanceAnalyze from '@/app/api/performance/analyze/route';
import * as onboardingStatus from '@/app/api/onboarding/status/route';
import * as importantMessages from '@/app/api/ai/consultation/important-messages/route';
import * as recipeById from '@/app/api/recipes/[id]/route';
import * as superAdminSettings from '@/app/api/super-admin/settings/route';
import * as orgInviteAccept from '@/app/api/org/invites/[id]/accept/route';
import * as orgInviteReject from '@/app/api/org/invites/[id]/reject/route';

// ---- テストデータ -----------------------------------------------------------------

/** DB が返した生のエラー文の代わり。これが本文に出たら漏れている (テーブル名・制約名を含む形にしてある) */
const RAW_DB_MESSAGE =
  'duplicate key value violates unique constraint "secret_constraint_xyz" on table "secret_table_xyz"';
/** PostgREST の details / hint の代わり (UNIQUE 違反では衝突した値が入る) */
const RAW_DB_DETAILS = 'Key (email)=(secret_value_xyz@example.com) already exists.';
const RAW_DB_HINT = 'secret_hint_xyz';
/** 例外 (catch 経由) の生の文面。接続先のような内部情報を含む形にしてある */
const RAW_THROWN_MESSAGE = 'connect ECONNREFUSED 10.9.8.7:5432 (secret_host_xyz)';

const DB_ERROR = { message: RAW_DB_MESSAGE, code: '23505', details: RAW_DB_DETAILS, hint: RAW_DB_HINT };
const FAIL: QueryResult = { data: null, error: DB_ERROR };

/** 本文に出てはいけない文字列 */
const SECRETS = ['secret_constraint_xyz', 'secret_table_xyz', 'secret_value_xyz', 'secret_hint_xyz', 'secret_host_xyz', '10.9.8.7'];

const FLAT_BODY = { error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE };
const NESTED_BODY = { error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } };

const url = (path: string) => `http://localhost${path}`;
const get = (path: string) => new NextRequest(url(path));
const jsonRequest = (path: string, method: string, body: unknown) =>
  new NextRequest(url(path), { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

/** 本文に生のエラー文が 1 文字も出ていないこと */
async function readBody(res: Response) {
  const text = await res.text();
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  return JSON.parse(text) as unknown;
}

/** 元のエラーが handler の名前で 1 回だけ構造化ログに残ったこと */
function expectLoggedOnce(routeName: string, rawMessage: string, userId?: string) {
  const calls = h.logCalls.filter((call) => call.routeName === routeName);
  expect(calls, `${routeName} のログ (全体: ${JSON.stringify(h.logCalls.map((c) => c.routeName))})`).toHaveLength(1);
  expect(calls[0].error).toBeInstanceOf(Error);
  expect((calls[0].error as Error).message).toBe(rawMessage);
  expect(calls[0].userId).toBe(userId);
}

beforeEach(() => {
  h.user = { id: 'user-1' };
  h.queue = [];
  h.rpcResult = { data: null, error: null };
  h.fromThrows = null;
  h.logCalls = [];
  h.requireRole.mockReset();
  h.requireRole.mockResolvedValue({ id: 'admin-1', roles: ['super_admin'] });
});

// ---- 代表の route: DB のエラーで 500 -----------------------------------------------

describe('#1172 第 2 段: DB のエラーで 500 を返す route は、汎用メッセージだけを返し、元のエラーをログに残す', () => {
  it.each([
    ['GET /api/pantry', () => pantry.GET(get('/api/pantry')), 'user-1'],
    ['GET /api/shopping-list', () => shoppingList.GET(get('/api/shopping-list')), 'user-1'],
    ['GET /api/notification-preferences', () => notificationPreferences.GET(get('/api/notification-preferences')), 'user-1'],
    // 認証の要らない公開データ。利用者 ID はログに付かない
    ['GET /api/performance/sports', () => performanceSports.GET(get('/api/performance/sports')), undefined],
    ['GET /api/performance/plans', () => performancePlans.GET(get('/api/performance/plans')), 'user-1'],
    ['GET /api/performance/checkins', () => performanceCheckins.GET(get('/api/performance/checkins')), 'user-1'],
    ['GET /api/onboarding/status', () => onboardingStatus.GET(), 'user-1'],
    ['GET /api/ai/consultation/important-messages', () => importantMessages.GET(get('/api/ai/consultation/important-messages')), 'user-1'],
    ['GET /api/recipes/[id]', () => recipeById.GET(get('/api/recipes/r-1'), { params: { id: 'r-1' } }), 'user-1'],
  ] as const)('%s', async (routeName, call, userId) => {
    h.queue = [FAIL];

    const res = await call();

    expect(res.status).toBe(500);
    expect(await readBody(res)).toEqual(FLAT_BODY);
    expectLoggedOnce(routeName, RAW_DB_MESSAGE, userId);
  });
});

// ---- 内部の関数が DB のエラーを返す route (performance/analyze) -----------------------

describe('#1172 第 2 段: /api/performance/analyze は、内部の関数が受け取った DB のエラー文を本文に出さない', () => {
  beforeEach(() => {
    // プロフィール・栄養目標は読める。7 日平均の RPC だけが失敗する
    h.queue = [
      { data: { weight: 60, nutrition_goal: 'maintain', performance_profile: null } },
      { data: { daily_calories: 2000, protein_g: 100, fat_g: 60, carbs_g: 250 } },
    ];
    h.rpcResult = { data: null, error: DB_ERROR };
  });

  it('GET: 汎用の 500 (以前は内部の関数が返した DB のエラー文を本文にしていた)', async () => {
    const res = await performanceAnalyze.GET(get('/api/performance/analyze?date=2026-10-01'));

    expect(res.status).toBe(500);
    expect(await readBody(res)).toEqual(FLAT_BODY);
    expectLoggedOnce('GET /api/performance/analyze', RAW_DB_MESSAGE, 'user-1');
  });

  it('POST: 汎用の 500', async () => {
    const res = await performanceAnalyze.POST(jsonRequest('/api/performance/analyze', 'POST', { date: '2026-10-01' }));

    expect(res.status).toBe(500);
    expect(await readBody(res)).toEqual(FLAT_BODY);
    expectLoggedOnce('POST /api/performance/analyze', RAW_DB_MESSAGE, 'user-1');
  });

  it('プロフィールが無いときの 404 は今までどおり (こちらで決めた文)', async () => {
    h.queue = [{ data: null, error: null }];

    const res = await performanceAnalyze.GET(get('/api/performance/analyze?date=2026-10-01'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Profile not found' });
    expect(h.logCalls).toEqual([]);
  });
});

// ---- 運営 API ({ error: { code, message } } の形) ------------------------------------

describe('#1172 第 2 段: 運営 API (super-admin/settings) は入れ子の形のまま汎用の 500 を返す', () => {
  it('PUT: DB のエラーは { error: { code, message } } の汎用の 500 (以前は生のエラー文)', async () => {
    h.queue = [FAIL];

    const res = await superAdminSettings.PUT(
      jsonRequest('/api/super-admin/settings', 'PUT', { key: 'maintenance', value: true }),
    );

    expect(res.status).toBe(500);
    expect(await readBody(res)).toEqual(NESTED_BODY);
    expectLoggedOnce('PUT /api/super-admin/settings', RAW_DB_MESSAGE, 'admin-1');
  });

  it('GET / PUT: 途中の例外も、handler の名前で記録して汎用の 500 (以前は例外の文面を返していた)', async () => {
    h.requireRole.mockRejectedValue(new Error(RAW_THROWN_MESSAGE));

    const getRes = await superAdminSettings.GET();
    expect(getRes.status).toBe(500);
    expect(await readBody(getRes)).toEqual(NESTED_BODY);
    expectLoggedOnce('GET /api/super-admin/settings', RAW_THROWN_MESSAGE);

    const putRes = await superAdminSettings.PUT(
      jsonRequest('/api/super-admin/settings', 'PUT', { key: 'maintenance', value: true }),
    );
    expect(putRes.status).toBe(500);
    expect(await readBody(putRes)).toEqual(NESTED_BODY);
    expectLoggedOnce('PUT /api/super-admin/settings', RAW_THROWN_MESSAGE);
  });
});

// ---- RPC のエラーをコードで振り分ける route (org の招待) ---------------------------------

describe('#1172 第 2 段: org の招待の承諾・辞退は、RPC の文面を返さない', () => {
  const callAccept = () => orgInviteAccept.POST(new Request(url('/api/org/invites/tok/accept'), { method: 'POST' }), {
    params: Promise.resolve({ id: 'tok' }),
  });
  const callReject = () => orgInviteReject.POST(new Request(url('/api/org/invites/tok/reject'), { method: 'POST' }), {
    params: Promise.resolve({ id: 'tok' }),
  });

  it.each([
    ['INVITE_EXPIRED', 410],
    ['ALREADY_IN_ORG', 409],
    ['INVITE_EMAIL_MISMATCH', 403],
  ])('承諾: RPC が %s -> %i とコード、固定の文 (画面はコードで出し分ける)', async (code, status) => {
    h.rpcResult = { data: null, error: { message: code, code: 'P0001' } };

    const res = await callAccept();

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code, message: '招待の承諾に失敗しました' } });
    expect(h.logCalls).toEqual([]);
  });

  it('承諾: 分からないエラーは汎用の 500 (入れ子の形) にして、生のエラー文はログにだけ残す', async () => {
    h.rpcResult = { data: null, error: DB_ERROR };

    const res = await callAccept();

    expect(res.status).toBe(500);
    expect(await readBody(res)).toEqual(NESTED_BODY);
    expectLoggedOnce('POST /api/org/invites/[id]/accept', RAW_DB_MESSAGE, 'user-1');
  });

  it('辞退: 分かるコードは固定の文、分からないエラーは汎用の 500', async () => {
    h.rpcResult = { data: null, error: { message: 'INVITE_NOT_FOUND', code: 'P0001' } };
    const notFound = await callReject();
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: { code: 'INVITE_NOT_FOUND', message: '招待の辞退に失敗しました' } });

    h.rpcResult = { data: null, error: DB_ERROR };
    const failed = await callReject();
    expect(failed.status).toBe(500);
    expect(await readBody(failed)).toEqual(NESTED_BODY);
    expectLoggedOnce('POST /api/org/invites/[id]/reject', RAW_DB_MESSAGE);
  });
});
