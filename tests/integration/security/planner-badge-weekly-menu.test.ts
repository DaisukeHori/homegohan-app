/**
 * #1867 「計画上手」(planner) を、AI の週の献立の生成が成功したときにも付ける (実 DB の結合テスト)。
 * オーナーの選択 (2026-10-18 17 時台、選択式): 「取れる条件を足す」— AI で週の献立を初めて作ったときにも付くようにし、説明もそれに合わせる。
 *
 * 週の献立の生成 (POST /api/ai/menu/weekly/request) は、行を作るときに generated_data へ印 (weeklyRequest: true) を書く。
 * Edge Function が献立を保存し終えると行は completed になる (1 食も保存できなかった・中止・止まったときは failed)。
 * ここでは Edge Function は動かさず、その結果の行 (印あり / なし、completed / failed) を service role で作り、
 * route のハンドラーをそのまま呼ぶ (利用者のクライアントと service role のクライアントは実物。weekly-menu-status-pending-stale.test.ts と同じ形)。
 *
 * 確かめること:
 *   W-1: 印のある completed の行を状態の確認 (GET /api/ai/menu/weekly/status) が読むと、本人に planner が 1 つ付く。
 *        もう一度読んでも 1 つのまま (獲得日時も変わらない)
 *   W-2: 印のある failed の行 (失敗・中止)・印の無い completed の行 (汎用の生成・1 食の生成など) では付かない
 *   W-3: 使い方ガイドのお試しの献立の追加 (POST /api/menu-plans/add の sandbox) で付いたあとに、週の献立の生成が完了しても、
 *        planner は 1 つのまま (獲得日時はお試しのときのまま)
 *   W-4: 状態の確認を読まなかった人も、バッジの一覧 (GET /api/badges) を開くと、完了した週の献立の生成の行から planner が付く
 *        (印の絞り込み generated_data->>weeklyRequest = 'true' が実 DB の PostgREST で効く)。印の無い完了の行だけなら付かない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/planner-badge-weekly-menu.test.ts
 * 本番には接続しない。自分の行は prompt の目印 (TEST_PROMPT) とテストユーザーで識別し、終了時に消す。
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import ws from 'ws';
import { MOCK_MENU_RESPONSE } from '@homegohan/handson-tour-shared';
import { weeklyMenuRequestWeeklyOriginData } from '../../../src/lib/ai/weekly-menu-request-origin';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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

// route が使うクライアント: 利用者 (サインイン済み。テストごとに差し替える) と service role
let userClient: SupabaseClient;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => userClient,
  getSupabaseAdmin: () => srAdmin,
}));

const { GET: getStatus } = await import('../../../src/app/api/ai/menu/weekly/status/route');
const { GET: getBadges } = await import('../../../src/app/api/badges/route');
const { POST: postMenuAdd } = await import('../../../src/app/api/menu-plans/add/route');

const TS = Date.now();
const TEST_PROMPT = `integration-1867-planner-weekly-${TS}`;
/** 週の開始日 (行の start_date。生成は動かさないので、日付そのものに意味は無い) */
const WEEK_START = '2026-10-19';
const createdUserIds: string[] = [];

interface TestUser {
  id: string;
}

/** 使い方ガイド (お試し) の対象になる新しい利用者を作り、そのセッションのクライアントを route に渡す */
async function createSignedInUser(label: string): Promise<TestUser> {
  const email = `integration-1867-planner-${label}-${TS}@homegohan.test`;
  const password = randomBytes(16).toString('hex');
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  // お試しの献立の追加は user_profiles の行を見る (ツアー未完了・管理者でない)。必須の列だけ入れる
  // 既知の行 (id) の upsert なので、ゲートウェイの一時的な失敗のときだけやり直す (#1779。helpers/setup-transient-retry.ts)
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createSignedInUser: user_profiles の upsert', (db) =>
    db
      .from('user_profiles')
      .upsert(
        { id: data.user.id, nickname: `planner ${label}`, age_group: '30s', gender: 'other', roles: [] },
        { onConflict: 'id' },
      ),
  );
  if (profileError) throw new Error(`user_profiles upsert ${label}: ${profileError.message}`);

  userClient = client(anonKey);
  const session = await userClient.auth.signInWithPassword({ email, password });
  if (session.error || !session.data.session) throw new Error(`signIn ${label}: ${session.error?.message}`);
  return { id: data.user.id };
}

interface RequestSeed {
  status: 'completed' | 'failed';
  /** 週の献立の生成の印を付けるか */
  weeklyOrigin: boolean;
}

