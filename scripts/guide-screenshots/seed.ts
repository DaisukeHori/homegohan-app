/**
 * 使い方ガイドの撮影 (#1852) のテスト用のデータを、ローカルの Supabase に入れる。
 *
 *   npx --yes tsx@4 scripts/guide-screenshots/seed.ts
 *
 * - 接続先は .env.local (bash scripts/supabase-local.sh env .env.local が書く、ローカルの Supabase)。
 *   URL がローカル (localhost / 127.0.0.1) でなければ何もせずに止める (本番に書かない)。
 * - 利用者は guide-users.ts の GUIDE_USERS。何度流しても同じ状態になるよう、既にいれば消して作り直す。
 * - 日付は今日 (日本時間) からの相対で作る。献立表は今日の週 (月曜始まり) が埋まるよう、前後 6 日ずつ入れる。
 * - データはすべて架空のもの (料理・体重などのテスト用の値)。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as dotenv from 'dotenv';
import { grantE2eAiConsent } from '../lib/e2e-ai-consent';
import { DEMO_TODAY_WEIGHT_KG, GUIDE_USERS, type GuideUserKey } from './guide-users';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
/** 書いてよい接続先のホスト (ローカルの Supabase だけ) */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 日本時間の UTC からのずれ (ms)。連続日数・献立表は日本時間の暦日で数える */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 献立を入れる範囲 (今日から前後の日数)。今日がどの曜日でも、今日の週 (月曜〜日曜) がすべて入る */
const MENU_DAYS_AROUND_TODAY = 6;
/**
 * この日 (今日からの日数) の食事は「完了」にしない。連続記録を 3 日 (今日・昨日・一昨日) で止め、
 * バッジの画面を開いたときに「三日坊主卒業」(streak_3) だけが新しく付くようにする (streak_7 は付かない)
 */
const STREAK_BREAK_DAY = -3;
/** 体重の記録を入れる日数 (グラフの既定の期間「1ヶ月」がちょうど埋まる) */
const WEIGHT_HISTORY_DAYS = 30;
/** 体重の記録の始めと終わり (kg)。終わりは昨日の記録。今日の分は体重計の読み取り (DEMO_TODAY_WEIGHT_KG) で入れる想定 */
const WEIGHT_START_KG = 64.8;
const WEIGHT_END_KG = 62.9;
/** 体重の日ごとの揺れ (kg)。一直線にならないよう、決まった並びで足す */
const WEIGHT_WOBBLE_KG = [0, 0.3, -0.1, 0.2, -0.2, 0.1, 0];
const BODY_FAT_START_PCT = 27.2;
const BODY_FAT_END_PCT = 25.4;
const WEIGHT_GOAL_KG = 60;
/** 体重・体脂肪率を丸める桁 (小数 1 桁) */
const ONE_DECIMAL = 10;

type MealType = 'breakfast' | 'lunch' | 'dinner';
type DishRole = 'main' | 'side' | 'soup' | 'rice';
interface Dish { name: string; role: DishRole; calories_kcal: number }
interface MealSeed { type: MealType; dishes: Dish[]; mode: 'cook' | 'quick'; cookingMinutes: number }

