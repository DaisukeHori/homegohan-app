/**
 * #1507: 状態の確認 (GET /api/ai/menu/weekly/status)・生成中の行の確認 (GET /api/ai/menu/weekly/pending・
 * GET /api/ai/menu/meal/pending) の止まりの判定を、ローカル Supabase の実 DB に対して確かめる。
 *
 * #1494 で cleanup は生存信号 GREATEST(worker_acquired_at, updated_at) と比較つきの更新で止まりを判定するようになったが、
 * この 3 つは updated_at だけで判定していた。claim_menu_request は取り直すときに updated_at を書かないので、
 * 20 分を超えて順番待ちした queued の行を cron が processing にした直後 (Edge Function が最初の進捗を書くまでの数秒)、
 * status の 3 秒ごとのポーリングがその行を failed にしえた。
 *
 * ここで確かめること (route のハンドラーをそのまま呼ぶ。利用者のクライアントと service role のクライアントは実物):
 *   S-1: status: claim_menu_request が取り直した直後 (worker_acquired_at が新しく updated_at が古い) の行は failed にしない
 *   S-2: status: 生存信号から 20 分を超えて止まった行は failed にし、stale の文を書く
 *        (PostgREST が返すマイクロ秒つきの時刻でも、比較つきの更新が一致する)
 *   S-3: status: 読んでから書くまでのあいだに進捗を書いた行は failed にしない (比較つきの更新)
 *   P-1: weekly/pending: 取り直した直後の行は生成中として返し、止まった行は failed にする
 *   M-1: meal/pending: 取り直した直後の行は生成中として返し、止まった行は failed にする
 *
 * 実行:
 *   bash scripts/supabase-local.sh start
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/weekly-menu-status-pending-stale.test.ts
 *
 * 自分の行は prompt の目印 (TEST_PROMPT) で識別し、開始時と終了時に必ず削除する。
 * 結合テストは 1 本ずつ回り (vitest.integration.config.ts)、ローカルに cron は無いので、processing の行が取り直されることは無い。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import ws from 'ws';

import { WEEKLY_MENU_REQUEST_STALE_MESSAGE } from '../../../src/lib/weekly-menu-request-error';
import { WEEKLY_MENU_REQUEST_STALE_MINUTES } from '../../../src/lib/weekly-menu-request-stale';

// ---------------------------------------------------------------
// 環境変数 / クライアント
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

// route が使うクライアント: 利用者 (サインイン済み) と service role。利用者のクライアントは beforeAll で入れる
let userClient: SupabaseClient;
/** route の service role のクライアントが、最初に行を書き換える (PATCH) 直前に 1 度だけ実行する処理
 *  (S-3 の「読んでから書くまでのあいだの進捗」を差し込む。差し込みの書き込みは srAdmin で行う) */
let beforeFirstAdminWrite: (() => Promise<void>) | null = null;

const routeAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
  global: {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const hook = beforeFirstAdminWrite;
      if (hook && init?.method === 'PATCH') {
        beforeFirstAdminWrite = null;
        await hook();
      }
      return fetch(input, init);
    },
  },
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => userClient,
  getSupabaseAdmin: () => routeAdmin,
}));

// ---------------------------------------------------------------
// テストユーザー
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-status-pending';
const TEST_PROMPT = 'rls-1507-weekly-status-pending';
/** 週の開始日 (weekly/pending の date・行の start_date) と、単一食事の対象日 (meal/pending の date を含む週の日) */
const WEEK_START = '2026-10-04';
const TARGET_DATE = '2026-10-05';

let userId: string;

const MIN = 60 * 1000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();
/** マイクロ秒の桁まで持つ時刻 (PostgREST が返す形と同じ桁で、比較つきの更新が一致するかを確かめる) */
const agoWithMicros = (minutes: number) => ago(minutes).replace(/\.(\d{3})Z$/, '.$1456Z');
/** しきい値を超えて止まった分数 */
const OVER = WEEKLY_MENU_REQUEST_STALE_MINUTES + 10;
/** 「数秒前」(claim_menu_request が取り直した直後) */
const JUST_NOW_MINUTES = 0.05;

interface Seed {
  status: string;
  mode?: string;
  createdAt: string;
  updatedAt: string | null;
  workerAcquiredAt?: string | null;
}

async function insertRequest(seed: Seed): Promise<string> {
  const single = seed.mode === 'single';
  const { data, error } = await srAdmin
    .from('weekly_menu_requests')
    .insert({
      user_id: userId,
      start_date: WEEK_START,
      mode: seed.mode ?? 'v5',
      prompt: TEST_PROMPT,
      status: seed.status,
      target_date: single ? TARGET_DATE : null,
      target_meal_type: single ? 'dinner' : null,
      worker_id: seed.workerAcquiredAt ? 'worker-original' : null,
      worker_acquired_at: seed.workerAcquiredAt ?? null,
      created_at: seed.createdAt,
      updated_at: seed.updatedAt,
      attempt_count: seed.workerAcquiredAt ? 1 : 0,
      generated_data: null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`weekly_menu_requests insert: ${error?.message}`);
  return data.id as string;
}

async function readRequest(id: string) {
  const { data, error } = await srAdmin
    .from('weekly_menu_requests')
    .select('id, status, error_message, updated_at, worker_acquired_at')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`weekly_menu_requests read ${id}: ${error?.message}`);
  return data;
}

async function purgeOwnRows() {
  await srAdmin.from('weekly_menu_requests').delete().eq('prompt', TEST_PROMPT);
}

