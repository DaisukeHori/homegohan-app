/**
 * #1505 料理画像を待ったままの料理にジョブを積み直す道具 (scripts/lib/meal-image-backfill.ts) を実 DB で確かめる
 *
 * 確認すること (この利用者の献立だけに絞って動かす。処理 (process-meal-image-jobs) は起こさない):
 *   B-1: dry-run は数えるだけで、meal_image_jobs にも献立にも書かない。jsonb の包含 (dishes @> [{"image_status": ...}]) で
 *        待ち・更新待ちの料理を含む献立を読み、対象の料理と対象外の理由を数える
 *   B-2: --apply は対象の料理だけを積み (部分索引に対して 42P10 にならない)、日付の新しい献立から maxMeals 件までにする
 *   B-3: もう一度 --apply しても、待ちのジョブと同じ料理は重複として数え、行を増やさない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/meal-image-backfill.test.ts
 * 本番には接続しない。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE, runMealImageBackfill } from '../../../scripts/lib/meal-image-backfill';
import { buildMealImageIdempotencyKey, type MealImageDish } from '../../../lib/meal-image';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const srAdmin: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

const TS = Date.now();
const PASSWORD = 'TestPass!2026-mib';
const NEWER_DAY = '2026-10-12';
const OLDER_DAY = '2026-10-05';

let userId: string;
let newerMealId: string;
let olderMealId: string;
let readyMealId: string;

function dish(name: string, overrides: Partial<MealImageDish>): MealImageDish {
  return { name, role: 'main', image_url: null, image_source: 'generated_ai', image_prompt: `prompt ${name}`, image_model: 'test-model', ...overrides };
}

async function insertMeal(dayId: string, mealType: string, dishes: MealImageDish[]): Promise<string> {
  const { data, error } = await srAdmin
    .from('planned_meals')
    .insert({ daily_meal_id: dayId, meal_type: mealType, dish_name: `mib-${mealType}-${TS}`, dishes })
    .select('id')
    .single();
  if (error || !data) throw new Error(`planned_meals: ${error?.message}`);
  return data.id as string;
}

async function insertDay(day: string): Promise<string> {
  const { data, error } = await srAdmin.from('user_daily_meals').insert({ user_id: userId, day_date: day, is_cheat_day: false }).select('id').single();
  if (error || !data) throw new Error(`user_daily_meals: ${error?.message}`);
  return data.id as string;
}

async function jobRows() {
  const { data, error } = await srAdmin
    .from('meal_image_jobs')
    .select('planned_meal_id, dish_index, status, idempotency_key, trigger_source')
    .eq('user_id', userId)
    .order('dish_index', { ascending: true });
  if (error) throw new Error(`meal_image_jobs select: ${error.message}`);
  return data ?? [];
}

async function dishesOf(mealId: string): Promise<MealImageDish[]> {
  const { data, error } = await srAdmin.from('planned_meals').select('dishes').eq('id', mealId).single();
  if (error) throw new Error(`planned_meals select: ${error.message}`);
  return (data?.dishes ?? []) as MealImageDish[];
}

const options = () => ({ maxMeals: 1, userId, trigger: false, intervalMs: 0, sleep: async () => undefined });

beforeAll(async () => {
  const { data, error } = await srAdmin.auth.admin.createUser({
    email: `mib-1505-${TS}@homegohan.test`,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: pErr } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: 'mib', age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (pErr) throw new Error(`user_profiles: ${pErr.message}`);

  const newerDay = await insertDay(NEWER_DAY);
  const olderDay = await insertDay(OLDER_DAY);
  newerMealId = await insertMeal(newerDay, 'dinner', [
    dish('カレー', { image_status: 'pending', image_subject_hash: `h-curry-${TS}` }),
    dish('サラダ', { image_status: 'stale', image_subject_hash: `h-salad-${TS}` }),
    dish('印なし', { image_status: 'pending' }),
  ]);
  olderMealId = await insertMeal(olderDay, 'lunch', [dish('うどん', { image_status: 'pending', image_subject_hash: `h-udon-${TS}` })]);
  readyMealId = await insertMeal(olderDay, 'breakfast', [
    dish('パン', { image_status: 'ready', image_url: 'https://example.com/bread.png', image_subject_hash: `h-bread-${TS}` }),
  ]);
});

afterAll(async () => {
  if (!userId) return;
  await srAdmin.from('meal_image_jobs').delete().eq('user_id', userId);
  await srAdmin.from('user_daily_meals').delete().eq('user_id', userId);
  await srAdmin.auth.admin.deleteUser(userId);
});

describe('料理画像を待ったままの料理にジョブを積み直す (#1505)', () => {
  it('B-1: dry-run は数えるだけで、何も書かない', async () => {
    const before = await dishesOf(newerMealId);
    const report = await runMealImageBackfill(srAdmin, { ...options(), apply: false });

    expect(report).toMatchObject({
      apply: false,
      scannedMeals: 2,
      candidateMeals: 2,
      candidateDishes: 3,
      processedMeals: 0,
      enqueue: { inserted: 0, duplicates: 0, failed: 0 },
      triggeredMeals: 0,
    });
    expect(report.skipped.no_subject_hash).toBe(1);
    expect(await jobRows()).toEqual([]);
    expect(await dishesOf(newerMealId)).toEqual(before);
    // 画像ができている献立は読まない
    expect(readyMealId).toBeTruthy();
  });

  it('B-2: --apply は日付の新しい献立から maxMeals 件まで、対象の料理だけを積む (42P10 にならない)', async () => {
    const report = await runMealImageBackfill(srAdmin, { ...options(), apply: true });

    expect(report).toMatchObject({ apply: true, processedMeals: 1, enqueue: { inserted: 2, duplicates: 0, failed: 0 }, triggeredMeals: 0 });
    const rows = await jobRows();
    expect(rows.map((row) => [row.planned_meal_id, row.dish_index, row.status, row.trigger_source])).toEqual([
      [newerMealId, 0, 'pending', MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE],
      [newerMealId, 1, 'pending', MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE],
    ]);
    expect(rows[0].idempotency_key).toBe(await buildMealImageIdempotencyKey({ plannedMealId: newerMealId, dishIndex: 0, subjectHash: `h-curry-${TS}` }));
    // 古い献立はまだ積まない (maxMeals 1)
    expect(rows.some((row) => row.planned_meal_id === olderMealId)).toBe(false);
  });

  it('B-3: もう一度 --apply しても、待ちのジョブと同じ料理は重複として数え、行を増やさない', async () => {
    const report = await runMealImageBackfill(srAdmin, { ...options(), apply: true });

    expect(report.enqueue).toEqual({ inserted: 0, duplicates: 2, failed: 0 });
    expect(await jobRows()).toHaveLength(2);
  });
});
