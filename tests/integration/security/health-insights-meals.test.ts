/**
 * #1040 (F2-02) / #1306 健康インサイトの食事の取得 (fetchRecentMealDays) の実 DB 確認
 *
 * 修正前の POST /api/health/insights は planned_meals に user_id / planned_date を指定しており、
 * PostgREST が 42703 で拒否していたが、戻り値の error を見ていなかったため、食事は常に「データなし」だった。
 * 単体テスト (tests/health-insights-route.test.ts) は Supabase をモックするので列の有無を見ない。
 * tests/integration/security/select-columns-exist.test.ts も、`.select()` の第 1 階層の列とリレーション名しか見ず、
 * ネストした planned_meals(...) の中の列は見ない。
 * そこで、ルートが使う fetchRecentMealDays を、本物の PostgREST + RLS (本人の JWT) に対して実行する。
 *
 * 確認すること:
 *   - エラーにならない (ネストした列が実在し、planned_meals → user_daily_meals の外部キーで埋め込める)
 *   - 本人の、食事がある、sandbox でない、今日までの日だけが、新しい順に最大 7 日分返る
 *   - 他人の日は (user_id を指定しても) RLS で見えない
 *   - 取れた行を formatMealDaysForPrompt に通すと、実際の型でも期待どおりの合計になる
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/health-insights-meals.test.ts
 * (dev サーバは不要。POST /api/health/insights 自体は LLM を呼ぶので、ここでは取得部分だけを確認する)
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { todayLocal } from '../../../src/lib/date-utils';
import { fetchRecentMealDays, formatMealDaysForPrompt, RECENT_MEAL_DAYS } from '../../../src/lib/health-insight-meals';

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
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

const srAdmin = client(serviceKey);

interface TestUser {
  id: string;
  /** その利用者の JWT で RLS を通る client (ルートの createClient() と同じ立場) */
  db: SupabaseClient;
}

const TS = Date.now();
const PASSWORD = `Pw-${randomUUID()}`;
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-insights-meals-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `insights-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, db: client(anonKey, signIn.data.session.access_token) };
}

/** テスト中ずっと同じ「今日」(JST) を使う。日付またぎで期待値がずれないよう最初に 1 回だけ取る */
const TODAY = todayLocal();

/** 今日から offset 日ずらした日付 (YYYY-MM-DD)。カレンダー上の日付の足し引きなのでタイムゾーンに依らない */
function dayAt(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

interface MealSeed {
  type: string;
  kcal: number;
  p: number;
  f: number;
  c: number;
}

/**
 * 1 日分の食事。夕食を先に入れる (出力が食事区分の順に並ぶことの確認)。
 * 朝食の kcal だけ日ごとに変え、日ごとの合計が違うようにする (別の日の値が混ざっていないことの確認)。
 */
function mealsFor(k: number): MealSeed[] {
  return [
    { type: 'dinner', kcal: 700, p: 30, f: 20, c: 80 },
    { type: 'breakfast', kcal: 400 + k, p: 20.5, f: 10.25, c: 50 },
  ];
}

interface DaySeed {
  offset: number;
  sandbox?: boolean;
  meals: MealSeed[];
}

async function seedDays(userId: string, days: DaySeed[]) {
  const { data: dailyRows, error: dailyError } = await srAdmin
    .from('user_daily_meals')
    .insert(days.map((d) => ({ user_id: userId, day_date: dayAt(d.offset), is_sandbox: d.sandbox ?? false })))
    .select('id, day_date');
  if (dailyError || !dailyRows) throw new Error(`user_daily_meals: ${dailyError?.message}`);

  const idByDate = new Map(dailyRows.map((row) => [row.day_date as string, row.id as string]));
  const mealRows = days.flatMap((d) =>
    d.meals.map((m) => ({
      daily_meal_id: idByDate.get(dayAt(d.offset))!,
      meal_type: m.type,
      dish_name: `#1040 テスト料理 ${m.type}`,
      calories_kcal: m.kcal,
      protein_g: m.p,
      fat_g: m.f,
      carbs_g: m.c,
    })),
  );
  if (mealRows.length > 0) {
    const { error: mealError } = await srAdmin.from('planned_meals').insert(mealRows);
    if (mealError) throw new Error(`planned_meals: ${mealError.message}`);
  }
}

/** mealsFor(k) の 1 日分が formatMealDaysForPrompt でどう出力されるか (朝食 400+k + 夕食 700) */
function expectedLine(offset: number): string {
  const k = Math.abs(offset);
  // 脂質 10.25 + 20 = 30.25 → 小数 1 桁に丸めて 30.3
  return `- ${dayAt(offset)}: ${1100 + k}kcal, タンパク50.5g, 脂質30.3g, 炭水化物130g（朝食・夕食）`;
}