const { GET: getStatus } = await import('../../../src/app/api/ai/menu/weekly/status/route');
const { GET: getWeeklyPending } = await import('../../../src/app/api/ai/menu/weekly/pending/route');
const { GET: getMealPending } = await import('../../../src/app/api/ai/menu/meal/pending/route');

async function runStatus(requestId: string) {
  const res = await getStatus(new Request(`http://localhost/api/ai/menu/weekly/status?requestId=${requestId}`));
  return { status: res.status, body: await res.json() };
}

async function runWeeklyPending() {
  const res = await getWeeklyPending(new Request(`http://localhost/api/ai/menu/weekly/pending?date=${WEEK_START}`));
  return { status: res.status, body: await res.json() };
}

async function runMealPending() {
  const res = await getMealPending(new Request(`http://localhost/api/ai/menu/meal/pending?date=${TARGET_DATE}&mealType=dinner`));
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  await purgeOwnRows();

  const email = `rls-1507-me-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;

  userClient = client(anonKey);
  const session = await userClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (session.error || !session.data.session) throw new Error(`signIn: ${session.error?.message}`);
}, 60_000);

afterEach(async () => {
  beforeFirstAdminWrite = null;
  await purgeOwnRows();
});

afterAll(async () => {
  await purgeOwnRows();
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
}, 30_000);

describe('#1507 status・pending の止まりの判定 (実 DB)', () => {
  it('S-1: status: claim_menu_request が取り直した直後の行 (worker_acquired_at が新しく updated_at が古い) は failed にしない', async () => {
    const reclaimed = await insertRequest({
      status: 'processing',
      createdAt: ago(OVER + 5),
      updatedAt: ago(OVER),
      workerAcquiredAt: ago(JUST_NOW_MINUTES),
    });

    const { status, body } = await runStatus(reclaimed);

    expect(status).toBe(200);
    expect(body.status).toBe('processing');
    const after = await readRequest(reclaimed);
    expect(after.status).toBe('processing');
    expect(after.error_message).toBeNull();
  });

  it('S-2: status: 生存信号から 20 分を超えて止まった行は failed にし、stale の文を書く', async () => {
    const stuck = await insertRequest({
      status: 'processing',
      createdAt: ago(OVER + 30),
      updatedAt: agoWithMicros(OVER + 5),
      workerAcquiredAt: agoWithMicros(OVER),
    });

    const { status, body } = await runStatus(stuck);

    expect(status).toBe(200);
    expect(body.status).toBe('failed');
    expect(body.errorMessage).toBe(WEEKLY_MENU_REQUEST_STALE_MESSAGE);
    const after = await readRequest(stuck);
    expect(after.status).toBe('failed');
    expect(after.error_message).toBe(WEEKLY_MENU_REQUEST_STALE_MESSAGE);
  });

  it('S-3: status: 読んでから書くまでのあいだに進捗を書いた行は failed にしない (比較つきの更新)', async () => {
    const raced = await insertRequest({ status: 'processing', createdAt: ago(OVER + 30), updatedAt: ago(OVER) });

    // status が行を読んだあと、failed に書く直前に Edge Function が進捗を書いた
    beforeFirstAdminWrite = async () => {
      const { error } = await srAdmin.from('weekly_menu_requests').update({ updated_at: new Date().toISOString() }).eq('id', raced);
      if (error) throw new Error(`progress update: ${error.message}`);
    };

    const { body } = await runStatus(raced);

    expect(beforeFirstAdminWrite).toBeNull(); // 差し込みが実行された
    expect(body.status).toBe('processing');
    const after = await readRequest(raced);
    expect(after.status).toBe('processing');
    expect(after.error_message).toBeNull();
  });

  it('P-1: weekly/pending: 取り直した直後の行は生成中として返し、止まった行は failed にする', async () => {
    const reclaimed = await insertRequest({
      status: 'processing',
      createdAt: ago(OVER + 5),
      updatedAt: ago(OVER),
      workerAcquiredAt: ago(JUST_NOW_MINUTES),
    });

    const first = await runWeeklyPending();
    expect(first.body.hasPending).toBe(true);
    expect(first.body.requestId).toBe(reclaimed);
    expect((await readRequest(reclaimed)).status).toBe('processing');

    await purgeOwnRows();
    const stuck = await insertRequest({ status: 'processing', createdAt: ago(OVER + 30), updatedAt: agoWithMicros(OVER) });

    const second = await runWeeklyPending();
    expect(second.body.hasPending).toBe(false);
    const after = await readRequest(stuck);
    expect(after.status).toBe('failed');
    expect(after.error_message).toBe(WEEKLY_MENU_REQUEST_STALE_MESSAGE);
  });

  it('M-1: meal/pending: 取り直した直後の行は生成中として返し、止まった行は failed にする', async () => {
    const reclaimed = await insertRequest({
      mode: 'single',
      status: 'processing',
      createdAt: ago(OVER + 5),
      updatedAt: ago(OVER),
      workerAcquiredAt: ago(JUST_NOW_MINUTES),
    });
    const stuck = await insertRequest({ mode: 'single', status: 'pending', createdAt: ago(OVER + 30), updatedAt: agoWithMicros(OVER) });

    const { status, body } = await runMealPending();

    expect(status).toBe(200);
    expect(body.hasPending).toBe(true);
    expect(body.requests.map((r: { requestId: string }) => r.requestId)).toEqual([reclaimed]);
    expect((await readRequest(reclaimed)).status).toBe('processing');
    const after = await readRequest(stuck);
    expect(after.status).toBe('failed');
    expect(after.error_message).toBe(WEEKLY_MENU_REQUEST_STALE_MESSAGE);
  });
});
