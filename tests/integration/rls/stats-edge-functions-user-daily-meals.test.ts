/**
 * #1306 セグメント統計の Edge Function (calculate-segment-stats) が、実際のスキーマで集計できることの回帰テスト
 *
 * 修正前の問題:
 *   calculate-segment-stats は planned_meals を
 *   `meal_plan_days!inner(day_date, meal_plans!inner(user_id))` で取得していた。
 *   この 2 テーブルは date-based model への移行で削除済みで、本番にも無い。
 *   PostgREST は PGRST200 (テーブルどうしのつながりが見つからない) で失敗するが、supabase-js は例外にせず
 *   { data: null, error } を返す。error を無視して `data ?? []` としていたため、
 *   planned_meals 由来の指標 (朝食実行率・野菜スコア・栄養スコア・メニュー実行率) が
 *   全員 0 になり、それが本当の値として保存され、統計・ランキングにも使われた。
 *   単体テストは Supabase を偽物にするので、このような「クエリが実スキーマで通るか」は見られない。
 *
 * 組織統計 (aggregate-org-stats) も同じ表を読んでいるが、ここでは直さない。
 * オーナー判断 (#1325「組織の集計を止める」) により、組織統計は直して動かすのではなく止める (計画の T08)。
 * 直すと、組織ダッシュボードの「Refresh Data」から集計が実際に作られるようになり、判断と食い違うため。
 *
 * 修正後の期待:
 *   - planned_meals を user_daily_meals!inner(user_id, day_date) で結合し、対象期間・非ハンズオン
 *     (is_sandbox = false) に絞って集計する。planned_meals の所有者は daily_meal_id → user_daily_meals.user_id
 *   - 集計結果が user_metrics / segment_stats / user_segment_rankings / user_badges に保存される
 *   - 途中のクエリが失敗したら例外にして、ログと応答 (500) に残す (この統合テストでは、全クエリが成功することを確認する)
 *
 * 本物のハンドラ (Deno.serve に渡された関数) を、実際のローカル Supabase に向けて呼ぶ。
 * Deno と db-logger (app_logs への書き込み・https://esm.sh の import) だけを差し替える。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/stats-edge-functions-user-daily-meals.test.ts
 *
 * 注意: calculate-segment-stats は DB 内の全ユーザー・全指標定義・全セグメント定義を処理する。
 *   このテストのセグメントは、テストユーザーだけが持つ perf_modes の値で絞る (他の行とは混ざらない)。
 *   指標定義 (metric_definitions) が無ければ作り、作ったものだけを最後に消す。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const CRON_SECRET = 'it-1306-cron-secret';

const h = vi.hoisted(() => ({
  serves: [] as Array<(req: Request) => Promise<Response>>,
  errors: [] as Array<{ message: string; error: unknown }>,
}));

// ロガーは app_logs へ書き込む (しかも https://esm.sh を import する) ので差し替える。error は記録して、成功時に 0 件であることを確かめる
vi.mock('../../../supabase/functions/_shared/db-logger.ts', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, error?: unknown) => {
      h.errors.push({ message, error });
    },
  }),
  generateRequestId: () => 'req_it_1306',
}));

const sr: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
const MARK = `x1306-${TS}`; // このテストのユーザーだけが持つ perf_modes の値
const MARK_ZERO = `x1306z-${TS}`; // 何も記録していない 5 人 (全指標が全員 0) だけが持つ perf_modes の値
const D = '2026-10-08'; // 集計する日 (2026-10-08 は木曜日)
const PREV = '2026-10-07';

const createdUserIds: string[] = [];
const createdMetricIds: string[] = [];
let segmentId: string | null = null;
let zeroSegmentId: string | null = null;

async function createUser(label: string, extra: Record<string, unknown> = {}): Promise<string> {
  const email = `it1306-${label}-${TS}@homegohan.test`;
  const { data, error } = await sr.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await sr
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `it1306-${label}`, age_group: '30s', gender: 'other', ...extra }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  return data.user.id;
}

interface MealSeed {
  type: string;
  completedAt?: string;
  completed?: boolean;
  veg?: number;
}

/** user_daily_meals の 1 日分と、その planned_meals を作る */
async function seedDay(userId: string, dayDate: string, meals: MealSeed[], options: { sandbox?: boolean } = {}): Promise<void> {
  const { data: day, error } = await sr
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: dayDate, is_sandbox: options.sandbox ?? false })
    .select('id')
    .single();
  if (error || !day) throw new Error(`user_daily_meals: ${error?.message}`);
  if (meals.length === 0) return;
  const { error: mealError } = await sr.from('planned_meals').insert(
    meals.map((m, i) => ({
      daily_meal_id: day.id,
      meal_type: m.type,
      dish_name: `it1306-${m.type}-${i}`,
      is_completed: m.completed ?? m.completedAt !== undefined,
      completed_at: m.completedAt ?? null,
      veg_score: m.veg ?? null,
    })),
  );
  if (mealError) throw new Error(`planned_meals: ${mealError.message}`);
}

