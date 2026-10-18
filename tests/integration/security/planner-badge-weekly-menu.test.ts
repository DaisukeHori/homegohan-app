/**
 * #1867 「計画上手」(planner) を、AI の週の献立の生成が成功したときにも付ける (実 DB の結合テスト)。
 * オーナーの選択 (2026-10-18 17 時台、選択式): 「取れる条件を足す」— AI で週の献立を初めて作ったときにも付くようにし、説明もそれに合わせる。
 *
 * AI で複数の日の献立をまとめて作る生成 (POST /api/ai/menu/weekly/request・v4/generate と v5/generate で対象が複数の日 (異なる日付が 2 日以上) に
 * わたるとき・AI 相談の 1 週間分の生成) は、行を作るときに generated_data へ印 (weeklyRequest: true) を書く。1 週間に満たなくても書く
 * (オーナーの選択 2026-10-18 21 時台: 週の途中に「空欄を埋める」で今週の残りを AI で作ったとき (7 日未満) も付ける)。
 * Edge Function が献立を保存し終えると行は completed になる (1 食も保存できなかった・中止・止まったときは failed)。
 * 付与の本体は、行が completed になった時点で付ける DB のトリガー weekly_menu_requests_award_planner
 * (supabase/migrations/20261018060000_planner_badge_award_on_weekly_menu_completed.sql)。状態の確認 (GET /api/ai/menu/weekly/status) と
 * バッジの一覧 (GET /api/badges) の付与は、トリガーが付け損ねたときの保険。
 * ここでは Edge Function は動かさず、その結果の行 (印あり / なし、completed / failed) を service role で作り (または更新し)、
 * route のハンドラーをそのまま呼ぶ (利用者のクライアントと service role のクライアントは実物。weekly-menu-status-pending-stale.test.ts と同じ形)。
 * W-1〜W-4 は行を最初から completed で INSERT する (トリガーは UPDATE で動くので動かない = トリガーが付け損ねた行) ことで、保険の経路だけを確かめる。
 *
 * 確かめること:
 *   W-1: (保険) 印のある completed の行を状態の確認 (GET /api/ai/menu/weekly/status) が読むと、本人に planner が 1 つ付く。
 *        もう一度読んでも 1 つのまま (獲得日時も変わらない)
 *   W-2: 印のある failed の行 (失敗・中止)・印の無い completed の行 (1 日・1 食の生成など) では付かない
 *   W-3: 使い方ガイドのお試しの献立の追加 (POST /api/menu-plans/add の sandbox) で付いたあとに、週の献立の生成が完了しても、
 *        planner は 1 つのまま (獲得日時はお試しのときのまま)
 *   W-4: (保険) 状態の確認を読まなかった人も、バッジの一覧 (GET /api/badges) を開くと、完了した週の献立の生成の行から planner が付く
 *        (印の絞り込み generated_data->>weeklyRequest = 'true' が実 DB の PostgREST で効く)。印の無い完了の行だけなら付かない
 *   W-5: 利用者が実際に週の献立を作る経路 (Web の AI献立アシスタント・モバイルが呼ぶ POST /api/ai/menu/v4/generate) の route を
 *        そのまま呼んで行を作る。対象の枠が複数の日 (下限ちょうどの 2 日・従来の 1 週間 (7 日)) なら行に印が付き、完了を書いた時点で
 *        (状態の確認もバッジの一覧も読まずに) トリガーが planner を付ける。1 日だけの生成の行には印が無く、完了しても付かない
 *        (トリガーでも、状態の確認でも、バッジの一覧でも)。
 *        Edge Function は呼ばない (呼ぶ関数を差し替え、完了は service role で書く)
 *   W-6: トリガー (付与の本体)。画面が完了を読まなくても (モバイルは状態の確認もバッジの一覧も読まない)、行が completed になった時点で付く:
 *        - 印のある行が completed になると本人に 1 つ付く。completed のまま進み具合を書き直しても 1 つのまま (獲得日時も変わらない)
 *        - 印のある行が failed になったとき・印の無い行 (1 日・1 食の生成) が completed になったときは付かない
 *        - 最後の書き込みが generated_data を印の無いものに書き直しても、更新前の行に印があれば付く
 *        - お試しの献立の追加で付いたあとに完了しても 1 つのまま (獲得日時はお試しのときのまま)
 *        - rollback でトリガーを消すと付かなくなり、migration をもう一度流す (2 回流しても同じ) と付くようになる
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/planner-badge-weekly-menu.test.ts
 * 本番には接続しない。自分の行は prompt の目印 (TEST_PROMPT) とテストユーザーで識別し、終了時に消す。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import ws from 'ws';
import { MOCK_MENU_RESPONSE } from '@homegohan/handson-tour-shared';
import {
  MULTI_DAY_MENU_GENERATION_MIN_DAYS,
  weeklyMenuRequestWeeklyOriginData,
} from '../../../src/lib/ai/weekly-menu-request-origin';
import { addDaysToDate } from '../../../src/lib/date-utils';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import {
  DEFAULT_GATEWAY_RETRY_ATTEMPTS,
  DEFAULT_GATEWAY_RETRY_BASE_DELAY_MS,
  GATEWAY_TRANSIENT_STATUSES,
  defaultGatewayRetrySleep,
  gatewayRetryDelayMs,
} from '../helpers/gateway-transient';

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

// W-5 で POST /api/ai/menu/v4/generate をそのまま呼ぶための差し替え (DB 以外の外の世界だけ):
//   - 同意の判定は「同意済み」(同意が無いときの動きは tests/ai-consent-enforcement-routes.test.ts が見る)
//   - レート制限・AI の利用回数の記録は通す (どちらも別のテストが見る)
//   - エンジンは v4 (menu_generation_v5_direct は OFF) で、Edge Function は呼ばない (生成の完了は下で service role が書く)
vi.mock('@/lib/ai/consent-guard', () => import('../../helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: vi.fn(async () => ({ success: true })),
}));
vi.mock('@/lib/plan/entitlements', async (importOriginal) => {
  const { AI_USAGE_ALLOWED } = await import('../../helpers/ai-usage-mock');
  return {
    ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
    consumeAiUsage: vi.fn(async () => AI_USAGE_ALLOWED),
    refundAiUsage: vi.fn(async () => undefined),
  };
});
vi.mock('@/lib/feature-flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feature-flags')>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn(async (...args: Parameters<typeof actual.isFeatureEnabled>) =>
      args[0] === 'menu_generation_v5_direct' ? false : actual.isFeatureEnabled(...args),
    ),
  };
});
vi.mock('@/lib/generate-menu-v4-retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generate-menu-v4-retry')>()),
  callGenerateMenuV4WithRetry: vi.fn(async () => ({ ok: true, attempts: 1, response: new Response() })),
}));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const { GET: getStatus } = await import('../../../src/app/api/ai/menu/weekly/status/route');
const { POST: postV4Generate } = await import('../../../src/app/api/ai/menu/v4/generate/route');
const { GET: getBadges } = await import('../../../src/app/api/badges/route');
const { POST: postMenuAdd } = await import('../../../src/app/api/menu-plans/add/route');

const TS = Date.now();
const TEST_PROMPT = `integration-1867-planner-weekly-${TS}`;
/** 週の開始日 (行の start_date。生成は動かさないので、日付そのものに意味は無い) */
const WEEK_START = '2026-10-19';
/** 1 週間 = 7 日 (従来の 1 週間分の生成も今までどおり印が付き planner が付くことを確かめる) */
const DAYS_PER_WEEK = 7;
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