/** 1 日分の献立 (7 日で一回り)。値はテスト用の目安 */
const DAY_MENUS: MealSeed[][] = [
  [
    { type: 'breakfast', mode: 'quick', cookingMinutes: 10, dishes: [{ name: '納豆ごはん', role: 'main', calories_kcal: 330 }, { name: '豆腐とわかめの味噌汁', role: 'soup', calories_kcal: 60 }] },
    { type: 'lunch', mode: 'cook', cookingMinutes: 20, dishes: [{ name: '鶏むね肉の照り焼き', role: 'main', calories_kcal: 260 }, { name: 'ほうれん草のおひたし', role: 'side', calories_kcal: 30 }, { name: 'ごはん', role: 'rice', calories_kcal: 250 }] },
    { type: 'dinner', mode: 'cook', cookingMinutes: 30, dishes: [{ name: '鮭の塩焼き', role: 'main', calories_kcal: 200 }, { name: 'ひじきの煮物', role: 'side', calories_kcal: 70 }, { name: 'けんちん汁', role: 'soup', calories_kcal: 90 }, { name: 'ごはん', role: 'rice', calories_kcal: 250 }] },
  ],
  [
    { type: 'breakfast', mode: 'quick', cookingMinutes: 10, dishes: [{ name: 'ハムエッグトースト', role: 'main', calories_kcal: 380 }, { name: 'ヨーグルト', role: 'side', calories_kcal: 80 }] },
    { type: 'lunch', mode: 'quick', cookingMinutes: 15, dishes: [{ name: '具だくさんうどん', role: 'main', calories_kcal: 450 }, { name: '小松菜のごま和え', role: 'side', calories_kcal: 50 }] },
    { type: 'dinner', mode: 'cook', cookingMinutes: 30, dishes: [{ name: '豚肉の生姜焼き', role: 'main', calories_kcal: 320 }, { name: 'キャベツの千切り', role: 'side', calories_kcal: 20 }, { name: 'なめこの味噌汁', role: 'soup', calories_kcal: 40 }, { name: 'ごはん', role: 'rice', calories_kcal: 250 }] },
  ],
  [
    { type: 'breakfast', mode: 'quick', cookingMinutes: 10, dishes: [{ name: 'おにぎり (梅・昆布)', role: 'main', calories_kcal: 340 }, { name: 'ゆで卵', role: 'side', calories_kcal: 80 }] },
    { type: 'lunch', mode: 'cook', cookingMinutes: 20, dishes: [{ name: '親子丼', role: 'main', calories_kcal: 560 }, { name: 'きゅうりの浅漬け', role: 'side', calories_kcal: 15 }] },
    { type: 'dinner', mode: 'cook', cookingMinutes: 35, dishes: [{ name: 'さばの味噌煮', role: 'main', calories_kcal: 280 }, { name: 'かぼちゃの煮物', role: 'side', calories_kcal: 90 }, { name: '大根と油揚げの味噌汁', role: 'soup', calories_kcal: 60 }, { name: 'ごはん', role: 'rice', calories_kcal: 250 }] },
  ],
  [
    { type: 'breakfast', mode: 'quick', cookingMinutes: 5, dishes: [{ name: 'オートミールのフルーツのせ', role: 'main', calories_kcal: 290 }, { name: '牛乳', role: 'side', calories_kcal: 130 }] },
    { type: 'lunch', mode: 'cook', cookingMinutes: 20, dishes: [{ name: 'ツナとトマトのパスタ', role: 'main', calories_kcal: 520 }, { name: 'グリーンサラダ', role: 'side', calories_kcal: 40 }] },
    { type: 'dinner', mode: 'cook', cookingMinutes: 30, dishes: [{ name: '肉じゃが', role: 'main', calories_kcal: 300 }, { name: 'ブロッコリーの胡麻和え', role: 'side', calories_kcal: 60 }, { name: '豆腐の味噌汁', role: 'soup', calories_kcal: 60 }, { name: 'ごはん', role: 'rice', calories_kcal: 250 }] },
  ],
  [
    { type: 'breakfast', mode: 'quick', cookingMinutes: 10, dishes: [{ name: 'ツナマヨトースト', role: 'main', calories_kcal: 350 }, { name: 'バナナ', role: 'side', calories_kcal: 90 }] },
    { type: 'lunch', mode: 'cook', cookingMinutes: 25, dishes: [{ name: '野菜たっぷり焼きそば', role: 'main', calories_kcal: 530 }, { name: 'わかめスープ', role: 'soup', calories_kcal: 20 }] },
    { type: 'dinner', mode: 'cook', cookingMinutes: 30, dishes: [{ name: '鶏の唐揚げ', role: 'main', calories_kcal: 380 }, { name: 'トマトとレタスのサラダ', role: 'side', calories_kcal: 40 }, { name: 'じゃがいもの味噌汁', role: 'soup', calories_kcal: 70 }, { name: 'ごはん', role: 'rice', calories_kcal: 250 }] },
  ],
  [
    { type: 'breakfast', mode: 'quick', cookingMinutes: 10, dishes: [{ name: '卵かけごはん', role: 'main', calories_kcal: 330 }, { name: 'しじみの味噌汁', role: 'soup', calories_kcal: 40 }] },
    { type: 'lunch', mode: 'cook', cookingMinutes: 25, dishes: [{ name: 'チキンカレー', role: 'main', calories_kcal: 620 }, { name: 'コールスロー', role: 'side', calories_kcal: 80 }] },
    { type: 'dinner', mode: 'cook', cookingMinutes: 40, dishes: [{ name: '寄せ鍋', role: 'main', calories_kcal: 350 }, { name: 'ほうれん草の胡麻和え', role: 'side', calories_kcal: 50 }, { name: 'ごはん', role: 'rice', calories_kcal: 250 }] },
  ],
  [
    { type: 'breakfast', mode: 'quick', cookingMinutes: 10, dishes: [{ name: 'フレンチトースト', role: 'main', calories_kcal: 360 }, { name: 'フルーツヨーグルト', role: 'side', calories_kcal: 110 }] },
    { type: 'lunch', mode: 'quick', cookingMinutes: 15, dishes: [{ name: '冷やし中華', role: 'main', calories_kcal: 480 }, { name: '中華スープ', role: 'soup', calories_kcal: 30 }] },
    { type: 'dinner', mode: 'cook', cookingMinutes: 30, dishes: [{ name: 'ぶりの照り焼き', role: 'main', calories_kcal: 290 }, { name: '切り干し大根の煮物', role: 'side', calories_kcal: 70 }, { name: '具だくさん豚汁', role: 'soup', calories_kcal: 120 }, { name: 'ごはん', role: 'rice', calories_kcal: 250 }] },
  ],
];