async function callHandler(index: number, body: Record<string, unknown>) {
  const res = await h.serves[index](
    new Request('http://localhost/functions/v1/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: await res.json() };
}

const callSegmentStats = (body: Record<string, unknown>) => callHandler(0, body);

beforeAll(async () => {
  const env: Record<string, string> = {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    CRON_SECRET,
  };
  vi.stubGlobal('Deno', {
    env: { get: (key: string) => env[key] },
    serve: (handler: (req: Request) => Promise<Response>) => {
      h.serves.push(handler);
    },
  });
  await import('../../../supabase/functions/calculate-segment-stats/index.ts');
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // ユーザーを消すと user_daily_meals / planned_meals / user_metrics / user_segment_rankings / user_badges が CASCADE で消える
  for (const id of createdUserIds) await sr.auth.admin.deleteUser(id);
  if (segmentId) await sr.from('segment_definitions').delete().eq('id', segmentId);
  if (zeroSegmentId) await sr.from('segment_definitions').delete().eq('id', zeroSegmentId);
  if (createdMetricIds.length > 0) await sr.from('metric_definitions').delete().in('id', createdMetricIds);
}, 120_000);

// ================================================================
// calculate-segment-stats
// ================================================================
describe('calculate-segment-stats: 実スキーマで指標・統計・ランキング・バッジが作られる (#1306)', () => {
  const userIds: string[] = [];
  const zeroUserIds: string[] = [];
  const metricIds: Record<string, string> = {};
  let bulkUserId: string;

  async function ensureMetric(code: string, name: string): Promise<string> {
    const { data: existing, error } = await sr.from('metric_definitions').select('id').eq('code', code).maybeSingle();
    if (error) throw new Error(`metric_definitions select ${code}: ${error.message}`);
    if (existing) return existing.id as string;
    const { data, error: insertError } = await sr
      .from('metric_definitions')
      .insert({ code, name, category: 'test', higher_is_better: true, is_active: true })
      .select('id')
      .single();
    if (insertError || !data) throw new Error(`metric_definitions insert ${code}: ${insertError?.message}`);
    createdMetricIds.push(data.id as string);
    return data.id as string;
  }

  let response: { res: Response; json: Record<string, any> };

  beforeAll(async () => {
    metricIds.exec = await ensureMetric('menu_execution_rate', 'メニュー実行率');
    metricIds.bf = await ensureMetric('breakfast_rate', '朝食実行率');
    metricIds.veg = await ensureMetric('veg_score_avg', '野菜スコア');
    metricIds.nut = await ensureMetric('nutrition_score', '栄養スコア');
    // 既存の指標が非アクティブだと処理されない。このテストが依存する 4 つはアクティブであること
    const { data: actives } = await sr.from('metric_definitions').select('id').in('id', Object.values(metricIds)).eq('is_active', true);
    expect((actives ?? []).length).toBe(4);

    // このテストのユーザーだけが持つ perf_modes の値で絞るセグメント (5 人未満の統計は作られないので、ちょうど 5 人)
    for (let i = 1; i <= 5; i += 1) {
      userIds.push(await createUser(`s${i}`, { perf_modes: [MARK] }));
    }
    const { data: segment, error } = await sr
      .from('segment_definitions')
      .insert({ code: MARK, name: `it1306 セグメント`, axes: { perf_mode: MARK }, level: 9, is_active: true })
      .select('id')
      .single();
    if (error || !segment) throw new Error(`segment_definitions: ${error?.message}`);
    segmentId = segment.id as string;

    // 何も記録していない 5 人のセグメント。全指標が全員 0 になる (本番で起きる見込みの状況。
    // 修正前は、全員に『平均超え』、取得順の先頭の 1 人に『1 位』などが付いた)
    for (let i = 1; i <= 5; i += 1) {
      zeroUserIds.push(await createUser(`z${i}`, { perf_modes: [MARK_ZERO] }));
    }
    const { data: zeroSegment, error: zeroSegmentError } = await sr
      .from('segment_definitions')
      .insert({ code: MARK_ZERO, name: 'it1306 全員 0 セグメント', axes: { perf_mode: MARK_ZERO }, level: 9, is_active: true })
      .select('id')
      .single();
    if (zeroSegmentError || !zeroSegment) throw new Error(`segment_definitions (zero): ${zeroSegmentError?.message}`);
    zeroSegmentId = zeroSegment.id as string;

    // 同じ日 (2026-10-08) に 4 食ずつ。メニュー実行率が 100 / 75 / 50 / 25 / 0 になるようにする
    //   s1: 4/4 完了 (スコア 5, 4, 3, なし)  → 実行率 100, 朝食 100, 野菜 4.0, 栄養 80
    //   s2: 3/4 完了 (スコア 4, 4, 4, なし)  → 実行率  75, 朝食 100, 野菜 4.0, 栄養 80
    //   s3: 2/4 完了 (スコア 3, 3, 3, なし)  → 実行率  50, 朝食 100, 野菜 3.0, 栄養 60
    //   s4: 昼だけ完了 (スコア 2 が 4 つ)     → 実行率  25, 朝食   0, 野菜 2.0, 栄養 40
    //   s5: 何も完了していない (スコア 1 が 4 つ) → 実行率 0, 朝食   0, 野菜 1.0, 栄養 20
    const done = '2026-10-08T03:00:00Z';
    await seedDay(userIds[0], D, [
      { type: 'breakfast', completedAt: done, veg: 5 }, { type: 'lunch', completedAt: done, veg: 4 },
      { type: 'dinner', completedAt: done, veg: 3 }, { type: 'snack', completedAt: done },
    ]);
    await seedDay(userIds[1], D, [
      { type: 'breakfast', completedAt: done, veg: 4 }, { type: 'lunch', completedAt: done, veg: 4 },
      { type: 'dinner', completedAt: done, veg: 4 }, { type: 'snack', completed: false },
    ]);
    await seedDay(userIds[2], D, [
      { type: 'breakfast', completedAt: done, veg: 3 }, { type: 'lunch', completedAt: done, veg: 3 },
      { type: 'dinner', completed: false, veg: 3 }, { type: 'snack', completed: false },
    ]);
    await seedDay(userIds[3], D, [
      { type: 'breakfast', completed: false, veg: 2 }, { type: 'lunch', completedAt: done, veg: 2 },
      { type: 'dinner', completed: false, veg: 2 }, { type: 'snack', completed: false, veg: 2 },
    ]);
    await seedDay(userIds[4], D, [
      { type: 'breakfast', completed: false, veg: 1 }, { type: 'lunch', completed: false, veg: 1 },
      { type: 'dinner', completed: false, veg: 1 }, { type: 'snack', completed: false, veg: 1 },
    ]);
    // s5 の別の日にハンズオン (is_sandbox) の完了済みの食事。実際の食事ではないので、s5 の指標を押し上げてはいけない
    await seedDay(
      userIds[4],
      PREV,
      [{ type: 'breakfast', completedAt: '2026-10-06T23:00:00Z', veg: 5 }, { type: 'lunch', completedAt: done, veg: 5 }],
      { sandbox: true },
    );
    // 1 人だけ 1,100 件 (先に入れた 1,000 件は未完了、最後に入れた 100 件が完了)。このセグメントには入らない (perf_modes が違う)。
    // 期間内の planned_meals は全ユーザー分をまとめて読むので、そのまま取ると 1000 行で黙って打ち切られ、
    // 後ろの完了済み 100 件が落ちて、この人の実行率が 9% (100/1100) にならない
    bulkUserId = await createUser('bulk');
    await seedDay(bulkUserId, D, [
      ...Array.from({ length: 1000 }, () => ({ type: 'lunch', completed: false })),
      ...Array.from({ length: 100 }, () => ({ type: 'lunch', completedAt: done })),
    ]);

    // 期間は「今」の週 (月曜起点)。2026-10-08 (木) がどの扱いでも期間の真ん中に入るよう、時刻を固定する
    // (Date だけ偽物にする。通信のタイマーはそのまま動く)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T03:00:00Z'));
    h.errors.length = 0;
    // バッジを付与するたびに console.log するので、出力を抑える
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      response = await callSegmentStats({ periodType: 'weekly' });
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  }, 120_000);

  async function metricValues(metricId: string): Promise<number[]> {
    const { data, error } = await sr.from('user_metrics').select('user_id, value').eq('metric_id', metricId).eq('period_type', 'weekly').in('user_id', userIds);
    if (error) throw new Error(`user_metrics: ${error.message}`);
    const byUser = new Map((data ?? []).map((r) => [r.user_id as string, Number(r.value)]));
    return userIds.map((id) => byUser.get(id) ?? Number.NaN);
  }

  it('S-1: 全クエリが成功し、エラーのログも残らない', () => {
    expect(response.json).toMatchObject({ success: true, periodType: 'weekly' });
    expect(response.res.status).toBe(200);
    expect(response.json.processedUsers).toBeGreaterThanOrEqual(5);
    expect(h.errors).toEqual([]);
  });

  it('S-2: planned_meals 由来の指標が、所有者ごとに正しい値で保存される (修正前は全員 0)', async () => {
    expect(await metricValues(metricIds.exec)).toEqual([100, 75, 50, 25, 0]);
    expect(await metricValues(metricIds.bf)).toEqual([100, 100, 100, 0, 0]);
    expect(await metricValues(metricIds.veg)).toEqual([4, 4, 3, 2, 1]);
    expect(await metricValues(metricIds.nut)).toEqual([80, 80, 60, 40, 20]);
  });

  it('S-6: 期間内の planned_meals が API の 1 回の応答の上限 (1000 行) を超えても、全件が指標に反映される', async () => {
    const { data, error } = await sr
      .from('user_metrics')
      .select('value')
      .eq('user_id', bulkUserId)
      .eq('metric_id', metricIds.exec)
      .eq('period_type', 'weekly');
    expect(error).toBeNull();
    // 完了 100 件 / 全 1,100 件 = 9.09% → 9。1000 行で打ち切られていれば、後ろの完了 100 件が落ちて 0 になる
    expect((data ?? []).map((r) => Number(r.value))).toEqual([9]);
  });

  it('S-3: セグメントの統計が保存される (5 人、平均 50、中央値 50)', async () => {
    const { data, error } = await sr
      .from('segment_stats')
      .select('user_count, avg_value, median_value, min_value, max_value, p10_value, p25_value, p75_value, p90_value')
      .eq('segment_id', segmentId!)
      .eq('metric_id', metricIds.exec)
      .eq('period_type', 'weekly');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    const row = Object.fromEntries(Object.entries(data![0]).map(([k, v]) => [k, Number(v)]));
    expect(row).toEqual({
      user_count: 5, avg_value: 50, median_value: 50, min_value: 0, max_value: 100,
      p10_value: 10, p25_value: 25, p75_value: 75, p90_value: 90,
    });
  });

  it('S-4: ユーザーのランキングが保存される (1 位 → 5 位、平均との差)', async () => {
    const { data, error } = await sr
      .from('user_segment_rankings')
      .select('user_id, rank, total_users, percentile, value, vs_avg_rate')
      .eq('segment_id', segmentId!)
      .eq('metric_id', metricIds.exec)
      .eq('period_type', 'weekly')
      .order('rank');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => [r.user_id, r.rank, r.total_users, Number(r.percentile), Number(r.value), Number(r.vs_avg_rate)])).toEqual([
      [userIds[0], 1, 5, 80, 100, 100],
      [userIds[1], 2, 5, 60, 75, 50],
      [userIds[2], 3, 5, 40, 50, 0],
      [userIds[3], 4, 5, 20, 25, -50],
      [userIds[4], 5, 5, 0, 0, -100],
    ]);
  });

  it('S-4b: 同じ値の利用者は同じ順位になる (朝食実行率は s1〜s3 が 100 で同率 1 位、s4・s5 が 0 で同率 4 位)。百分位は同点の最後の順位で数える', async () => {
    const { data, error } = await sr
      .from('user_segment_rankings')
      .select('user_id, rank, percentile, value, vs_avg_rate')
      .eq('segment_id', segmentId!)
      .eq('metric_id', metricIds.bf)
      .eq('period_type', 'weekly');
    expect(error).toBeNull();
    const byUser = new Map((data ?? []).map((r) => [r.user_id as string, [r.rank, Number(r.percentile), Number(r.value), Number(r.vs_avg_rate)]]));
    // [順位, 百分位, 値, 平均比]。平均 60 に対して 100 は +67%、0 は -100%。
    // 百分位は「自分より厳密に下の利用者の割合」: s1〜s3 は 3 人同率なので 3 位ぶんの 40、s4・s5 は下に誰もいないので 0
    expect(userIds.map((id) => byUser.get(id))).toEqual([
      [1, 40, 100, 67],
      [1, 40, 100, 67],
      [1, 40, 100, 67],
      [4, 0, 0, -100],
      [4, 0, 0, -100],
    ]);
  });

  /** バッジの code ごとに、userIds の中でそのバッジを持つ利用者の添字 (昇順) を返す */
  async function badgeHolders(codes: string[]): Promise<Record<string, number[]>> {
    const { data: badges, error: badgesError } = await sr.from('badges').select('id, code').in('code', codes);
    expect(badgesError).toBeNull();
    expect((badges ?? []).map((b) => b.code).sort()).toEqual([...codes].sort());
    const { data, error } = await sr.from('user_badges').select('user_id, badge_id').in('badge_id', (badges ?? []).map((b) => b.id)).in('user_id', userIds);
    expect(error).toBeNull();
    const result: Record<string, number[]> = {};
    for (const badge of badges ?? []) {
      result[badge.code as string] = (data ?? [])
        .filter((r) => r.badge_id === badge.id)
        .map((r) => userIds.indexOf(r.user_id as string))
        .sort((a, b) => a - b);
    }
    return result;
  }

  it('S-5: 同率を含む 1 位の利用者に順位バッジが付与される。同点を取得順で 1 人に決めない (修正前は badges の取得が 22P02 で失敗し、バッジは一度も付与されなかった)', async () => {
    const { data: badge, error: badgeError } = await sr.from('badges').select('id').eq('code', 'segment_rank_1').single();
    expect(badgeError).toBeNull();

    const { data, error } = await sr.from('user_badges').select('user_id, message, context_json').eq('badge_id', badge!.id).in('user_id', userIds);
    expect(error).toBeNull();
    // 1 位になる指標があるのは s1〜s3 (メニュー実行率は s1 だけ、朝食実行率は s1〜s3 が同率、野菜・栄養は s1・s2 が同率)
    expect(new Set((data ?? []).map((r) => r.user_id))).toEqual(new Set([userIds[0], userIds[1], userIds[2]]));
    for (const row of data ?? []) {
      expect(row.context_json).toMatchObject({ segment_id: segmentId, rank: 1, period_type: 'weekly' });
      expect(row.message).toContain('1位');
    }
  });

  it('S-5b: 指標を限ったバッジは、その指標で同率を含む 1 位の利用者に付く。実績の無い下位の利用者 (s4・s5) には何も付かない', async () => {
    const holders = await badgeHolders(['breakfast_champion', 'veggie_champion', 'segment_rank_1', 'segment_rank_top3', 'segment_above_avg']);
    expect(holders).toEqual({
      breakfast_champion: [0, 1, 2], // 朝食実行率: s1〜s3 が同率 1 位
      veggie_champion: [0, 1], // 野菜スコア: s1・s2 が同率 1 位
      segment_rank_1: [0, 1, 2],
      segment_rank_top3: [0, 1, 2], // s4・s5 はどの指標でも 4 位以下か、値が 0
      segment_above_avg: [0, 1, 2], // s3 はメニュー実行率ではちょうど平均だが、朝食実行率などで平均を超える
    });

    const { data, error } = await sr.from('user_badges').select('user_id').in('user_id', [userIds[3], userIds[4]]);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('S-7: 5 人とも何も記録していない (全指標が全員 0) セグメントは、ランキングは作るが、バッジは 1 件も付かない', async () => {
    const { data, error } = await sr
      .from('user_segment_rankings')
      .select('user_id, rank, total_users, percentile, value, vs_avg_rate')
      .eq('segment_id', zeroSegmentId!)
      .eq('period_type', 'weekly')
      .in('metric_id', Object.values(metricIds))
      .in('user_id', zeroUserIds);
    expect(error).toBeNull();
    expect(data).toHaveLength(4 * 5); // 4 指標 × 5 人
    for (const row of data ?? []) {
      // 全員 0 = 全員が同率 1 位 (自分より下の人はいないので百分位 0)。
      // 平均が 0 なので平均との差の割合は決まらず null (0 で保存すると、平均ちょうどと区別できない)
      expect(row).toMatchObject({ rank: 1, total_users: 5, vs_avg_rate: null });
      expect(Number(row.percentile)).toBe(0);
      expect(Number(row.value)).toBe(0);
    }

    const { data: badges, error: badgesError } = await sr.from('user_badges').select('user_id, badge_id').in('user_id', zeroUserIds);
    expect(badgesError).toBeNull();
    expect(badges).toEqual([]);
  });
});
