/**
 * #1202 献立生成キュー claim_menu_request の「ワーカー生存確認 (リース)」の回帰テスト
 *
 * 修正前の問題:
 *   claim_menu_request は status='processing' で worker_acquired_at が 5 分より古い行を、
 *   ワーカーが生きているかを見ずに「止まった仕事」として取り直していた。
 *   worker_acquired_at は「最初に取った瞬間」にしか書かれない。一方で生成は Step1〜6 を
 *   自分自身への再帰呼び出しでつないで進むため、5 分を超える生成 (Ultimate Mode など) では、
 *   1 本目のチェーンが動いている最中に cron が 2 本目を起動し、同じ request に 2 本が並走していた。
 *
 * 修正後の期待 (supabase/migrations/20261007160400_claim_menu_request_lease.sql):
 *   - 「最後に生きていた時刻」= GREATEST(worker_acquired_at, updated_at) が 5 分より古い行だけを取り直す。
 *     Edge Function は進捗を書くたびに updated_at を更新する (updateProgress) ので、動いている処理は取り直されない。
 *   - リースが切れた行は、並行して何本取りに来ても 1 本だけが取る (FOR UPDATE SKIP LOCKED)。
 *   - キューを経由していない行 (weekly/request など worker_acquired_at が NULL のまま status='processing' で
 *     作られる行) は、これまでどおり取り直さない。
 *   - attempt_count の上限 (3)、queued 行の取り方、実行権限 (service_role のみ) は変えない。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/claim-menu-request-lease.test.ts
 *
 * 注意: claim_menu_request はテーブル全体から created_at が最も古い取得可能な行を 1 件取る。
 *   このテストは、共有の DB に他の行があっても自分の行が先頭になるよう、行の created_at を 2000 年にしている。
 *   自分の行は prompt の目印 (TEST_PROMPT) で識別し、開始時と終了時に必ず削除する。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import ws from 'ws';

import {
  ACTIVE_REQUEST_STATUSES,
  buildActiveRequestUpdate,
} from '../../../supabase/functions/generate-menu-v5/request-finalize';

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

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);

// ---------------------------------------------------------------
// テストユーザー (weekly_menu_requests.user_id の外部キー用 + 権限確認用)
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-lease';
const TEST_PROMPT = 'rls-1202-claim-lease';

let userId: string;
let userJwt: string;

// ---------------------------------------------------------------
// 行の作成 / 読み出し
// ---------------------------------------------------------------
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let seq = 0;

interface Seed {
  status?: string;
  workerId?: string | null;
  workerAcquiredAt?: string | null;
  /** 明示的に null を渡すと updated_at を NULL にする */
  updatedAt?: string | null;
  attemptCount?: number;
  currentStep?: number;
  generatedData?: Record<string, unknown> | null;
}

/** キューの行を service role で作る。created_at は 2000 年 (他の行より必ず古い) */
async function insertRequest(seed: Seed): Promise<string> {
  const { data, error } = await srAdmin
    .from('weekly_menu_requests')
    .insert({
      user_id: userId,
      start_date: '2026-10-05',
      mode: 'v5',
      prompt: TEST_PROMPT,
      status: seed.status ?? 'processing',
      worker_id: seed.workerId === undefined ? 'worker-original' : seed.workerId,
      worker_acquired_at: seed.workerAcquiredAt === undefined ? ago(10 * MIN) : seed.workerAcquiredAt,
      updated_at: seed.updatedAt === undefined ? ago(10 * MIN) : seed.updatedAt,
      attempt_count: seed.attemptCount ?? 1,
      current_step: seed.currentStep ?? 4,
      generated_data: seed.generatedData === undefined ? { marker: 'before-claim', step3: { cursor: 3 } } : seed.generatedData,
      created_at: new Date(Date.UTC(2000, 0, 1, 0, 0, seq++)).toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`weekly_menu_requests insert: ${error?.message}`);
  return data.id as string;
}

async function readRequest(id: string) {
  const { data, error } = await srAdmin
    .from('weekly_menu_requests')
    .select('id, status, worker_id, worker_acquired_at, attempt_count, current_step, generated_data, error_message, updated_at')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`weekly_menu_requests read ${id}: ${error?.message}`);
  return data;
}

