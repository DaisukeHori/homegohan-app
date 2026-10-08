/**
 * #1215 GET /api/badges の回帰テスト (実 DB + 実ルート)
 *
 * 修正前は次の 2 つが重なって、食事の記録に基づくバッジが 1 つも保存されなかった。
 * 単体テスト (tests/badges-route.test.ts) は Supabase をモックしているため、どちらも見えなかった。
 *   1. planned_meals には user_id 列が無い (所有者は daily_meal_id → user_daily_meals.user_id)。
 *      `.eq('user_id', ...)` は PostgREST が 42703 で拒否するが、error を見ていなかったため
 *      完了食事数・自炊数が常に 0 になり、first_bite / photo_10 が付かなかった。
 *   2. user_badges には SELECT ポリシーしか無く、セッションの client での insert は常に 42501。
 *      error を見ていなかったため、連続日数のバッジは保存されないまま「新規獲得」として毎回返っていた。
 *
 * 期待する挙動 (修正後):
 *   - 本人の完了済みの食事から食事数 / 自炊数 / 連続日数が数えられ、他人の食事は数えない
 *   - 条件を満たしたバッジが user_badges に保存され (service role)、保存できた分だけ「新規獲得」として 1 回だけ返る
 *   - 2 回目以降は新規獲得 0 件で、獲得日時 (obtainedAt) は変わらない
 *   - 同時に 2 回呼ばれても、各バッジの「新規獲得」は全体で 1 回だけ。行も重複しない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/badges-api.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';

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

interface TestUser {
  id: string;
  jwt: string;
}

interface BadgeDto {
  id: string;
  code: string;
  earned: boolean;
  obtainedAt: string | null;
}

interface BadgesResponse {
  badges: BadgeDto[];
  newEarnedCount: number;
  newEarnedBadgeCodes: string[];
  stats: { completedMeals: number; cookMeals: number; streak: number };
}

const TS = Date.now();
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-badges-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `badges-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** route.ts の連続日数計算と同じ方法で「n 日前」の日付文字列を作る */
function dayStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

interface MealSeed {
  mode: string;
  isCompleted: boolean;
}

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];

/**
 * 今日から daysCount 日連続の user_daily_meals を作り、各日に meals の planned_meals を入れる。
 * 本番スキーマの planned_meals に user_id 列は無いので、所有者は daily_meal_id 経由で決まる。
 */
async function seedMeals(userId: string, daysCount: number, meals: MealSeed[]) {
  const days = Array.from({ length: daysCount }, (_, i) => ({ user_id: userId, day_date: dayStr(i) }));
  const { data: dailyRows, error: dailyError } = await srAdmin.from('user_daily_meals').insert(days).select('id');
  if (dailyError || !dailyRows) throw new Error(`user_daily_meals: ${dailyError?.message}`);

  const rows = dailyRows.flatMap((daily) =>
    meals.map((meal, index) => ({
      daily_meal_id: daily.id,
      meal_type: MEAL_TYPES[index % MEAL_TYPES.length],
      dish_name: `#1215 テスト料理 ${index}`,
      mode: meal.mode,
      is_completed: meal.isCompleted,
    })),
  );
  const { error: mealError } = await srAdmin.from('planned_meals').insert(rows);
  if (mealError) throw new Error(`planned_meals: ${mealError.message}`);
}

async function persistedBadgeCodes(userId: string): Promise<string[]> {
  const { data, error } = await srAdmin.from('user_badges').select('badges(code)').eq('user_id', userId);
  if (error) throw new Error(`persistedBadgeCodes: ${error.message}`);
  return (data ?? [])
    .map((r) => (r as unknown as { badges: { code: string } | { code: string }[] }).badges)
    .map((b) => (Array.isArray(b) ? b[0].code : b.code))
    .sort();
}

async function getBadges(jwt: string) {
  return apiCall<BadgesResponse>('GET', '/api/badges', jwt);
}

function byCode(res: BadgesResponse, code: string): BadgeDto {
  const badge = res.badges.find((b) => b.code === code);
  if (!badge) throw new Error(`レスポンスに ${code} がありません`);
  return badge;
}

// 食事の記録に基づくバッジ (route.ts が判定する、本番のマスタに存在する 4 種)
const RULE_BADGES = ['first_bite', 'photo_10', 'streak_3', 'streak_7'];

let userA: TestUser; // 3 日連続 × 4 食 (完了) + 未完了 1 食 = 完了 12 食 (うち自炊 6 食)
let userB: TestUser; // 1 日 × 5 食 (完了)。A の数に混ざらないことの確認用
let userC: TestUser; // 食事なし
let userD: TestUser; // 同時リクエストの確認用 (A と同じ内容)

// 1 日分の食事: 自炊 2 (cook / quick) + 自炊でない 2 (buy / out) + 未完了 1
const DAY_MEALS: MealSeed[] = [
  { mode: 'cook', isCompleted: true },
  { mode: 'quick', isCompleted: true },
  { mode: 'buy', isCompleted: true },
  { mode: 'out', isCompleted: true },
  { mode: 'cook', isCompleted: false },
];