/** Edge Function が書き終えたあとの行を、service role で作る */
async function insertRequest(userId: string, seed: RequestSeed): Promise<string> {
  const { data, error } = await srAdmin
    .from('weekly_menu_requests')
    .insert({
      user_id: userId,
      start_date: WEEK_START,
      mode: 'v4',
      prompt: TEST_PROMPT,
      status: seed.status,
      generated_data: seed.weeklyOrigin ? { ...weeklyMenuRequestWeeklyOriginData(), version: 'v4' } : { version: 'v4' },
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`weekly_menu_requests insert: ${error?.message}`);
  return data.id as string;
}

async function runStatus(requestId: string) {
  const res = await getStatus(new Request(`http://localhost/api/ai/menu/weekly/status?requestId=${requestId}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let plannerId: string | null = null;
async function plannerBadgeId(): Promise<string> {
  if (plannerId) return plannerId;
  const { data, error } = await srAdmin.from('badges').select('id').eq('code', 'planner').single();
  if (error || !data) {
    throw new Error(`badges マスタに planner がありません (supabase/baseline/prod_reference_data.sql を確認): ${error?.message}`);
  }
  plannerId = data.id as string;
  return plannerId;
}

async function plannerRows(userId: string): Promise<Array<{ obtained_at: string }>> {
  const { data, error } = await srAdmin
    .from('user_badges')
    .select('obtained_at')
    .eq('user_id', userId)
    .eq('badge_id', await plannerBadgeId());
  if (error) throw new Error(`user_badges: ${error.message}`);
  return (data ?? []) as Array<{ obtained_at: string }>;
}

afterAll(async () => {
  await srAdmin.from('weekly_menu_requests').delete().eq('prompt', TEST_PROMPT);
  if (createdUserIds.length === 0) return;
  await srAdmin.from('weekly_menus').delete().in('user_id', createdUserIds);
  await srAdmin.from('weekly_menu_requests').delete().in('user_id', createdUserIds);
  await srAdmin.from('user_badges').delete().in('user_id', createdUserIds);
  await srAdmin.from('app_logs').delete().in('user_id', createdUserIds);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('#1867 planner: AI の週の献立の生成でも付く (実 DB)', () => {
  it('W-1: 印のある completed の行を状態の確認が読むと planner が 1 つ付き、もう一度読んでも 1 つのまま', async () => {
    const user = await createSignedInUser('w1');
    const requestId = await insertRequest(user.id, { status: 'completed', weeklyOrigin: true });

    const first = await runStatus(requestId);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('completed');
    const afterFirst = await plannerRows(user.id);
    expect(afterFirst).toHaveLength(1);

    const second = await runStatus(requestId);
    expect(second.status).toBe(200);
    const afterSecond = await plannerRows(user.id);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].obtained_at).toBe(afterFirst[0].obtained_at);
  });

  it('W-2: 印のある failed の行・印の無い completed の行では付かない', async () => {
    const user = await createSignedInUser('w2');
    const failed = await insertRequest(user.id, { status: 'failed', weeklyOrigin: true });
    const otherCompleted = await insertRequest(user.id, { status: 'completed', weeklyOrigin: false });

    expect((await runStatus(failed)).body.status).toBe('failed');
    expect((await runStatus(otherCompleted)).body.status).toBe('completed');

    expect(await plannerRows(user.id)).toEqual([]);
  });

  it('W-3: お試しの献立の追加で付いたあとに週の献立の生成が完了しても、planner は 1 つのまま', async () => {
    const user = await createSignedInUser('w3');

    const addRes = await postMenuAdd(
      new Request('http://localhost/api/menu-plans/add?source=handson_tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...MOCK_MENU_RESPONSE, sandbox: true, source: 'handson_tour' }),
      }),
    );
    const addBody = (await addRes.json()) as { badge_awarded?: { code?: string } | null };
    expect(addRes.status).toBe(200);
    expect(addBody.badge_awarded?.code).toBe('planner');
    const afterTour = await plannerRows(user.id);
    expect(afterTour).toHaveLength(1);

    const requestId = await insertRequest(user.id, { status: 'completed', weeklyOrigin: true });
    expect((await runStatus(requestId)).status).toBe(200);

    const afterWeekly = await plannerRows(user.id);
    expect(afterWeekly).toHaveLength(1);
    expect(afterWeekly[0].obtained_at).toBe(afterTour[0].obtained_at);
  });

  it('W-4: 状態の確認を読まなかった人も、バッジの一覧を開くと planner が付く (印の無い完了の行だけでは付かない)', async () => {
    const user = await createSignedInUser('w4');

    // 印の無い completed の行と、印のある failed の行だけ: 付かない
    await insertRequest(user.id, { status: 'completed', weeklyOrigin: false });
    await insertRequest(user.id, { status: 'failed', weeklyOrigin: true });
    const before = await getBadges(new Request('http://localhost/api/badges'));
    const beforeBody = (await before.json()) as { badges: Array<{ code: string; earned: boolean }>; newEarnedBadgeCodes: string[] };
    expect(before.status).toBe(200);
    expect(beforeBody.newEarnedBadgeCodes).not.toContain('planner');
    expect(beforeBody.badges.find((badge) => badge.code === 'planner')?.earned).toBe(false);
    expect(await plannerRows(user.id)).toEqual([]);

    // 印のある completed の行ができると (状態の確認は読まない)、一覧を開いたときに付く
    await insertRequest(user.id, { status: 'completed', weeklyOrigin: true });
    const after = await getBadges(new Request('http://localhost/api/badges'));
    const afterBody = (await after.json()) as { badges: Array<{ code: string; earned: boolean }>; newEarnedBadgeCodes: string[] };
    expect(after.status).toBe(200);
    expect(afterBody.newEarnedBadgeCodes).toContain('planner');
    expect(afterBody.badges.find((badge) => badge.code === 'planner')?.earned).toBe(true);
    expect(await plannerRows(user.id)).toHaveLength(1);

    // もう一度開いても 1 つのまま (新規獲得にも数えない)
    const again = await getBadges(new Request('http://localhost/api/badges'));
    const againBody = (await again.json()) as { newEarnedBadgeCodes: string[] };
    expect(againBody.newEarnedBadgeCodes).not.toContain('planner');
    expect(await plannerRows(user.id)).toHaveLength(1);
  });
});