/** claim_menu_request を呼び、取れた行の id を返す (何も取れなかった場合は null) */
async function claim(workerId: string): Promise<{ id: string | null; row: Record<string, unknown> | null }> {
  const { data, error } = await srAdmin.rpc('claim_menu_request', { p_worker_id: workerId });
  if (error) throw new Error(`claim_menu_request: ${error.message}`);
  const row = (data ?? null) as Record<string, unknown> | null;
  return { id: (row?.id as string | undefined) ?? null, row };
}

async function purgeOwnRows() {
  await srAdmin.from('weekly_menu_requests').delete().eq('prompt', TEST_PROMPT);
}

beforeAll(async () => {
  // 前回の実行が途中で止まっていた場合の取り残しを先に消す (created_at が古く、claim の先頭に来てしまうため)
  await purgeOwnRows();

  const email = `rls-1202-lease-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;

  const session = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (session.error || !session.data.session) throw new Error(`signIn: ${session.error?.message}`);
  userJwt = session.data.session.access_token;
}, 60_000);

afterEach(async () => {
  // 1 件ずつ後始末する。前のテストの行が次のテストの claim に混ざらないようにする
  await purgeOwnRows();
});

afterAll(async () => {
  await purgeOwnRows();
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
}, 30_000);

// ================================================================
// 生きているワーカーの仕事は取り直さない (#1202 の本体)
// ================================================================
describe('#1202 claim_menu_request: 生きているワーカーの仕事は取り直さない', () => {
  it('L-1: 取得から 10 分たっていても、4 分前に進捗を書いた処理中の行は取り直さない', async () => {
    // 5 分を超える生成の途中: worker_acquired_at は最初に取った 10 分前のまま、進捗 (updated_at) は 4 分前
    const id = await insertRequest({ workerAcquiredAt: ago(10 * MIN), updatedAt: ago(4 * MIN), attemptCount: 1 });

    const claimed = await claim('worker-new');
    expect(claimed.id).not.toBe(id);

    const after = await readRequest(id);
    expect(after.worker_id).toBe('worker-original');
    expect(after.attempt_count).toBe(1);
    expect(after.status).toBe('processing');
  });

  it('L-2: リースが切れていた行でも、ワーカーが進捗を書いた直後は取り直さない (生存信号)', async () => {
    const id = await insertRequest({ workerAcquiredAt: ago(10 * MIN), updatedAt: ago(8 * MIN), attemptCount: 1 });

    // Edge Function の updateProgress と同じ: 進捗を書くと updated_at が現在時刻になる
    const { error } = await srAdmin
      .from('weekly_menu_requests')
      .update({ progress: { currentStep: 4, totalSteps: 6, message: '栄養バランスを分析中...' }, updated_at: new Date().toISOString() })
      .eq('id', id);
    expect(error).toBeNull();

    const claimed = await claim('worker-new');
    expect(claimed.id).not.toBe(id);

    const after = await readRequest(id);
    expect(after.worker_id).toBe('worker-original');
    expect(after.attempt_count).toBe(1);
  });

  it('L-3: 取ったばかり (4 分前) で進捗がまだ無い行 (updated_at は 10 分前) も取り直さない', async () => {
    // リースの起点は「取った時刻」と「最後の進捗」の新しいほう (どちらか一方だけを見る実装にならないこと)
    const id = await insertRequest({ workerAcquiredAt: ago(4 * MIN), updatedAt: ago(10 * MIN), attemptCount: 1, currentStep: 1 });

    const claimed = await claim('worker-new');
    expect(claimed.id).not.toBe(id);

    const after = await readRequest(id);
    expect(after.worker_id).toBe('worker-original');
    expect(after.attempt_count).toBe(1);
  });
});

// ================================================================
// リースが切れた行は 1 本だけが取り直す
// ================================================================
describe('#1202 claim_menu_request: リースが切れた行は 1 回だけ取り直す', () => {
  it('L-4: 取得から 10 分・最後の進捗から 6 分たった行は取り直され、続きから再開できる状態が残る', async () => {
    const id = await insertRequest({
      workerAcquiredAt: ago(10 * MIN),
      updatedAt: ago(6 * MIN),
      attemptCount: 1,
      currentStep: 4,
      generatedData: { marker: 'keep-me', step3: { cursor: 21 } },
    });

    const claimed = await claim('worker-new');
    expect(claimed.id).toBe(id);
    // cron が受け取る行: 取り直した回数 (2) と進んでいるステップ (4) が分かる = 続きから再開できる
    expect(claimed.row?.attempt_count).toBe(2);
    expect(claimed.row?.current_step).toBe(4);
    expect(claimed.row?.worker_id).toBe('worker-new');
    expect(claimed.row?.status).toBe('processing');

    const after = await readRequest(id);
    expect(after.worker_id).toBe('worker-new');
    expect(after.attempt_count).toBe(2);
    expect(after.current_step).toBe(4);
    // 進捗の保存データには触れない
    expect(after.generated_data).toEqual({ marker: 'keep-me', step3: { cursor: 21 } });
    // リースが更新される (直後にもう一度取り直されない)
    expect(Date.now() - new Date(after.worker_acquired_at as string).getTime()).toBeLessThan(60 * 1000);
  });

  it('L-5: 5 本が同時に取りに来ても、リースが切れた行を取るのは 1 本だけ (attempt_count は 1 しか増えない)', async () => {
    // 競合は一度では起きないことがあるので、新しい行で 10 回くり返す
    for (let round = 0; round < 10; round++) {
      const id = await insertRequest({ workerAcquiredAt: ago(10 * MIN), updatedAt: ago(6 * MIN), attemptCount: 1 });

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => claim(`worker-race-${round}-${i}`)),
      );
      const winners = results.filter((r) => r.id === id);
      expect(winners, `round ${round}: 取れたのは 1 本だけ`).toHaveLength(1);

      const after = await readRequest(id);
      expect(after.attempt_count, `round ${round}: attempt_count`).toBe(2);
      expect(after.worker_id).toBe(winners[0].row?.worker_id);
      expect(String(after.worker_id)).toMatch(new RegExp(`^worker-race-${round}-[0-4]$`));

      // 取り直した直後に、もう一度取りに来ても取れない (新しいリースが有効)
      const again = await claim('worker-late');
      expect(again.id).not.toBe(id);
      const final = await readRequest(id);
      expect(final.attempt_count).toBe(2);
      expect(final.worker_id).toBe(after.worker_id);

      // 次の回の claim に混ざらないよう、この回の行は消す
      await srAdmin.from('weekly_menu_requests').delete().eq('id', id);
    }
  });

  it('L-6: updated_at が NULL の行は、取得時刻だけでリースを判定する (NULL で判定が壊れない)', async () => {
    const id = await insertRequest({ workerAcquiredAt: ago(10 * MIN), updatedAt: null, attemptCount: 1 });

    const claimed = await claim('worker-new');
    expect(claimed.id).toBe(id);
    expect((await readRequest(id)).attempt_count).toBe(2);
  });
});

// ================================================================
// 変えない挙動
// ================================================================
describe('#1202 claim_menu_request: 従来どおりの挙動 (変えない)', () => {
  it('K-1: キューを経由していない処理中の行 (worker_acquired_at が NULL) は、いくら古くても取り直さない', async () => {
    // weekly/request・v4/generate などは status='processing' で作り、worker_id / worker_acquired_at は NULL のまま
    const id = await insertRequest({
      workerId: null,
      workerAcquiredAt: null,
      updatedAt: ago(60 * MIN),
      attemptCount: 0,
      currentStep: 1,
    });

    const claimed = await claim('worker-new');
    expect(claimed.id).not.toBe(id);

    const after = await readRequest(id);
    expect(after.worker_id).toBeNull();
    expect(after.worker_acquired_at).toBeNull();
    expect(after.attempt_count).toBe(0);
    expect(after.status).toBe('processing');
  });

  it('K-2: attempt_count が上限 (3) に達した行は、リースが切れていても取り直さない', async () => {
    const id = await insertRequest({ workerAcquiredAt: ago(10 * MIN), updatedAt: ago(6 * MIN), attemptCount: 3 });

    const claimed = await claim('worker-new');
    expect(claimed.id).not.toBe(id);

    const after = await readRequest(id);
    expect(after.worker_id).toBe('worker-original');
    expect(after.attempt_count).toBe(3);
  });

  it('K-3: queued の行は取って processing にし、上限に達した queued は failed にする', async () => {
    const queuedId = await insertRequest({
      status: 'queued',
      workerId: null,
      workerAcquiredAt: null,
      updatedAt: ago(1 * MIN),
      attemptCount: 0,
      currentStep: 1,
    });
    const exhaustedId = await insertRequest({
      status: 'queued',
      workerId: null,
      workerAcquiredAt: null,
      updatedAt: ago(1 * MIN),
      attemptCount: 3,
      currentStep: 1,
    });

    const claimed = await claim('worker-new');
    expect(claimed.id).toBe(queuedId);
    expect(claimed.row?.attempt_count).toBe(1);
    expect(claimed.row?.status).toBe('processing');

    const queuedAfter = await readRequest(queuedId);
    expect(queuedAfter.status).toBe('processing');
    expect(queuedAfter.worker_id).toBe('worker-new');
    expect(queuedAfter.worker_acquired_at).not.toBeNull();

    const exhaustedAfter = await readRequest(exhaustedId);
    expect(exhaustedAfter.status).toBe('failed');
    expect(exhaustedAfter.error_message).toBe('attempt_limit_exceeded');
  });

  it('K-4: 実行できるのは service_role だけ (anon・ログインユーザーは permission denied)', async () => {
    const asAnon = await client(anonKey).rpc('claim_menu_request', { p_worker_id: 'worker-anon' });
    expect(asAnon.error?.code).toBe('42501');

    const asUser = await client(anonKey, userJwt).rpc('claim_menu_request', { p_worker_id: 'worker-user' });
    expect(asUser.error?.code).toBe('42501');
  });
});

// ================================================================
// Edge Function (generate-menu-v5) の最終書き込みの CAS
//   本物の PostgREST に対して、index.ts が使う buildActiveRequestUpdate を流す
// ================================================================
describe('#1202 generate-menu-v5 の最終書き込み: 終端の行は上書きしない (CAS)', () => {
  const FINAL_UPDATE = {
    status: 'completed',
    current_step: 6,
    progress: { currentStep: 6, totalSteps: 6, message: '全 21 件の献立が完成しました！' },
    error_message: null,
  };

  it('F-1: 処理中 (processing) の行には書き込める', async () => {
    const id = await insertRequest({ status: 'processing', currentStep: 6 });

    const { data, error } = await buildActiveRequestUpdate(srAdmin, id, FINAL_UPDATE);
    expect(error).toBeNull();
    expect(data).toEqual([{ id }]);
    expect((await readRequest(id)).status).toBe('completed');
  });

  it('F-2: すでに完了 (completed) / 失敗 (failed) した行は、後から来た最終書き込みで上書きしない', async () => {
    const completedId = await insertRequest({ status: 'completed', currentStep: 6 });
    const failedId = await insertRequest({ status: 'failed', currentStep: 3 });

    const late = { ...FINAL_UPDATE, status: 'failed', error_message: '後発の別チェーンの結果' };
    const a = await buildActiveRequestUpdate(srAdmin, completedId, late);
    const b = await buildActiveRequestUpdate(srAdmin, failedId, FINAL_UPDATE);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    // 0 件更新 = 呼び出し側 (index.ts) が「見送った」と判定できる
    expect(a.data).toEqual([]);
    expect(b.data).toEqual([]);

    const completedAfter = await readRequest(completedId);
    expect(completedAfter.status).toBe('completed');
    expect(completedAfter.error_message).toBeNull();
    const failedAfter = await readRequest(failedId);
    expect(failedAfter.status).toBe('failed');
    expect(failedAfter.current_step).toBe(3);
  });

  it('F-3: 書き込める status は queued / processing の 2 つ (#122 の失敗側ガードと同じ集合)', () => {
    expect([...ACTIVE_REQUEST_STATUSES]).toEqual(['queued', 'processing']);
  });
});