/** 週の献立の生成の完了で planner を付けるトリガーの migration と戻し口 (#1867。W-6 の rollback で流す) */
const PLANNER_TRIGGER_MIGRATION_SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20261018060000_planner_badge_award_on_weekly_menu_completed.sql'),
  'utf8',
);
const PLANNER_TRIGGER_ROLLBACK_SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/rollbacks/20261018060000_planner_badge_award_on_weekly_menu_completed.down.sql'),
  'utf8',
);

/**
 * SQL を、本番の migration と同じ postgres ロールで流す (ローカルスタックの postgres-meta /pg/query。service_role キーが必要。本番には接続しない)。
 * 流す SQL (migration と rollback) は何度流しても同じ結果になるので、ゲートウェイの一時的な失敗 (502 / 503 / 504) のときだけやり直す
 */
async function asPostgres(sql: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `SET LOCAL ROLE postgres;\n${sql}` }),
    });
    if (res.ok) return;
    const body = await res.text();
    if (!GATEWAY_TRANSIENT_STATUSES.includes(res.status) || attempt >= DEFAULT_GATEWAY_RETRY_ATTEMPTS) {
      throw new Error(`pg/query ${res.status}: ${body}`);
    }
    await defaultGatewayRetrySleep(gatewayRetryDelayMs(DEFAULT_GATEWAY_RETRY_BASE_DELAY_MS, attempt));
  }
}