/**
 * 利用者 A の日付の配置 (今日からの日数)。除外される日が、除外されなければ上位 7 日に入る位置にある。
 *   +1 : 先の予定 (今日より後)        → day_date <= 今日 で除外
 *    0 : 食事あり
 *   -1 : 食事あり
 *   -2 : sandbox の日 (ダミーの献立)   → is_sandbox = false で除外
 *   -3 : 食事なし (空の user_daily_meals) → planned_meals!inner で除外
 *   -4 〜 -10 : 食事あり              → 上位 7 日に入るのは -8 まで。-9, -10 は limit で落ちる
 */
const A_LAYOUT: DaySeed[] = [
  { offset: 1, meals: mealsFor(1) },
  { offset: 0, meals: mealsFor(0) },
  { offset: -1, meals: mealsFor(1) },
  { offset: -2, sandbox: true, meals: mealsFor(2) },
  { offset: -3, meals: [] },
  ...[-4, -5, -6, -7, -8, -9, -10].map((offset) => ({ offset, meals: mealsFor(Math.abs(offset)) })),
];

/** A の結果として返るはずの日 (新しい順) */
const A_EXPECTED_OFFSETS = [0, -1, -4, -5, -6, -7, -8];

let userA: TestUser;
let userB: TestUser;

beforeAll(async () => {
  [userA, userB] = await Promise.all([createUser('a'), createUser('b')]);
  await seedDays(userA.id, A_LAYOUT);
  await seedDays(userB.id, [{ offset: 0, meals: [{ type: 'lunch', kcal: 555, p: 1, f: 2, c: 3 }] }]);
}, 120_000);

afterAll(async () => {
  // auth ユーザーを消すと user_daily_meals / planned_meals / user_profiles は FK で連鎖削除される
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
  if (createdUserIds.length > 0) {
    const { data: leftDays } = await srAdmin.from('user_daily_meals').select('id').in('user_id', createdUserIds);
    expect(leftDays ?? []).toEqual([]);
  }
}, 60_000);

describe('#1040 F2-02 fetchRecentMealDays (実 DB・本人の JWT)', () => {
  it('H-1: エラーにならない (ネストした列まで実在する。修正前の planned_meals.planned_date / user_id は 42703)', async () => {
    const { data, error } = await fetchRecentMealDays(userA.db, userA.id);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it('H-2: 本人の食事がある日だけが、新しい順に最大 7 日分返る (先の予定・sandbox・食事なしの日は除く)', async () => {
    const { data, error } = await fetchRecentMealDays(userA.db, userA.id);

    expect(error).toBeNull();
    expect(RECENT_MEAL_DAYS).toBe(7);
    expect(data!.map((d) => d.day_date)).toEqual(A_EXPECTED_OFFSETS.map(dayAt));
    for (const row of data!) {
      expect(row.planned_meals).toHaveLength(2);
    }

    // 除外した日が含まれていない (どの除外が効いているかを個別に示す)
    const dates = data!.map((d) => d.day_date);
    expect(dates).not.toContain(dayAt(1)); // 先の予定
    expect(dates).not.toContain(dayAt(-2)); // sandbox
    expect(dates).not.toContain(dayAt(-3)); // 食事なし
    expect(dates).not.toContain(dayAt(-9)); // 8 日目以降は limit
    expect(dates).not.toContain(dayAt(-10));
  });

  it('H-3: today を渡すと、その日以前の日だけが返る', async () => {
    const { data, error } = await fetchRecentMealDays(userA.db, userA.id, dayAt(-5));

    expect(error).toBeNull();
    // -5 以前で食事のある日: -5, -6, -7, -8, -9, -10 (6 日)
    expect(data!.map((d) => d.day_date)).toEqual([-5, -6, -7, -8, -9, -10].map(dayAt));
  });

  it('H-4: 取れた行(実際の型の numeric)を整形すると、日ごとの合計と食事区分の行になる', async () => {
    const { data } = await fetchRecentMealDays(userA.db, userA.id);

    expect(formatMealDaysForPrompt(data)).toBe(A_EXPECTED_OFFSETS.map(expectedLine).join('\n'));
  });

  it('H-5: 他人の日は、user_id を指定しても RLS で見えない。本人の client なら自分の日は見える', async () => {
    const aReadsB = await fetchRecentMealDays(userA.db, userB.id);
    expect(aReadsB.error).toBeNull();
    expect(aReadsB.data).toEqual([]);

    // B の日がちゃんと存在し、B 本人なら読めること (上が「データが無いから空」ではない確認)
    const bReadsB = await fetchRecentMealDays(userB.db, userB.id);
    expect(bReadsB.error).toBeNull();
    expect(bReadsB.data).toHaveLength(1);
    expect(bReadsB.data![0].day_date).toBe(dayAt(0));
    expect(formatMealDaysForPrompt(bReadsB.data)).toBe(
      `- ${dayAt(0)}: 555kcal, タンパク1g, 脂質2g, 炭水化物3g（昼食）`,
    );
  });
});
