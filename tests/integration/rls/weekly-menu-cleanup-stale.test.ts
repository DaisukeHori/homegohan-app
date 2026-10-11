/**
 * #1494: 週間ページを開くたびの cleanup (POST /api/ai/menu/weekly/cleanup) を、ローカル Supabase の実 DB に対して確かめる。
 *
 * 以前の cleanup は、作成から 5 分を過ぎた queued / pending / processing をすべて failed にしていた。
 * queued は v5/generate が積んだ時点で AI の 1 回を数えている (#1149) ので、cron の順番待ちの行を failed にすると、
 * 数えた 1 回が成果なしで消えていた。進捗を書き続けている生成中の行も、作成から 5 分で failed になっていた。
 *
 * ここで確かめること (route のハンドラーをそのまま呼ぶ。利用者のクライアントと service role のクライアントは実物):
 *   C-1: 作成から 60 分たった queued の行は触らない
 *   C-2: 作成は 60 分前でも、生存信号 (updated_at / GREATEST(worker_acquired_at, updated_at)) が新しい processing の行は触らない
 *   C-3: 生存信号から 20 分を超えて止まった行だけを failed にし、stale の文を書く
 *        (PostgREST が返すマイクロ秒つきの時刻・NULL の updated_at でも、比較つきの更新が一致する)
 *   C-4: 読んでから書くまでのあいだに進捗を書いた行は failed にしない (比較つきの更新)
 *   C-5: 他人の止まった行は触らない
 *
 * 実行:
 *   bash scripts/supabase-local.sh start
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/weekly-menu-cleanup-stale.test.ts
 *
 * 自分の行は prompt の目印 (TEST_PROMPT) で識別し、開始時と終了時に必ず削除する。
 * queued の行は claim_menu_request に取られうるが、結合テストは 1 本ずつ回り (vitest.integration.config.ts)、ローカルに cron は無い。
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
 *  (C-4 の「読んでから書くまでのあいだの進捗」を差し込む。差し込みの書き込みは srAdmin で行う) */
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
const PASSWORD = 'TestPass!2026-cleanup';
const TEST_PROMPT = 'rls-1494-weekly-cleanup';

let userId: string;
let otherUserId: string;

const MIN = 60 * 1000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();
/** マイクロ秒の桁まで持つ時刻 (PostgREST が返す形と同じ桁で、比較つきの更新が一致するかを確かめる) */
const agoWithMicros = (minutes: number) => ago(minutes).replace(/\.(\d{3})Z$/, '.$1456Z');

interface Seed {
  owner?: string;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  workerAcquiredAt?: string | null;
}