/** 前もって付けておくバッジ (コード・何日前)。ここに無い streak_3 が、バッジの画面を開いたときに新しく付く */
const PRE_EARNED_BADGES: Array<{ code: string; daysAgo: number }> = [
  { code: 'first_bite', daysAgo: 21 },
  { code: 'planner', daysAgo: 14 },
  { code: 'photo_10', daysAgo: 9 },
  { code: 'breakfast_champion', daysAgo: 6 },
];
/** レアバッジ (ランキングの 1 位) を取った期間の記録。バッジの詳細に「獲得した期間」として出る */
const RARE_BADGE_CODE = 'breakfast_champion';
/** その期間の始まり (今日から何日前の週の月曜日か) */
const RARE_BADGE_WEEKS_AGO = 1;
const DAYS_PER_WEEK = 7;

/** 献立表に空欄がある利用者の、入れておく食事 (今日からの日数と区分) */
const PLANNER_MEALS: Array<{ dayOffset: number; mealIndex: number; menuIndex: number; completed: boolean }> = [
  { dayOffset: 0, mealIndex: 0, menuIndex: 0, completed: true },
  { dayOffset: 0, mealIndex: 1, menuIndex: 2, completed: false },
  { dayOffset: 1, mealIndex: 2, menuIndex: 3, completed: false },
];

function requireLocalEnv(): { url: string; serviceRole: string } {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('.env.local に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無い');
  const host = new URL(SUPABASE_URL).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`ローカルの Supabase ではない接続先には書かない: ${host}`);
  return { url: SUPABASE_URL, serviceRole: SERVICE_ROLE };
}

/** 日本時間の今日から offset 日の日付 (YYYY-MM-DD) */
function jstDate(offset: number): string {
  return new Date(Date.now() + JST_OFFSET_MS + offset * MS_PER_DAY).toISOString().slice(0, 10);
}

/** offset 日前の時刻 (ISO) */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

