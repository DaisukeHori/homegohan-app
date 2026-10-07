/**
 * #1205 planned_meals の栄養素 4 列 (calories_kcal / protein_g / fat_g / carbs_g) と meal_type の CHECK 制約の回帰テスト
 *
 * 食事の登録・更新 API は、これらの列を型・範囲の確認なしに planned_meals へ書いていた。
 * DB 側にも CHECK 制約が無く (2026-10-06 の本番スナップショットで確認。#221 の meal_type の CHECK も本番には無い)、
 * 負のカロリーや桁外れの数値、NaN、想定外の meal_type がそのまま残っていた。
 * アプリ層 (src/lib/planned-meal-validation.ts) の確認を通らない書き込み経路
 * (モバイルが Supabase クライアントで直接 INSERT する apps/mobile/app/meals/new.tsx、
 * service_role で書く Edge Function の献立生成) もあるため、DB 側でも止める。
 *
 * 修正 (20261007160500_planned_meals_value_checks.sql): 次の CHECK 制約を NOT VALID で追加する。
 *   planned_meals_calories_kcal_range  calories_kcal を 0〜20000
 *   planned_meals_protein_g_range      protein_g を 0〜2000
 *   planned_meals_fat_g_range          fat_g を 0〜2000
 *   planned_meals_carbs_g_range        carbs_g を 0〜2000
 *   planned_meals_meal_type_check      meal_type を breakfast / lunch / dinner / snack / midnight_snack の 5 値
 * 上限はアプリ層 (calories 5000 / protein 500 / fat 300 / carbs 800) より緩い。
 * Edge Function の生成結果や過去の正当な値を、DB 側の確認で弾かないための余裕。
 * NOT VALID のため、既存の行は検査されない (新しく書く行・更新する行だけが対象)。
 *
 * このテストは、修正前 (CHECK 制約が無いとき) は「拒否されるはずの書き込みが通る」ために失敗し、
 * migration を当てた後は全件成功する。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/planned-meals-value-checks.test.ts
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

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
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
let userId = '';
let userJwt = '';
let dailyMealId = '';
let seq = 0;

/** 行を区別するための一意な料理名 (後始末は user_daily_meals の削除で連鎖する) */
function dishName(label: string): string {
  seq += 1;
  return `value-checks-${label}-${seq}`;
}

type PlannedMealInsert = Record<string, unknown>;

/** 本人のセッション (モバイルが Supabase クライアントで直接 INSERT するのと同じ経路) で planned_meals へ INSERT する */
async function insertAsUser(values: PlannedMealInsert, label: string) {
  return asUser(userJwt)
    .from('planned_meals')
    .insert({ daily_meal_id: dailyMealId, meal_type: 'lunch', dish_name: dishName(label), ...values })
    .select('id, meal_type, calories_kcal, protein_g, fat_g, carbs_g')
    .single();
}

/** service_role (Edge Function が使う経路) で planned_meals へ INSERT する */
async function insertAsService(values: PlannedMealInsert, label: string) {
  return srAdmin
    .from('planned_meals')
    .insert({ daily_meal_id: dailyMealId, meal_type: 'lunch', dish_name: dishName(label), ...values })
    .select('id, meal_type, calories_kcal, protein_g, fat_g, carbs_g')
    .single();
}

/** CHECK 制約違反 (SQLSTATE 23514) で拒否され、違反した制約の名前がエラーに含まれること */
function expectCheckViolation(res: { error: { code?: string; message: string } | null }, constraint: string) {
  expect(res.error, `${constraint} で拒否されるはずが、書き込みが通った`).not.toBeNull();
  expect(res.error!.code).toBe('23514');
  expect(res.error!.message).toContain(constraint);
}

async function readRow(id: string) {
  const { data, error } = await srAdmin
    .from('planned_meals')
    .select('id, meal_type, calories_kcal, protein_g, fat_g, carbs_g')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`planned_meals ${id}: ${error?.message}`);
  return data as Record<string, unknown>;
}

beforeAll(async () => {
  const email = `rls-meal-checks-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: 'meal-checks', age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`user_profiles: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  userJwt = signIn.data.session.access_token;

  const { data: day, error: dayError } = await asUser(userJwt)
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: '2026-10-07' })
    .select('id')
    .single();
  if (dayError || !day) throw new Error(`user_daily_meals: ${dayError?.message}`);
  dailyMealId = (day as { id: string }).id;
}, 60_000);

afterAll(async () => {
  // planned_meals は user_daily_meals の削除で連鎖して消える
  if (dailyMealId) await srAdmin.from('user_daily_meals').delete().eq('id', dailyMealId);
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
}, 60_000);