async function insertRequest(seed: Seed): Promise<string> {
  const { data, error } = await srAdmin
    .from('weekly_menu_requests')
    .insert({
      user_id: seed.owner ?? userId,
      start_date: '2026-10-05',
      mode: 'v5',
      prompt: TEST_PROMPT,
      status: seed.status,
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

async function createUser(label: string): Promise<{ id: string; email: string }> {
  const email = `rls-1494-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  return { id: data.user.id, email };
}

const { POST } = await import('../../../src/app/api/ai/menu/weekly/cleanup/route');

async function runCleanup(): Promise<{ status: number; body: { cleaned: number; ids?: string[]; message: string } }> {
  const res = await POST();
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  await purgeOwnRows();

  const me = await createUser('me');
  userId = me.id;
  const other = await createUser('other');
  otherUserId = other.id;

  userClient = client(anonKey);
  const session = await userClient.auth.signInWithPassword({ email: me.email, password: PASSWORD });
  if (session.error || !session.data.session) throw new Error(`signIn: ${session.error?.message}`);
}, 60_000);

afterEach(async () => {
  beforeFirstAdminWrite = null;
  await purgeOwnRows();
});

afterAll(async () => {
  await purgeOwnRows();
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
  if (otherUserId) await srAdmin.auth.admin.deleteUser(otherUserId);
}, 30_000);

describe('#1494 POST /api/ai/menu/weekly/cleanup (実 DB)', () => {
  it('C-1: 作成から 60 分たった queued の行は触らない (cron の順番待ち。数えた 1 回を消さない)', async () => {
    const queued = await insertRequest({ status: 'queued', createdAt: ago(60), updatedAt: ago(60) });

    const { status, body } = await runCleanup();

    expect(status).toBe(200);
    expect(body.cleaned).toBe(0);
    const after = await readRequest(queued);
    expect(after.status).toBe('queued');
    expect(after.error_message).toBeNull();
  });

  it('C-2: 作成は 60 分前でも、生存信号が新しい processing の行は触らない', async () => {
    const direct = await insertRequest({ status: 'processing', createdAt: ago(60), updatedAt: ago(1) });
    const queueProgress = await insertRequest({ status: 'processing', createdAt: ago(60), updatedAt: ago(2), workerAcquiredAt: ago(40) });
    const queueReclaimed = await insertRequest({ status: 'processing', createdAt: ago(60), updatedAt: ago(40), workerAcquiredAt: ago(1) });

    const { body } = await runCleanup();

    expect(body.cleaned).toBe(0);
    for (const id of [direct, queueProgress, queueReclaimed]) {
      expect((await readRequest(id)).status).toBe('processing');
    }
  });

  it('C-3: 生存信号から 20 分を超えて止まった行だけを failed にし、stale の文を書く', async () => {
    const over = WEEKLY_MENU_REQUEST_STALE_MINUTES + 10;
    const under = WEEKLY_MENU_REQUEST_STALE_MINUTES - 5;
    const stuckDirect = await insertRequest({ status: 'processing', createdAt: ago(90), updatedAt: agoWithMicros(over) });
    const stuckQueueNullUpdated = await insertRequest({
      status: 'processing',
      createdAt: ago(90),
      updatedAt: null,
      workerAcquiredAt: agoWithMicros(over),
    });
    const stuckPending = await insertRequest({ status: 'pending', createdAt: ago(90), updatedAt: ago(over) });
    const notYet = await insertRequest({ status: 'processing', createdAt: ago(90), updatedAt: ago(under) });

    const { status, body } = await runCleanup();

    expect(status).toBe(200);
    expect(body.cleaned).toBe(3);
    expect([...(body.ids ?? [])].sort()).toEqual([stuckDirect, stuckQueueNullUpdated, stuckPending].sort());
    for (const id of [stuckDirect, stuckQueueNullUpdated, stuckPending]) {
      const after = await readRequest(id);
      expect(after.status).toBe('failed');
      expect(after.error_message).toBe(WEEKLY_MENU_REQUEST_STALE_MESSAGE);
    }
    expect((await readRequest(notYet)).status).toBe('processing');
  });

  it('C-4: 読んでから書くまでのあいだに進捗を書いた行は failed にしない (比較つきの更新)', async () => {
    const raced = await insertRequest({ status: 'processing', createdAt: ago(90), updatedAt: ago(30) });

    // cleanup が行を読んだあと、failed に書く直前に Edge Function が進捗を書いた
    beforeFirstAdminWrite = async () => {
      const { error } = await srAdmin.from('weekly_menu_requests').update({ updated_at: new Date().toISOString() }).eq('id', raced);
      if (error) throw new Error(`progress update: ${error.message}`);
    };

    const { body } = await runCleanup();

    expect(beforeFirstAdminWrite).toBeNull(); // 差し込みが実行された
    expect(body.cleaned).toBe(0);
    const after = await readRequest(raced);
    expect(after.status).toBe('processing');
    expect(after.error_message).toBeNull();
  });

  it('C-5: 他人の止まった行は触らない', async () => {
    const others = await insertRequest({ owner: otherUserId, status: 'processing', createdAt: ago(90), updatedAt: ago(60) });

    const { body } = await runCleanup();

    expect(body.cleaned).toBe(0);
    expect((await readRequest(others)).status).toBe('processing');
  });
});