/** 日本時間の今日の週の月曜日から weeksAgo 週前の月曜日 (YYYY-MM-DD) */
function jstMondayWeeksAgo(weeksAgo: number): string {
  const today = new Date(Date.now() + JST_OFFSET_MS);
  const sinceMonday = (today.getUTCDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;
  return jstDate(-sinceMonday - weeksAgo * DAYS_PER_WEEK);
}

function round1(value: number): number {
  return Math.round(value * ONE_DECIMAL) / ONE_DECIMAL;
}

function must<T>(label: string, result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

/** 利用者を作り直す (いれば消す。消すと profiles・食事・記録などは FK で一緒に消える) */
async function recreateUser(admin: SupabaseClient, key: GuideUserKey): Promise<string> {
  const { email } = GUIDE_USERS[key];
  const list = must('listUsers', await admin.auth.admin.listUsers({ perPage: 1000 }));
  const existing = list.users.find((u) => u.email === email);
  if (existing) must(`deleteUser ${email}`, await admin.auth.admin.deleteUser(existing.id));
  const created = must(
    `createUser ${email}`,
    await admin.auth.admin.createUser({ email, password: `${randomBytes(18).toString('base64url')}Aa1!`, email_confirm: true }),
  );
  if (!created.user) throw new Error(`createUser ${email}: user が無い`);
  return created.user.id;
}

async function completeProfile(admin: SupabaseClient, userId: string, nickname: string, weightKg: number) {
  must('user_profiles', await admin.from('user_profiles').upsert({
    id: userId,
    nickname,
    onboarding_completed_at: daysAgoIso(30),
    handson_tour_skipped_at: daysAgoIso(30),
    nutrition_goal: 'lose_weight',
    exercise_frequency: 2,
    exercise_duration_per_session: 30,
    gender: 'female',
    age: 32,
    age_group: '30s',
    height: 158,
    weight: weightKg,
    target_weight: WEIGHT_GOAL_KG,
  }, { onConflict: 'id' }));
  must('nutrition_targets', await admin.from('nutrition_targets').upsert({
    user_id: userId,
    daily_calories: 1700,
    protein_g: 65,
    fat_g: 50,
    carbs_g: 230,
    auto_calculate: true,
  }, { onConflict: 'user_id' }));
  await grantE2eAiConsent(admin, userId);
}

function plannedMealRow(dailyMealId: string, meal: MealSeed, displayOrder: number, completed: boolean, completedAt: string | null) {
  const calories = meal.dishes.reduce((sum, dish) => sum + dish.calories_kcal, 0);
  const main = meal.dishes.find((dish) => dish.role === 'main') ?? meal.dishes[0];
  return {
    daily_meal_id: dailyMealId,
    meal_type: meal.type,
    dish_name: main.name,
    dishes: meal.dishes,
    is_simple: false,
    mode: meal.mode,
    calories_kcal: calories,
    cooking_time_minutes: meal.cookingMinutes,
    display_order: displayOrder,
    is_completed: completed,
    completed_at: completedAt,
  };
}

async function insertDay(admin: SupabaseClient, userId: string, offset: number): Promise<string> {
  const row = must(`user_daily_meals ${offset}`, await admin
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: jstDate(offset) })
    .select('id')
    .single());
  return (row as { id: string }).id;
}

