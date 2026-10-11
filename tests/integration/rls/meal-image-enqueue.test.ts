/**
 * #1487 料理画像のジョブの積み方 (lib/meal-image-jobs.ts の enqueueMealImageJobs) を実 DB で確かめる
 *
 * meal_image_jobs の冪等キーの一意な索引 (meal_image_jobs_idempotency_pending_idx) は、待ち・処理中
 * (status が pending / processing) の行だけが対象の部分索引。PostgREST の upsert (on_conflict=idempotency_key) が作る
 * ON CONFLICT (idempotency_key) は部分索引を推論できず、必ず失敗する (42P10)。以前の enqueueMealImageJobs はこの upsert の
 * エラーを見ていなかったので、料理画像のジョブが 1 行も積まれず、料理が「料理画像を生成中です」のまま残っていた。
 *
 * 確認すること:
 *   E-1: (前提) upsert (onConflict: 'idempotency_key', ignoreDuplicates) は 42P10 で失敗し、行を積まない
 *   E-2: enqueueMealImageJobs は行ごとの insert で積める (inserted 1)
 *   E-3: 同じ料理のジョブが待ちのあいだに積むと、一意制約の違反 (23505) を重複として数え、行を増やさない (inserted 0 / duplicates 1)
 *   E-4: そのジョブが終わった (失敗・取り消し・完了) あとは、同じ料理をもう一度積める (保存し直しで積み直す。#1487)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/meal-image-enqueue.test.ts
 * 本番には接続しない。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { enqueueMealImageJobs } from '../../../lib/meal-image-jobs';
import { buildMealImageIdempotencyKey, type MealImageJobSeed } from '../../../lib/meal-image';

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
const PASSWORD = 'TestPass!2026-mij';
const DAY = '2026-10-11';
/** ON CONFLICT の指定に合う一意な索引・制約が無い (invalid_column_reference) */
const NO_MATCHING_CONFLICT_TARGET = '42P10';

let userId: string;
let plannedMealId: string;

const SEED: MealImageJobSeed = {
  dishIndex: 0,
  dishName: 'カレー',
  subjectHash: `hash-${TS}`,
  prompt: 'Japanese home-cooked main dish: カレー.',
  model: 'test-model',
  triggerSource: 'integration:meal-image-enqueue',
  referenceImageUrls: [],
};

async function jobRows() {
  const { data, error } = await srAdmin
    .from('meal_image_jobs')
    .select('id, status, idempotency_key')
    .eq('planned_meal_id', plannedMealId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`meal_image_jobs select: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  const { data, error } = await srAdmin.auth.admin.createUser({
    email: `mij-1487-${TS}@homegohan.test`,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: pErr } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: 'mij', age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (pErr) throw new Error(`user_profiles: ${pErr.message}`);
  const { data: day, error: dErr } = await srAdmin
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: DAY, is_cheat_day: false })
    .select('id')
    .single();
  if (dErr || !day) throw new Error(`user_daily_meals: ${dErr?.message}`);
  const { data: meal, error: mErr } = await srAdmin
    .from('planned_meals')
    .insert({ daily_meal_id: day.id, meal_type: 'dinner', dish_name: `mij-${TS}` })
    .select('id')
    .single();
  if (mErr || !meal) throw new Error(`planned_meals: ${mErr?.message}`);
  plannedMealId = meal.id as string;
});

afterAll(async () => {
  if (!userId) return;
  await srAdmin.from('meal_image_jobs').delete().eq('user_id', userId);
  await srAdmin.from('user_daily_meals').delete().eq('user_id', userId);
  await srAdmin.auth.admin.deleteUser(userId);
});

describe('料理画像のジョブの積み方 (#1487)', () => {
  it('E-1: (前提) 冪等キーの upsert (ON CONFLICT) は部分索引を推論できず失敗し、行を積まない', async () => {
    const { error } = await srAdmin.from('meal_image_jobs').upsert(
      {
        planned_meal_id: plannedMealId,
        user_id: userId,
        dish_index: SEED.dishIndex,
        job_kind: 'dish',
        subject_hash: SEED.subjectHash,
        idempotency_key: `upsert-${TS}`,
        prompt: SEED.prompt,
        model: SEED.model,
        status: 'pending',
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    );
    expect(error?.code).toBe(NO_MATCHING_CONFLICT_TARGET);
    expect(await jobRows()).toEqual([]);
  });

  it('E-2: 行ごとの insert で積める', async () => {
    const result = await enqueueMealImageJobs({
      supabase: srAdmin,
      plannedMealId,
      userId,
      triggerSource: SEED.triggerSource,
      jobSeeds: [SEED],
    });
    expect(result).toEqual({ inserted: 1, duplicates: 0, failed: 0 });
    const rows = await jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      idempotency_key: await buildMealImageIdempotencyKey({ plannedMealId, dishIndex: SEED.dishIndex, subjectHash: SEED.subjectHash }),
    });
  });

  it('E-3: 同じ料理のジョブが待ちのあいだは、重複として数えて行を増やさない', async () => {
    const result = await enqueueMealImageJobs({
      supabase: srAdmin,
      plannedMealId,
      userId,
      triggerSource: SEED.triggerSource,
      jobSeeds: [SEED],
    });
    expect(result).toEqual({ inserted: 0, duplicates: 1, failed: 0 });
    expect(await jobRows()).toHaveLength(1);
  });

  it('E-4: ジョブが終わった (失敗) あとは、同じ料理をもう一度積める', async () => {
    const [first] = await jobRows();
    const { error } = await srAdmin.from('meal_image_jobs').update({ status: 'failed', last_error: 'integration' }).eq('id', first.id);
    expect(error).toBeNull();

    const result = await enqueueMealImageJobs({
      supabase: srAdmin,
      plannedMealId,
      userId,
      triggerSource: SEED.triggerSource,
      jobSeeds: [SEED],
    });
    expect(result).toEqual({ inserted: 1, duplicates: 0, failed: 0 });
    const rows = await jobRows();
    expect(rows.map((row) => row.status)).toEqual(['failed', 'pending']);
  });
});