beforeAll(async () => {
  const { data: master, error } = await srAdmin.from('badges').select('code').in('code', RULE_BADGES);
  if (error) throw new Error(`badges マスタの取得に失敗: ${error.message}`);
  const missing = RULE_BADGES.filter((code) => !(master ?? []).some((b) => b.code === code));
  if (missing.length > 0) {
    throw new Error(`badges マスタに ${missing.join(', ')} がありません (supabase/baseline/prod_reference_data.sql を確認)`);
  }

  [userA, userB, userC, userD] = await Promise.all([
    createUser('a'),
    createUser('b'),
    createUser('c'),
    createUser('d'),
  ]);

  await seedMeals(userA.id, 3, DAY_MEALS);
  await seedMeals(userB.id, 1, [
    { mode: 'cook', isCompleted: true },
    { mode: 'cook', isCompleted: true },
    { mode: 'cook', isCompleted: true },
    { mode: 'cook', isCompleted: true },
    { mode: 'cook', isCompleted: true },
  ]);
  await seedMeals(userD.id, 3, DAY_MEALS);

  // dev サーバの初回コンパイル (ルート + middleware) で最初のテストがタイムアウトしないよう、先に 1 回呼んでおく
  await apiCall('GET', '/api/badges', null);
}, 180_000);

afterAll(async () => {
  // auth ユーザーを消すと user_daily_meals / planned_meals / user_badges / user_profiles は FK で連鎖削除される
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
  if (createdUserIds.length > 0) {
    const { data: leftBadges } = await srAdmin.from('user_badges').select('user_id').in('user_id', createdUserIds);
    const { data: leftDays } = await srAdmin.from('user_daily_meals').select('id').in('user_id', createdUserIds);
    expect(leftBadges ?? []).toEqual([]);
    expect(leftDays ?? []).toEqual([]);
  }
}, 60_000);

describe('#1215 GET /api/badges', () => {
  it('K-1: 未認証なら 401', async () => {
    const res = await apiCall('GET', '/api/badges', null);
    expect(res.status).toBe(401);
  });

  it('K-2: 食事の記録が無いユーザーは 200 で、統計は 0・新規獲得も 0 件 (保存もされない)', async () => {
    const res = await getBadges(userC.jwt);
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ completedMeals: 0, cookMeals: 0, streak: 0 });
    expect(res.body.newEarnedCount).toBe(0);
    expect(res.body.newEarnedBadgeCodes).toEqual([]);
    expect(await persistedBadgeCodes(userC.id)).toEqual([]);
  });

  it('K-3: 本人の完了済みの食事から数が数えられ (planned_meals.user_id を使わない)、条件を満たしたバッジが保存されて 1 回だけ新規獲得になる', async () => {
    const res = await getBadges(userA.jwt);
    expect(res.status).toBe(200);

    // 完了 4 食 × 3 日 = 12 食、うち自炊 (cook / quick) 2 食 × 3 日 = 6 食、3 日連続。未完了の食事は数えない
    expect(res.body.stats).toEqual({ completedMeals: 12, cookMeals: 6, streak: 3 });

    // first_bite (1 食以上) / photo_10 (10 食以上) / streak_3 (3 日連続)。streak_7 (7 日連続) は未達
    const expected = ['first_bite', 'photo_10', 'streak_3'];
    expect([...res.body.newEarnedBadgeCodes].sort()).toEqual(expected);
    expect(res.body.newEarnedCount).toBe(3);
    for (const code of expected) {
      const badge = byCode(res.body, code);
      expect(badge.earned).toBe(true);
      expect(badge.obtainedAt).toBeTruthy();
    }
    expect(byCode(res.body, 'streak_7')).toMatchObject({ earned: false, obtainedAt: null });

    // 実際に user_badges に保存されている (修正前はここが空だった)
    expect(await persistedBadgeCodes(userA.id)).toEqual(expected);
  });

  it('K-4: 2 回目以降は新規獲得 0 件。獲得済みのまま、獲得日時も変わらない (修正前は毎回「新規獲得」だった)', async () => {
    const first = await getBadges(userA.jwt);
    const second = await getBadges(userA.jwt);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(second.body.newEarnedCount).toBe(0);
    expect(second.body.newEarnedBadgeCodes).toEqual([]);
    for (const code of ['first_bite', 'photo_10', 'streak_3']) {
      const a = byCode(first.body, code);
      const b = byCode(second.body, code);
      expect(b.earned).toBe(true);
      expect(b.obtainedAt).toBe(a.obtainedAt);
    }
    expect(second.body.stats).toEqual({ completedMeals: 12, cookMeals: 6, streak: 3 });
    expect(await persistedBadgeCodes(userA.id)).toEqual(['first_bite', 'photo_10', 'streak_3']);
  });

  it('K-5: 他人の食事は数えない (B は 5 食 1 日だけ。A の 12 食は混ざらない)', async () => {
    const res = await getBadges(userB.jwt);
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ completedMeals: 5, cookMeals: 5, streak: 1 });
    // 5 食 (< 10)・1 日 (< 3) なので first_bite だけ
    expect(res.body.newEarnedBadgeCodes).toEqual(['first_bite']);
    expect(await persistedBadgeCodes(userB.id)).toEqual(['first_bite']);
  });

  it('K-6: 同時に 2 回呼ばれても、各バッジの新規獲得は全体で 1 回だけ。行も重複しない', async () => {
    const [r1, r2] = await Promise.all([getBadges(userD.jwt), getBadges(userD.jwt)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // どちらが先に保存したかは決まらないが、新規獲得として返るのは全体で 3 種 × 1 回
    const reported = [...r1.body.newEarnedBadgeCodes, ...r2.body.newEarnedBadgeCodes].sort();
    expect(reported).toEqual(['first_bite', 'photo_10', 'streak_3']);

    // どちらのレスポンスでも 3 種は獲得済みとして見える (先に保存された分を取りこぼさない)
    for (const res of [r1, r2]) {
      for (const code of ['first_bite', 'photo_10', 'streak_3']) {
        expect(byCode(res.body, code).earned).toBe(true);
      }
    }
    expect(await persistedBadgeCodes(userD.id)).toEqual(['first_bite', 'photo_10', 'streak_3']);
  });
});