async function seedDemo(admin: SupabaseClient) {
  const userId = await recreateUser(admin, 'demo');
  await completeProfile(admin, userId, GUIDE_USERS.demo.nickname, WEIGHT_END_KG);

  // 献立 (今日の前後 6 日)。今日までの食事は完了 (STREAK_BREAK_DAY の日だけ未完了)
  for (let offset = -MENU_DAYS_AROUND_TODAY; offset <= MENU_DAYS_AROUND_TODAY; offset++) {
    const dailyId = await insertDay(admin, userId, offset);
    const menu = DAY_MENUS[(offset + MENU_DAYS_AROUND_TODAY) % DAY_MENUS.length];
    const completed = offset <= 0 && offset !== STREAK_BREAK_DAY;
    const rows = menu.map((meal, i) => plannedMealRow(dailyId, meal, i, completed, completed ? daysAgoIso(-offset) : null));
    must(`planned_meals ${offset}`, await admin.from('planned_meals').insert(rows));
  }

  // 体重の記録 (昨日までの 30 日)
  const records = Array.from({ length: WEIGHT_HISTORY_DAYS }, (_, i) => {
    const progress = i / (WEIGHT_HISTORY_DAYS - 1);
    const wobble = WEIGHT_WOBBLE_KG[i % WEIGHT_WOBBLE_KG.length];
    return {
      user_id: userId,
      record_date: jstDate(i - WEIGHT_HISTORY_DAYS),
      weight: round1(WEIGHT_START_KG + (WEIGHT_END_KG - WEIGHT_START_KG) * progress + (i === WEIGHT_HISTORY_DAYS - 1 ? 0 : wobble)),
      body_fat_percentage: round1(BODY_FAT_START_PCT + (BODY_FAT_END_PCT - BODY_FAT_START_PCT) * progress),
    };
  });
  must('health_records', await admin.from('health_records').insert(records));
  must('health_goals', await admin.from('health_goals').insert({
    user_id: userId,
    goal_type: 'weight',
    target_value: WEIGHT_GOAL_KG,
    target_unit: 'kg',
    start_value: WEIGHT_START_KG,
    start_date: jstDate(-WEIGHT_HISTORY_DAYS),
    current_value: WEIGHT_END_KG,
    status: 'active',
  }));

  // バッジ (前もって付けておくもの + レアバッジの期間)
  const codes = PRE_EARNED_BADGES.map((badge) => badge.code);
  const badges = must('badges', await admin.from('badges').select('id, code').in('code', codes)) as Array<{ id: string; code: string }>;
  const idOf = (code: string) => {
    const found = badges.find((badge) => badge.code === code);
    if (!found) throw new Error(`badges に ${code} が無い`);
    return found.id;
  };
  must('user_badges', await admin.from('user_badges').insert(
    PRE_EARNED_BADGES.map((badge) => ({ user_id: userId, badge_id: idOf(badge.code), obtained_at: daysAgoIso(badge.daysAgo) })),
  ));
  must('user_badge_period_awards', await admin.from('user_badge_period_awards').insert({
    user_id: userId,
    badge_id: idOf(RARE_BADGE_CODE),
    period_type: 'weekly',
    period_start: jstMondayWeeksAgo(RARE_BADGE_WEEKS_AGO),
    message: '1 週間、毎朝の朝食を欠かさず記録しました',
    awarded_at: daysAgoIso(PRE_EARNED_BADGES.find((badge) => badge.code === RARE_BADGE_CODE)?.daysAgo ?? 0),
  }));
  console.log('OK demo');
}

async function seedPlanner(admin: SupabaseClient) {
  const userId = await recreateUser(admin, 'planner');
  await completeProfile(admin, userId, GUIDE_USERS.planner.nickname, DEMO_TODAY_WEIGHT_KG);
  const dailyIds = new Map<number, string>();
  for (const meal of PLANNER_MEALS) {
    let dailyId = dailyIds.get(meal.dayOffset);
    if (!dailyId) {
      dailyId = await insertDay(admin, userId, meal.dayOffset);
      dailyIds.set(meal.dayOffset, dailyId);
    }
    const seed = DAY_MENUS[meal.menuIndex][meal.mealIndex];
    must('planned_meals planner', await admin.from('planned_meals').insert(
      plannedMealRow(dailyId, seed, meal.mealIndex, meal.completed, meal.completed ? daysAgoIso(0) : null),
    ));
  }
  console.log('OK planner');
}

async function seedOnboarding(admin: SupabaseClient) {
  const userId = await recreateUser(admin, 'onboarding');
  // 初期設定をまだ始めていない (user_profiles を作らない)。AI の同意だけ記録する
  await grantE2eAiConsent(admin, userId);
  console.log('OK onboarding');
}

(async () => {
  const { url, serviceRole } = requireLocalEnv();
  const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  await seedDemo(admin);
  await seedPlanner(admin);
  await seedOnboarding(admin);
})().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
