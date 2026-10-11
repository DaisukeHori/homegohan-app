// @vitest-environment node
/**
 * #1172 第 1 段: /api/health/** と /api/profile の 500 が、DB の生のエラー文を返さないことの回帰テスト
 *
 * 修正前:
 *   DB (Supabase / PostgREST) がエラーを返すと、route は `NextResponse.json({ error: error.message }, { status: 500 })` で
 *   その文面をそのままブラウザ・モバイルに返していた。文面にはテーブル名・列名・制約名が入る
 *   (例: `duplicate key value violates unique constraint "health_goals_pkey"`)。
 *   catch で受けた例外も `error instanceof Error ? error.message : ...` をそのまま返していた。
 * 修正後:
 *   本文は汎用メッセージだけ ({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' })。
 *   詳細は共通ヘルパー internalError() (src/lib/api/errors.ts) が構造化ログ (app_logs) にだけ残す。
 *
 * このテストは「32 か所の 500 の返し方」を 1 か所ずつ確かめる:
 *   1. ステータスは 500 のまま
 *   2. 本文は汎用メッセージだけ。DB の生のエラー文・テーブル名・制約名・接続先が 1 文字も出ない
 *   3. 元のエラーが、その handler の名前 (GET /api/health/goals など) で構造化ログに 1 回だけ残る
 *   4. 認証済みの経路では、ログに利用者 ID が付く
 *
 * Supabase には接続しない (createClient をモック)。構造化ログもモックなので app_logs へは書かない。
 * ソースの走査 (JSON 本文に error.message を入れていないか) は tests/api-raw-error-message-scan.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---- モックの状態 -----------------------------------------------------------------

type QueryResult = { data?: unknown; error?: unknown; count?: number | null };

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  /** from() が呼ばれるたびに 1 つずつ使う結果。最後の 1 つは使い回す */
  queue: [] as Array<{ data?: unknown; error?: unknown; count?: number | null }>,
  /** 設定すると、from() がこの例外を投げる (catch 経由の 500 を再現する) */
  fromThrows: null as Error | null,
  logCalls: [] as Array<{
    routeName: string;
    userId?: string;
    message: string;
    error: unknown;
    metadata?: Record<string, unknown>;
  }>,
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

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    from: () => {
      if (h.fromThrows) throw h.fromThrows;
      const next = h.queue.length > 1 ? h.queue.shift()! : (h.queue[0] ?? {});
      return makeBuilder(next);
    },
  }),
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

// POST /api/health/blood-tests と /checkups は LLM とレート制限を使う。500 の経路では使わないので軽いモックにする
vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: vi.fn(),
  getFastLLMModel: vi.fn(() => 'test-model'),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
// #1177 / #1149: AI 利用回数の上限の判定と記録 (DB を呼ぶ境目)。本物は、DB に繋げないと「判定と記録に失敗した」ログを 1 件足す (許可して先へ進む) ので、
// 「元のエラーが構造化ログに 1 回だけ残る」の数え方が変わる。この関数の挙動は src/__tests__/lib/plan/entitlements.test.ts
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  consumeAiUsage: vi.fn(async () => (await import('./helpers/ai-usage-mock')).AI_USAGE_ALLOWED),
  refundAiUsage: vi.fn(async () => undefined),
}));

import * as streaks from '@/app/api/health/streaks/route';
import * as goals from '@/app/api/health/goals/route';
import * as goalById from '@/app/api/health/goals/[id]/route';
import * as records from '@/app/api/health/records/route';
import * as recordsHistory from '@/app/api/health/records/history/route';
import * as recordByDate from '@/app/api/health/records/[date]/route';
import * as recordsQuick from '@/app/api/health/records/quick/route';
import * as bloodTests from '@/app/api/health/blood-tests/route';
import * as notificationPreferences from '@/app/api/health/notifications/preferences/route';
import * as checkups from '@/app/api/health/checkups/route';
import * as checkupById from '@/app/api/health/checkups/[id]/route';
import * as challenges from '@/app/api/health/challenges/route';
import * as insightRead from '@/app/api/health/insights/[id]/read/route';
import * as profile from '@/app/api/profile/route';

// ---- テストデータ -----------------------------------------------------------------