describe('planned_meals: 栄養素 4 列の範囲 (#1205)', () => {
  const numericColumns = [
    { column: 'calories_kcal', constraint: 'planned_meals_calories_kcal_range', max: 20000 },
    { column: 'protein_g', constraint: 'planned_meals_protein_g_range', max: 2000 },
    { column: 'fat_g', constraint: 'planned_meals_fat_g_range', max: 2000 },
    { column: 'carbs_g', constraint: 'planned_meals_carbs_g_range', max: 2000 },
  ] as const;

  for (const { column, constraint, max } of numericColumns) {
    describe(column, () => {
      it(`★負の値 (-1) の INSERT は 23514 (${constraint}) で拒否される`, async () => {
        const res = await insertAsUser({ [column]: -1 }, `${column}-negative`);
        expectCheckViolation(res, constraint);
      });

      it(`★上限 (${max}) を超える値の INSERT は 23514 (${constraint}) で拒否される`, async () => {
        const res = await insertAsUser({ [column]: max + 1 }, `${column}-over`);
        expectCheckViolation(res, constraint);
      });

      it('★桁外れの値 (1e9) の INSERT は拒否される', async () => {
        const res = await insertAsUser({ [column]: 1_000_000_000 }, `${column}-huge`);
        expectCheckViolation(res, constraint);
      });

      it('0・上限ちょうど・NULL は通る (境界値)', async () => {
        const zero = await insertAsUser({ [column]: 0 }, `${column}-zero`);
        expect(zero.error).toBeNull();
        expect(zero.data).toMatchObject({ [column]: 0 });

        const upper = await insertAsUser({ [column]: max }, `${column}-max`);
        expect(upper.error).toBeNull();
        expect(upper.data).toMatchObject({ [column]: max });

        const nothing = await insertAsUser({ [column]: null }, `${column}-null`);
        expect(nothing.error).toBeNull();
        expect((nothing.data as Record<string, unknown>)[column]).toBeNull();
      });

      it('★既存の行の更新で範囲外の値に書き換えても拒否され、元の値が残る', async () => {
        const created = await insertAsUser({ [column]: 100 }, `${column}-update`);
        expect(created.error).toBeNull();
        const id = (created.data as { id: string }).id;

        const negative = await asUser(userJwt).from('planned_meals').update({ [column]: -5 }).eq('id', id);
        expectCheckViolation(negative, constraint);
        const over = await asUser(userJwt)
          .from('planned_meals')
          .update({ [column]: max + 1 })
          .eq('id', id);
        expectCheckViolation(over, constraint);
        expect(await readRow(id)).toMatchObject({ [column]: 100 });

        // 範囲内への更新は通る
        const ok = await asUser(userJwt).from('planned_meals').update({ [column]: 150 }).eq('id', id);
        expect(ok.error).toBeNull();
        expect(await readRow(id)).toMatchObject({ [column]: 150 });
      });
    });
  }

  for (const column of ['protein_g', 'fat_g', 'carbs_g'] as const) {
    const constraint = `planned_meals_${column}_range`;
    for (const text of ['NaN', 'Infinity', '-Infinity']) {
      it(`★${column} に数値型の特殊値 "${text}" (文字列で送る) を入れた INSERT は拒否される`, async () => {
        // numeric 型は NaN / Infinity を値として受け付ける。JSON では文字列で送ると入ってしまう。
        // NaN は numeric の比較で「最大」として扱われるため、上限の確認で弾かれる。
        const res = await insertAsUser({ [column]: text }, `${column}-${text}`);
        expectCheckViolation(res, constraint);
      });
    }
  }

  it('小数の栄養素 (protein_g 20.5 / fat_g 0.25 / carbs_g 99.99) は通る', async () => {
    const res = await insertAsUser({ calories_kcal: 523, protein_g: 20.5, fat_g: 0.25, carbs_g: 99.99 }, 'decimal');
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ calories_kcal: 523, protein_g: 20.5, fat_g: 0.25, carbs_g: 99.99 });
  });

  it('4 列とも NULL の行 (栄養素が未入力の献立) は通る', async () => {
    const res = await insertAsUser({}, 'no-nutrients');
    expect(res.error).toBeNull();
  });

  it('★service_role (Edge Function が使う経路) の INSERT も制約の対象', async () => {
    const res = await insertAsService({ calories_kcal: -1 }, 'service-negative');
    expectCheckViolation(res, 'planned_meals_calories_kcal_range');

    const ok = await insertAsService({ calories_kcal: 650, protein_g: 31.2, fat_g: 20, carbs_g: 80.5 }, 'service-ok');
    expect(ok.error).toBeNull();
  });

  it('制約の対象は 4 列だけで、ほかの栄養素の列 (sodium_g など) は従来どおり', async () => {
    const res = await insertAsUser({ calories_kcal: 400, sodium_g: 12.5, fiber_g: 3 }, 'other-columns');
    expect(res.error).toBeNull();
  });
});

describe('planned_meals: meal_type は 5 値だけ (#1205)', () => {
  const allowed = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'] as const;

  for (const mealType of allowed) {
    it(`${mealType} は通る`, async () => {
      const res = await insertAsUser({ meal_type: mealType }, `meal-type-${mealType}`);
      expect(res.error).toBeNull();
      expect(res.data).toMatchObject({ meal_type: mealType });
    });
  }

  it('★midnight_snack (夜食) は拒否されない。#221 の 4 値 CHECK をそのまま足すと夜食が弾かれるため、5 値にしている', async () => {
    const res = await insertAsUser({ meal_type: 'midnight_snack' }, 'midnight');
    expect(res.error).toBeNull();
  });

  for (const bad of ['brunch', '', 'Breakfast', 'breakfast ', '朝食', 'dessert']) {
    it(`★meal_type = ${JSON.stringify(bad)} の INSERT は 23514 (planned_meals_meal_type_check) で拒否される`, async () => {
      const res = await insertAsUser({ meal_type: bad }, 'meal-type-bad');
      expectCheckViolation(res, 'planned_meals_meal_type_check');
    });
  }

  it('★既存の行の meal_type を想定外の値に書き換える UPDATE は拒否され、元の値が残る', async () => {
    const created = await insertAsUser({ meal_type: 'dinner' }, 'meal-type-update');
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    const res = await asUser(userJwt).from('planned_meals').update({ meal_type: 'brunch' }).eq('id', id);
    expectCheckViolation(res, 'planned_meals_meal_type_check');
    expect(await readRow(id)).toMatchObject({ meal_type: 'dinner' });

    const ok = await asUser(userJwt).from('planned_meals').update({ meal_type: 'snack' }).eq('id', id);
    expect(ok.error).toBeNull();
    expect(await readRow(id)).toMatchObject({ meal_type: 'snack' });
  });
});