afterAll(async () => {
  try {
    // W-6 の rollback が途中で止まっても、トリガーを戻しておく (流せなかったら afterAll を赤にする。片付けは下の finally で続ける)
    await asPostgres(PLANNER_TRIGGER_MIGRATION_SQL);
  } finally {
    await srAdmin.from('weekly_menu_requests').delete().eq('prompt', TEST_PROMPT);
    if (createdUserIds.length > 0) {
      await srAdmin.from('weekly_menus').delete().in('user_id', createdUserIds);
      await srAdmin.from('weekly_menu_requests').delete().in('user_id', createdUserIds);
      await srAdmin.from('user_badges').delete().in('user_id', createdUserIds);
      await srAdmin.from('app_logs').delete().in('user_id', createdUserIds);
      for (const id of createdUserIds) {
        await srAdmin.auth.admin.deleteUser(id);
      }
    }
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

  /** POST /api/ai/menu/v4/generate の route をそのまま呼び、作った行の id を返す (対象は WEEK_START から days 日の朝昼夕) */
  async function generateViaV4(days: number): Promise<string> {
    const targetSlots: Array<{ date: string; mealType: string }> = [];
    for (let i = 0; i < days; i++) {
      for (const mealType of ['breakfast', 'lunch', 'dinner']) targetSlots.push({ date: addDaysToDate(WEEK_START, i), mealType });
    }
    const res = await postV4Generate(
      new Request('http://localhost/api/ai/menu/v4/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSlots, note: TEST_PROMPT }),
      }),
    );
    const body = (await res.json()) as { requestId?: string };
    expect(res.status).toBe(200);
    expect(body.requestId).toEqual(expect.any(String));
    return body.requestId as string;
  }

  /** Edge Function が献立を保存し終えたときと同じく、generated_data を広げて書き足し、行を completed にする */
  async function completeLikeEdgeFunction(requestId: string): Promise<Record<string, unknown>> {
    const { data: row, error } = await srAdmin.from('weekly_menu_requests').select('generated_data').eq('id', requestId).single();
    if (error || !row) throw new Error(`weekly_menu_requests select: ${error?.message}`);
    const generatedData = { ...((row.generated_data as Record<string, unknown> | null) ?? {}), version: 'v4' };
    const { error: updateError } = await srAdmin
      .from('weekly_menu_requests')
      .update({ status: 'completed', generated_data: generatedData })
      .eq('id', requestId);
    if (updateError) throw new Error(`weekly_menu_requests update: ${updateError.message}`);
    return generatedData;
  }

  it('W-5: v4/generate で複数の日 (2 日・1 週間) を作った行は印が付き、完了すると planner が付く。1 日だけの生成では付かない', async () => {
    // 1 日だけの生成: 行に印が無く、完了しても状態の確認・バッジの一覧のどちらでも付かない
    const dayUser = await createSignedInUser('w5-day');
    const dayRequestId = await generateViaV4(1);
    const dayData = await completeLikeEdgeFunction(dayRequestId);
    expect(dayData).not.toHaveProperty('weeklyRequest');
    expect((await runStatus(dayRequestId)).body.status).toBe('completed');
    const dayBadges = (await (await getBadges(new Request('http://localhost/api/badges'))).json()) as {
      badges: Array<{ code: string; earned: boolean }>;
    };
    expect(dayBadges.badges.find((badge) => badge.code === 'planner')?.earned).toBe(false);
    expect(await plannerRows(dayUser.id)).toEqual([]);

    // 複数の日の生成 (下限ちょうどの 2 日 = 週の途中の残りの形・従来の 1 週間): 行に印が付き (Edge Function の書き足しでも消えない)、
    // 完了を書いた時点で (状態の確認もバッジの一覧も読む前に) トリガーが付けている。状態の確認が読んでも 1 つのまま
    for (const [label, days] of [
      ['multi', MULTI_DAY_MENU_GENERATION_MIN_DAYS],
      ['week', DAYS_PER_WEEK],
    ] as const) {
      const multiUser = await createSignedInUser(`w5-${label}`);
      const multiRequestId = await generateViaV4(days);
      const multiData = await completeLikeEdgeFunction(multiRequestId);
      expect(multiData.weeklyRequest, `${days} 日`).toBe(true);
      expect(await plannerRows(multiUser.id), `${days} 日`).toHaveLength(1);
      expect((await runStatus(multiRequestId)).body.status).toBe('completed');
      expect(await plannerRows(multiUser.id), `${days} 日`).toHaveLength(1);
    }
  });

  describe('W-6: 行が completed になった時点で、DB のトリガーが付ける (画面が完了を読まなくても付く)', () => {
    /** 生成の途中 (Edge Function が保存を終える前) の行を service role で作る */
    async function insertProcessingRequest(userId: string, weeklyOrigin: boolean): Promise<string> {
      const { data, error } = await srAdmin
        .from('weekly_menu_requests')
        .insert({
          user_id: userId,
          start_date: WEEK_START,
          mode: 'v4',
          prompt: TEST_PROMPT,
          status: 'processing',
          generated_data: weeklyOrigin ? { ...weeklyMenuRequestWeeklyOriginData(), version: 'v4' } : { version: 'v4' },
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`weekly_menu_requests insert: ${error?.message}`);
      return data.id as string;
    }

    /** Edge Function などの書き手と同じく、service role で行を更新する (トリガーは書き手を見分けない) */
    async function updateRequest(requestId: string, values: Record<string, unknown>): Promise<void> {
      const { error } = await srAdmin.from('weekly_menu_requests').update(values).eq('id', requestId);
      if (error) throw new Error(`weekly_menu_requests update: ${error.message}`);
    }

    it('印のある行が completed になると本人に 1 つ付き、completed のまま書き直しても 1 つのまま (獲得日時も変わらない)', async () => {
      const user = await createSignedInUser('w6-complete');
      const requestId = await insertProcessingRequest(user.id, true);
      expect(await plannerRows(user.id)).toEqual([]);

      await updateRequest(requestId, { status: 'completed' });
      const afterComplete = await plannerRows(user.id);
      expect(afterComplete).toHaveLength(1);

      // completed のまま進み具合と status を書き直す (status が変わらないのでトリガーは動かない。動いても ON CONFLICT で 1 行のまま)
      await updateRequest(requestId, { status: 'completed', progress: { currentStep: 1, totalSteps: 1, message: '完了' } });
      const afterRewrite = await plannerRows(user.id);
      expect(afterRewrite).toHaveLength(1);
      expect(afterRewrite[0].obtained_at).toBe(afterComplete[0].obtained_at);
    });

    it('印のある行が failed になったとき・印の無い行が completed になったときは付かない', async () => {
      const user = await createSignedInUser('w6-not');
      const failed = await insertProcessingRequest(user.id, true);
      const unmarked = await insertProcessingRequest(user.id, false);

      await updateRequest(failed, { status: 'failed', error_message: '中止しました' });
      await updateRequest(unmarked, { status: 'completed' });

      expect(await plannerRows(user.id)).toEqual([]);
    });

    it('最後の書き込みが generated_data を印の無いものに書き直しても、更新前の行に印があれば付く', async () => {
      const user = await createSignedInUser('w6-old-mark');
      const requestId = await insertProcessingRequest(user.id, true);

      await updateRequest(requestId, { status: 'completed', generated_data: { version: 'v4' } });

      expect(await plannerRows(user.id)).toHaveLength(1);
    });

    it('お試しの献立の追加で付いたあとに完了しても 1 つのまま (獲得日時はお試しのときのまま)', async () => {
      const user = await createSignedInUser('w6-tour');
      const addRes = await postMenuAdd(
        new Request('http://localhost/api/menu-plans/add?source=handson_tour', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...MOCK_MENU_RESPONSE, sandbox: true, source: 'handson_tour' }),
        }),
      );
      expect(addRes.status).toBe(200);
      const afterTour = await plannerRows(user.id);
      expect(afterTour).toHaveLength(1);

      const requestId = await insertProcessingRequest(user.id, true);
      await updateRequest(requestId, { status: 'completed' });

      const afterWeekly = await plannerRows(user.id);
      expect(afterWeekly).toHaveLength(1);
      expect(afterWeekly[0].obtained_at).toBe(afterTour[0].obtained_at);
    });

    it('rollback でトリガーを消すと付かなくなり、migration をもう一度流す (2 回流しても同じ) と付くようになる', async () => {
      const rolledBackUser = await createSignedInUser('w6-rollback');
      const rolledBackRequest = await insertProcessingRequest(rolledBackUser.id, true);
      try {
        await asPostgres(PLANNER_TRIGGER_ROLLBACK_SQL);
        await updateRequest(rolledBackRequest, { status: 'completed' });
        expect(await plannerRows(rolledBackUser.id)).toEqual([]);
      } finally {
        // 途中で失敗しても、DB を migration を当てた状態に戻す
        await asPostgres(PLANNER_TRIGGER_MIGRATION_SQL);
      }
      await asPostgres(PLANNER_TRIGGER_MIGRATION_SQL);

      const reappliedUser = await createSignedInUser('w6-reapplied');
      const reappliedRequest = await insertProcessingRequest(reappliedUser.id, true);
      await updateRequest(reappliedRequest, { status: 'completed' });
      expect(await plannerRows(reappliedUser.id)).toHaveLength(1);
    });
  });
});