/** DB が返した生のエラー文の代わり。これが本文に出たら漏れている (テーブル名・制約名を含む形にしてある) */
const RAW_DB_MESSAGE =
  'duplicate key value violates unique constraint "secret_constraint_xyz" on table "secret_table_xyz"';
/** 例外 (catch 経由) の生の文面。接続先のような内部情報を含む形にしてある */
const RAW_THROWN_MESSAGE = 'connect ECONNREFUSED 10.9.8.7:5432 (secret_host_xyz)';

const DB_ERROR = {
  message: RAW_DB_MESSAGE,
  // PGRST116 (行が無い) ではない: 行が無いだけなら握りつぶして 200 を返す handler があるため
  code: '23505',
  details: 'Key (user_id)=(user-1) already exists.',
  hint: null,
};
const FAIL: QueryResult = { data: null, error: DB_ERROR };

const EXISTING_GOAL = {
  id: 'goal-1',
  user_id: 'user-1',
  goal_type: 'weight',
  target_value: 60,
  target_unit: 'kg',
  start_value: 70,
  current_value: 70,
  progress_percentage: 0,
  milestones: [],
  status: 'active',
  achieved_at: null,
};

function req(method: string, path: string, body?: unknown): NextRequest {
  const url = `http://localhost${path}`;
  return body === undefined
    ? new NextRequest(url, { method })
    : new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const idParams = { params: Promise.resolve({ id: 'row-1' }) };
const dateParams = { params: Promise.resolve({ date: '2026-10-08' }) };

interface Case {
  /** handler (構造化ログの function_name にもなる) */
  routeName: string;
  /** from() が返す結果の並び。最後に失敗するクエリまで、handler が発行する順に並べる */
  queue?: QueryResult[];
  run: () => Promise<Response>;
}

const cases: Case[] = [
  // ── /api/health/streaks ─────────────────────────────────────────────────────────
  { routeName: 'GET /api/health/streaks', queue: [FAIL], run: () => streaks.GET(req('GET', '/api/health/streaks')) },
  { routeName: 'DELETE /api/health/streaks', queue: [FAIL], run: () => streaks.DELETE(req('DELETE', '/api/health/streaks')) },

  // ── /api/health/goals ───────────────────────────────────────────────────────────
  { routeName: 'GET /api/health/goals', queue: [FAIL], run: () => goals.GET(req('GET', '/api/health/goals')) },
  {
    routeName: 'POST /api/health/goals',
    // プロフィールの体重を読んでから health_goals に insert する
    queue: [{ data: { weight: 70 } }, FAIL],
    run: () => goals.POST(req('POST', '/api/health/goals', { goal_type: 'weight', target_value: 60, target_unit: 'kg' })),
  },

  // ── /api/health/goals/[id] ──────────────────────────────────────────────────────
  { routeName: 'GET /api/health/goals/[id]', queue: [FAIL], run: () => goalById.GET(req('GET', '/api/health/goals/row-1'), idParams) },
  {
    routeName: 'PUT /api/health/goals/[id]',
    // 既存の目標を読んでから update する
    queue: [{ data: EXISTING_GOAL }, FAIL],
    run: () => goalById.PUT(req('PUT', '/api/health/goals/row-1', { current_value: 65 }), idParams),
  },
  { routeName: 'DELETE /api/health/goals/[id]', queue: [FAIL], run: () => goalById.DELETE(req('DELETE', '/api/health/goals/row-1'), idParams) },

  // ── /api/health/records ─────────────────────────────────────────────────────────
  { routeName: 'GET /api/health/records', queue: [FAIL], run: () => records.GET(req('GET', '/api/health/records')) },
  {
    routeName: 'POST /api/health/records',
    queue: [FAIL],
    run: () => records.POST(req('POST', '/api/health/records', { record_date: '2026-10-08', weight: 60 })),
  },
  { routeName: 'GET /api/health/records/history', queue: [FAIL], run: () => recordsHistory.GET(req('GET', '/api/health/records/history')) },
  {
    routeName: 'GET /api/health/records/[date]',
    queue: [FAIL],
    run: () => recordByDate.GET(req('GET', '/api/health/records/2026-10-08'), dateParams),
  },
  {
    routeName: 'PUT /api/health/records/[date]',
    queue: [FAIL],
    run: () => recordByDate.PUT(req('PUT', '/api/health/records/2026-10-08', { weight: 60 }), dateParams),
  },
  {
    routeName: 'DELETE /api/health/records/[date]',
    queue: [FAIL],
    run: () => recordByDate.DELETE(req('DELETE', '/api/health/records/2026-10-08'), dateParams),
  },
  {
    routeName: 'POST /api/health/records/quick',
    queue: [FAIL],
    run: () => recordsQuick.POST(req('POST', '/api/health/records/quick', { weight: 60 })),
  },

  // ── /api/health/blood-tests ─────────────────────────────────────────────────────
  { routeName: 'GET /api/health/blood-tests', queue: [FAIL], run: () => bloodTests.GET(req('GET', '/api/health/blood-tests')) },
  {
    routeName: 'POST /api/health/blood-tests',
    queue: [FAIL],
    run: () => bloodTests.POST(req('POST', '/api/health/blood-tests', { test_date: '2026-10-08', hba1c: 5.6 })),
  },

  // ── /api/health/notifications/preferences ───────────────────────────────────────
  {
    routeName: 'GET /api/health/notifications/preferences',
    queue: [FAIL],
    run: () => notificationPreferences.GET(req('GET', '/api/health/notifications/preferences')),
  },
  {
    routeName: 'PUT /api/health/notifications/preferences',
    // 既存の設定を読んでから update する
    queue: [{ data: { id: 'pref-1' } }, FAIL],
    run: () => notificationPreferences.PUT(req('PUT', '/api/health/notifications/preferences', { enabled: true })),
  },

  // ── /api/health/checkups ────────────────────────────────────────────────────────
  { routeName: 'GET /api/health/checkups', queue: [FAIL], run: () => checkups.GET(req('GET', '/api/health/checkups')) },
  {
    routeName: 'POST /api/health/checkups',
    queue: [FAIL],
    run: () => checkups.POST(req('POST', '/api/health/checkups', { checkup_date: '2026-10-08' })),
  },
  { routeName: 'GET /api/health/checkups/[id]', queue: [FAIL], run: () => checkupById.GET(req('GET', '/api/health/checkups/row-1'), idParams) },
  {
    routeName: 'PUT /api/health/checkups/[id]',
    // 所有権の確認 (行がある) のあとに update する
    queue: [{ data: { id: 'row-1' } }, FAIL],
    run: () => checkupById.PUT(req('PUT', '/api/health/checkups/row-1', { weight: 60 }), idParams),
  },
  {
    routeName: 'DELETE /api/health/checkups/[id]',
    // 所有権の確認 (画像なし) のあとに delete する
    queue: [{ data: { id: 'row-1', image_url: null } }, FAIL],
    run: () => checkupById.DELETE(req('DELETE', '/api/health/checkups/row-1'), idParams),
  },

  // ── /api/health/challenges ──────────────────────────────────────────────────────
  { routeName: 'GET /api/health/challenges', queue: [FAIL], run: () => challenges.GET(req('GET', '/api/health/challenges')) },
  {
    routeName: 'POST /api/health/challenges',
    queue: [FAIL],
    run: () => challenges.POST(req('POST', '/api/health/challenges', { template_id: 'weight_loss_week' })),
  },

  // ── /api/health/insights/[id]/read ──────────────────────────────────────────────
  {
    routeName: 'POST /api/health/insights/[id]/read',
    queue: [FAIL],
    run: () => insightRead.POST(req('POST', '/api/health/insights/row-1/read'), idParams),
  },

  // ── /api/profile (DB のエラー) ──────────────────────────────────────────────────
  { routeName: 'GET /api/profile', queue: [FAIL], run: () => profile.GET() },
  {
    routeName: 'POST /api/profile',
    queue: [FAIL],
    run: () => profile.POST(req('POST', '/api/profile', { nickname: 'taro' })),
  },
  {
    routeName: 'PUT /api/profile',
    queue: [FAIL],
    run: () => profile.PUT(req('PUT', '/api/profile', { nickname: 'taro' })),
  },
];

/** catch で受ける例外 (from() が投げる。DB に届く前の失敗など)。文面に内部情報が入っていても返さない */
const thrownCases: Case[] = [
  { routeName: 'GET /api/profile', run: () => profile.GET() },
  {
    routeName: 'POST /api/profile',
    run: () => profile.POST(req('POST', '/api/profile', { nickname: 'taro' })),
  },
  {
    routeName: 'PUT /api/profile',
    run: () => profile.PUT(req('PUT', '/api/profile', { nickname: 'taro' })),
  },
];

const GENERIC_BODY = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };

beforeEach(() => {
  h.user = { id: 'user-1' };
  h.queue = [];
  h.fromThrows = null;
  h.logCalls.length = 0;
  // handler が console.error を出しても、テストの出力を汚さない
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('DB のエラーを受けたとき (#1172 第 1 段)', () => {
  it.each(cases.map((c) => [c.routeName, c] as const))(
    '%s: 汎用の 500 を返し、生のエラー文は本文に出さず、構造化ログに残す',
    async (_name, c) => {
      h.queue = [...(c.queue ?? [])];

      const res = await c.run();
      const text = await res.text();

      expect(res.status).toBe(500);
      // 生の文面・テーブル名・制約名のどれも、本文のどこにも出ない
      for (const leaked of [RAW_DB_MESSAGE, 'secret_constraint_xyz', 'secret_table_xyz', '23505']) {
        expect(text, `本文に ${leaked} が出ている: ${text}`).not.toContain(leaked);
      }
      expect(JSON.parse(text)).toEqual(GENERIC_BODY);

      // 元のエラーは、その handler の名前で 1 回だけ、利用者 ID 付きで構造化ログに残る
      expect(h.logCalls).toHaveLength(1);
      const [logged] = h.logCalls;
      expect(logged.routeName).toBe(c.routeName);
      expect(logged.userId).toBe('user-1');
      expect((logged.error as { message?: string }).message).toBe(RAW_DB_MESSAGE);
    },
  );

  it('走査が機能している: 32 か所の 500 を確かめている (health 26 + profile 6)', () => {
    // handler を足したり外したりしたら、この数と上の表を合わせること
    expect(cases.length + thrownCases.length).toBe(32);
  });
});

describe('例外を catch したとき (#1172 第 1 段)', () => {
  it.each(thrownCases.map((c) => [c.routeName, c] as const))(
    '%s: 例外の文面を本文に出さず、汎用の 500 を返して構造化ログに残す',
    async (_name, c) => {
      h.fromThrows = new Error(RAW_THROWN_MESSAGE);

      const res = await c.run();
      const text = await res.text();

      expect(res.status).toBe(500);
      for (const leaked of [RAW_THROWN_MESSAGE, 'ECONNREFUSED', '10.9.8.7', 'secret_host_xyz']) {
        expect(text, `本文に ${leaked} が出ている: ${text}`).not.toContain(leaked);
      }
      expect(JSON.parse(text)).toEqual(GENERIC_BODY);

      expect(h.logCalls).toHaveLength(1);
      expect(h.logCalls[0].routeName).toBe(c.routeName);
      expect((h.logCalls[0].error as Error).message).toBe(RAW_THROWN_MESSAGE);
    },
  );
});

describe('500 以外の応答は変えていない', () => {
  it('未ログインは 401 のまま (ログも出さない)', async () => {
    h.user = null;

    const res = await goals.GET(req('GET', '/api/health/goals'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(h.logCalls).toEqual([]);
  });

  it('入力が不正なら 400 のまま (こちらが書いた検証メッセージを返し、500 の汎用メッセージにしない)', async () => {
    const res = await goals.POST(req('POST', '/api/health/goals', { goal_type: 'weight', target_value: -5, target_unit: 'kg' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).not.toBe(GENERIC_BODY.error);
    expect(h.logCalls).toEqual([]);
  });

  it('GET /api/health/records/[date]: 行が無いだけ (PGRST116) なら 200 で record: null を返す', async () => {
    h.queue = [{ data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }];

    const res = await recordByDate.GET(req('GET', '/api/health/records/2026-10-08'), dateParams);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ record: null, previous: null });
    expect(h.logCalls).toEqual([]);
  });
});
