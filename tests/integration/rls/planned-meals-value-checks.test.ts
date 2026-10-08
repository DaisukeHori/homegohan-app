/**
 * #1205 planned_meals の栄養素 4 列 (calories_kcal / protein_g / fat_g / carbs_g) と meal_type の、範囲の検査 (トリガー) の回帰テスト
 *
 * 食事の登録・更新 API は、これらの列を型・範囲の確認なしに planned_meals へ書いていた。
 * DB 側にも制約が無く (2026-10-06 の本番スナップショットで確認。#221 の meal_type の CHECK も本番には無い)、
 * 負のカロリーや桁外れの数値、NaN、想定外の meal_type がそのまま残っていた。
 * アプリ層 (src/lib/planned-meal-validation.ts) の確認を通らない書き込み経路
 * (モバイルが Supabase クライアントで直接 INSERT する apps/mobile/app/meals/new.tsx、
 * service_role で書く Edge Function の献立生成) もあるため、DB 側でも止める。
 *
 * 修正 (20261008110000_planned_meals_value_checks.sql): BEFORE INSERT OR UPDATE OF の行トリガー
 * trg_planned_meals_validate_values (関数 validate_planned_meal_values) を足す。
 *   calories_kcal は 0〜20000、protein_g / fat_g / carbs_g は 0〜2000、
 *   meal_type は breakfast / lunch / dinner / snack / midnight_snack の 5 値 (栄養素の NULL は許す)。
 * 上限はアプリ層 (calories 5000 / protein 500 / fat 300 / carbs 800) より緩い。
 * Edge Function の生成結果や過去の正当な値を、DB 側の確認で弾かないための余裕。
 * 検査するのは「書き込む値」だけ: INSERT は 5 列すべて、UPDATE は値が変わる列だけ。
 *
 * CHECK 制約 (NOT VALID) にしなかった理由 (このテストの D):
 *   NOT VALID の CHECK 制約も、その後の INSERT / UPDATE では行全体を検査する。本番のデータは事前に確かめられないため、
 *   範囲外の値の行がすでにあると、その行は is_completed の切り替えなど、無関係な列の更新でも 23514 で拒否されてしまう。
 *   トリガーなら、範囲外の値を持つ既存の行も、その列を変えない更新は通る。
 *
 * 確認すること:
 *   A. カタログ: トリガー・関数の定義が期待どおりで、最初の版の CHECK 制約 5 本が残っていない
 *   B. 範囲外の書き込みは 23514 (HTTP 400) で拒否され、エラーに列名が入る (INSERT・UPDATE・本人のセッション・service_role)
 *   C. 範囲内の書き込みは通る (境界値・NULL・小数・5 つの meal_type)。アプリ層で通る値は DB でも通る
 *   D. すでに範囲外の値を持つ行 (本番に元からあるデータの再現) は、その列を変えない更新が通る。migration を流し直しても同じ
 *
 * 範囲外の行を作る (トリガーを 1 つのトランザクションの中だけ無効にして INSERT する)・カタログを読む・
 * migration を流し直すのは、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で行う。
 * 複数の文を 1 回の要求で流すと 1 つのトランザクションになるため、ほかの接続からはトリガーが無効に見える瞬間はない。
 * 本番には接続しない。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/planned-meals-value-checks.test.ts
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import {
  PLANNED_MEAL_NUTRIENT_LIMITS,
  PLANNED_MEAL_TYPES,
  type PlannedMealNutrientField,
} from '../../../src/lib/planned-meal-validation';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_FILE = 'supabase/migrations/20261008110000_planned_meals_value_checks.sql';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), 'utf8');

const TRIGGER = 'trg_planned_meals_validate_values';
const FUNCTION = 'validate_planned_meal_values';
/** 最初の版 (NOT VALID の CHECK 制約。main にはマージされていない) が付けていた制約の名前 */
const OLD_CHECK_CONSTRAINTS = [
  'planned_meals_calories_kcal_range',
  'planned_meals_protein_g_range',
  'planned_meals_fat_g_range',
  'planned_meals_carbs_g_range',
  'planned_meals_meal_type_check',
] as const;

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

/**
 * ローカルスタックの postgres-meta で SQL を流す (カタログの読み取り・範囲外の行の作成・migration の流し直しに使う)。
 * 複数の文は 1 つのトランザクションで実行され、最後の文の行が返る。
 */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
let userId = '';
let userJwt = '';
let dailyMealId = '';
let seq = 0;

/** 行を区別するための一意な料理名 (後始末は user_daily_meals の削除で連鎖する) */
function dishName(label: string): string {
  seq += 1;
  return `value-guard-${label}-${seq}`;
}

type PlannedMealInsert = Record<string, unknown>;

const RETURNED_COLUMNS = 'id, meal_type, calories_kcal, protein_g, fat_g, carbs_g';

/** 本人のセッション (モバイルが Supabase クライアントで直接 INSERT するのと同じ経路) で planned_meals へ INSERT する */
async function insertAsUser(values: PlannedMealInsert, label: string) {
  return asUser(userJwt)
    .from('planned_meals')
    .insert({ daily_meal_id: dailyMealId, meal_type: 'lunch', dish_name: dishName(label), ...values })
    .select(RETURNED_COLUMNS)
    .single();
}

/** service_role (Edge Function が使う経路) で planned_meals へ INSERT する */
async function insertAsService(values: PlannedMealInsert, label: string) {
  return srAdmin
    .from('planned_meals')
    .insert({ daily_meal_id: dailyMealId, meal_type: 'lunch', dish_name: dishName(label), ...values })
    .select(RETURNED_COLUMNS)
    .single();
}

/** 範囲外の書き込みが、CHECK 制約違反と同じ SQLSTATE 23514 (PostgREST では HTTP 400) で拒否され、エラーに列名が入ること */
function expectCheckViolation(
  res: { error: { code?: string; message: string } | null; status?: number },
  column: string,
) {
  expect(res.error, `planned_meals.${column} の範囲外の書き込みが拒否されるはずが、書き込みが通った`).not.toBeNull();
  expect(res.error!.code).toBe('23514');
  expect(res.error!.message).toContain(`planned_meals.${column}`);
  expect(res.status).toBe(400);
}

/** service_role で行を読む (数値型の NaN は PostgREST の JSON では文字列になるため、比較には readRowText を使う) */
async function readRow(id: string) {
  const { data, error } = await srAdmin.from('planned_meals').select(RETURNED_COLUMNS).eq('id', id).single();
  if (error || !data) throw new Error(`planned_meals ${id}: ${error?.message}`);
  return data as Record<string, unknown>;
}

/** 列の値を text で読む ('NaN' / '-5' などを文字列のまま比べられる) */
async function readRowText(id: string) {
  const rows = await pgQuery<Record<string, string | boolean | null>>(`
    SELECT meal_type,
           calories_kcal::text AS calories_kcal,
           protein_g::text AS protein_g,
           fat_g::text AS fat_g,
           carbs_g::text AS carbs_g,
           is_completed,
           dish_name,
           memo
    FROM public.planned_meals
    WHERE id = '${id}'
  `);
  if (rows.length !== 1) throw new Error(`planned_meals ${id}: ${rows.length} 行`);
  return rows[0];
}

/** トリガーの有効状態 ('O' = 有効、'D' = 無効)。無ければ null */
async function triggerEnabled(): Promise<string | null> {
  const rows = await pgQuery<{ tgenabled: string }>(`
    SELECT tgenabled
    FROM pg_trigger
    WHERE tgrelid = 'public.planned_meals'::regclass AND tgname = '${TRIGGER}' AND NOT tgisinternal
  `);
  return rows.length === 0 ? null : rows[0].tgenabled;
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
  // planned_meals は user_daily_meals の削除で連鎖して消える (範囲外の行を作ったときもトリガーは有効に戻してある)
  if (dailyMealId) await srAdmin.from('user_daily_meals').delete().eq('id', dailyMealId);
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
}, 60_000);

// ---------------------------------------------------------------
// A. カタログ
// ---------------------------------------------------------------
describe('#1205 A. トリガーと関数の定義 (カタログ)', () => {
  it('BEFORE INSERT OR UPDATE OF (5 列) の行トリガーが有効で、関数は SECURITY INVOKER・search_path が空の plpgsql', async () => {
    const rows = await pgQuery<{
      tgenabled: string;
      def: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      lanname: string;
      rettype: string;
    }>(`
      SELECT t.tgenabled,
             pg_get_triggerdef(t.oid) AS def,
             p.prosecdef,
             p.proconfig,
             l.lanname,
             p.prorettype::regtype::text AS rettype
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_language l ON l.oid = p.prolang
      WHERE t.tgrelid = 'public.planned_meals'::regclass
        AND t.tgname = '${TRIGGER}'
        AND NOT t.tgisinternal
    `);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tgenabled).toBe('O');
    expect(row.def).toContain('BEFORE INSERT OR UPDATE OF meal_type, calories_kcal, protein_g, fat_g, carbs_g ON public.planned_meals');
    expect(row.def).toContain('FOR EACH ROW');
    expect(row.def).toContain(`${FUNCTION}()`);
    expect(row.prosecdef).toBe(false);
    expect(row.proconfig).toEqual(['search_path=""']);
    expect(row.lanname).toBe('plpgsql');
    expect(row.rettype).toBe('trigger');
  });

  it('★最初の版の CHECK 制約 (NOT VALID。既存の範囲外の行の更新を止めてしまう) は残っていない', async () => {
    const names = OLD_CHECK_CONSTRAINTS.map((n) => `'${n}'`).join(', ');
    const rows = await pgQuery<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.planned_meals'::regclass AND conname IN (${names})
      ORDER BY conname
    `);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------
// B. 範囲外の書き込みは拒否される
// ---------------------------------------------------------------
describe('#1205 B. 範囲外の書き込みは 23514 で拒否される', () => {
  const numericColumns = [
    { column: 'calories_kcal', max: 20000 },
    { column: 'protein_g', max: 2000 },
    { column: 'fat_g', max: 2000 },
    { column: 'carbs_g', max: 2000 },
  ] as const;

  for (const { column, max } of numericColumns) {
    describe(column, () => {
      it('★負の値 (-1) の INSERT は拒否される', async () => {
        const res = await insertAsUser({ [column]: -1 }, `${column}-negative`);
        expectCheckViolation(res, column);
      });

      it(`★上限 (${max}) を超える値の INSERT は拒否される`, async () => {
        const res = await insertAsUser({ [column]: max + 1 }, `${column}-over`);
        expectCheckViolation(res, column);
      });

      it('★桁外れの値 (1e9) の INSERT は拒否される', async () => {
        const res = await insertAsUser({ [column]: 1_000_000_000 }, `${column}-huge`);
        expectCheckViolation(res, column);
      });

      it('★範囲内の行を範囲外の値へ書き換える UPDATE は拒否され、元の値が残る', async () => {
        const created = await insertAsUser({ [column]: 100 }, `${column}-update`);
        expect(created.error).toBeNull();
        const id = (created.data as { id: string }).id;

        const negative = await asUser(userJwt).from('planned_meals').update({ [column]: -5 }).eq('id', id);
        expectCheckViolation(negative, column);
        const over = await asUser(userJwt)
          .from('planned_meals')
          .update({ [column]: max + 1 })
          .eq('id', id);
        expectCheckViolation(over, column);
        expect(await readRow(id)).toMatchObject({ [column]: 100 });

        // 範囲内への更新は通る
        const ok = await asUser(userJwt).from('planned_meals').update({ [column]: 150 }).eq('id', id);
        expect(ok.error).toBeNull();
        expect(await readRow(id)).toMatchObject({ [column]: 150 });
      });
    });
  }

  for (const column of ['protein_g', 'fat_g', 'carbs_g'] as const) {
    for (const text of ['NaN', 'Infinity', '-Infinity']) {
      it(`★${column} に数値型の特殊値 "${text}" (文字列で送る) を入れた INSERT は拒否される`, async () => {
        // numeric 型は NaN / Infinity を値として受け付ける。JSON では文字列で送ると入ってしまう。
        // NaN は numeric の比較で「最大」として扱われるため、上限の確認で弾かれる。
        const res = await insertAsUser({ [column]: text }, `${column}-${text}`);
        expectCheckViolation(res, column);
      });
    }
  }

  it('★桁数の多い値 (1e300) でも、エラーは 23514 で返り、メッセージに入る値は 40 文字まで', async () => {
    const res = await insertAsUser({ protein_g: 1e300 }, 'protein-1e300');
    expectCheckViolation(res, 'protein_g');
    expect(res.error!.message.length).toBeLessThan(300);
  });

  it('★範囲内の行を NaN へ書き換える UPDATE も拒否される', async () => {
    const created = await insertAsUser({ protein_g: 10 }, 'protein-update-nan');
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    const res = await asUser(userJwt).from('planned_meals').update({ protein_g: 'NaN' }).eq('id', id);
    expectCheckViolation(res, 'protein_g');
    expect(await readRow(id)).toMatchObject({ protein_g: 10 });
  });

  describe('meal_type', () => {
    for (const bad of ['brunch', '', 'Breakfast', 'breakfast ', '朝食', 'dessert']) {
      it(`★meal_type = ${JSON.stringify(bad)} の INSERT は拒否される`, async () => {
        const res = await insertAsUser({ meal_type: bad }, 'meal-type-bad');
        expectCheckViolation(res, 'meal_type');
      });
    }

    it('★長すぎる meal_type でも、エラーは 23514 で返る (メッセージに入る値は 50 文字まで)', async () => {
      const res = await insertAsUser({ meal_type: 'x'.repeat(5000) }, 'meal-type-long');
      expectCheckViolation(res, 'meal_type');
      expect(res.error!.message.length).toBeLessThan(300);
    });

    it('meal_type が NULL の INSERT は、従来どおり NOT NULL 制約 (23502) で拒否される', async () => {
      const res = await insertAsUser({ meal_type: null }, 'meal-type-null');
      expect(res.error).not.toBeNull();
      expect(res.error!.code).toBe('23502');
    });

    it('★既存の行の meal_type を想定外の値に書き換える UPDATE は拒否され、元の値が残る', async () => {
      const created = await insertAsUser({ meal_type: 'dinner' }, 'meal-type-update');
      expect(created.error).toBeNull();
      const id = (created.data as { id: string }).id;

      const res = await asUser(userJwt).from('planned_meals').update({ meal_type: 'brunch' }).eq('id', id);
      expectCheckViolation(res, 'meal_type');
      expect(await readRow(id)).toMatchObject({ meal_type: 'dinner' });

      const ok = await asUser(userJwt).from('planned_meals').update({ meal_type: 'snack' }).eq('id', id);
      expect(ok.error).toBeNull();
      expect(await readRow(id)).toMatchObject({ meal_type: 'snack' });
    });
  });

  it('★service_role (Edge Function が使う経路) の INSERT・UPDATE も検査される', async () => {
    const res = await insertAsService({ calories_kcal: -1 }, 'service-negative');
    expectCheckViolation(res, 'calories_kcal');

    const badType = await insertAsService({ meal_type: 'brunch' }, 'service-bad-type');
    expectCheckViolation(badType, 'meal_type');

    const created = await insertAsService({ calories_kcal: 650, protein_g: 31.2, fat_g: 20, carbs_g: 80.5 }, 'service-ok');
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    const update = await srAdmin.from('planned_meals').update({ fat_g: 5000 }).eq('id', id);
    expectCheckViolation(update, 'fat_g');
    expect(await readRow(id)).toMatchObject({ fat_g: 20 });
  });

  it('★複数の列が範囲外でも INSERT は拒否される (どれか 1 つの列名がエラーに入る)', async () => {
    const res = await insertAsUser({ calories_kcal: -1, protein_g: -1, fat_g: -1, carbs_g: -1 }, 'all-bad');
    expect(res.error).not.toBeNull();
    expect(res.error!.code).toBe('23514');
    expect(res.error!.message).toMatch(/planned_meals\.(calories_kcal|protein_g|fat_g|carbs_g)/);
  });
});

// ---------------------------------------------------------------
// C. 範囲内の書き込みは通る
// ---------------------------------------------------------------
describe('#1205 C. 範囲内の書き込みは通る', () => {
  const numericColumns = [
    { column: 'calories_kcal', max: 20000 },
    { column: 'protein_g', max: 2000 },
    { column: 'fat_g', max: 2000 },
    { column: 'carbs_g', max: 2000 },
  ] as const;

  for (const { column, max } of numericColumns) {
    it(`${column}: 0・上限ちょうど (${max})・NULL は通る (境界値)`, async () => {
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

  it('範囲内の UPDATE (値を変える・NULL にする・同じ値で書き直す) は通る', async () => {
    const created = await insertAsUser({ calories_kcal: 400, protein_g: 20, fat_g: 10, carbs_g: 50 }, 'update-ok');
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    const change = await asUser(userJwt)
      .from('planned_meals')
      .update({ calories_kcal: 450, protein_g: 25.5, fat_g: 12, carbs_g: 55 })
      .eq('id', id);
    expect(change.error).toBeNull();
    expect(await readRow(id)).toMatchObject({ calories_kcal: 450, protein_g: 25.5, fat_g: 12, carbs_g: 55 });

    const clear = await asUser(userJwt).from('planned_meals').update({ protein_g: null }).eq('id', id);
    expect(clear.error).toBeNull();
    expect((await readRow(id)).protein_g).toBeNull();

    const same = await asUser(userJwt).from('planned_meals').update({ calories_kcal: 450, fat_g: 12 }).eq('id', id);
    expect(same.error).toBeNull();
  });

  it('★service_role (Edge Function が使う経路) の範囲内の INSERT は通る', async () => {
    const ok = await insertAsService({ calories_kcal: 650, protein_g: 31.2, fat_g: 20, carbs_g: 80.5 }, 'service-ok-2');
    expect(ok.error).toBeNull();
  });

  it('検査の対象は 5 列だけで、ほかの栄養素の列 (sodium_g など) は従来どおり', async () => {
    const res = await insertAsUser({ calories_kcal: 400, sodium_g: 12.5, fiber_g: 3 }, 'other-columns');
    expect(res.error).toBeNull();
  });

  describe('meal_type は 5 値が通る', () => {
    for (const mealType of PLANNED_MEAL_TYPES) {
      it(`${mealType} は通る`, async () => {
        const res = await insertAsUser({ meal_type: mealType }, `meal-type-${mealType}`);
        expect(res.error).toBeNull();
        expect(res.data).toMatchObject({ meal_type: mealType });
      });
    }

    it('★midnight_snack (夜食) は拒否されない。#221 の 4 値だけの CHECK をそのまま足すと夜食が弾かれるため、5 値にしている', async () => {
      const res = await insertAsUser({ meal_type: 'midnight_snack' }, 'midnight');
      expect(res.error).toBeNull();
    });
  });

  describe('アプリ層 (src/lib/planned-meal-validation.ts) で通る値は、DB でも通る', () => {
    const fields: { field: PlannedMealNutrientField; dbMax: number }[] = [
      { field: 'calories_kcal', dbMax: 20000 },
      { field: 'protein_g', dbMax: 2000 },
      { field: 'fat_g', dbMax: 2000 },
      { field: 'carbs_g', dbMax: 2000 },
    ];

    for (const { field, dbMax } of fields) {
      const limit = PLANNED_MEAL_NUTRIENT_LIMITS[field];
      it(`${field}: アプリ層の範囲 (${limit.min} 〜 ${limit.max}) は DB の範囲 (〜 ${dbMax}) に収まり、両端の値が通る`, async () => {
        expect(limit.min).toBeGreaterThanOrEqual(0);
        expect(limit.max).toBeLessThanOrEqual(dbMax);

        const lower = await insertAsUser({ [field]: limit.min }, `api-${field}-min`);
        expect(lower.error).toBeNull();
        const upper = await insertAsUser({ [field]: limit.max }, `api-${field}-max`);
        expect(upper.error).toBeNull();
      });
    }
  });
});

// ---------------------------------------------------------------
// D. すでに範囲外の値を持つ行 (本番に元からあるデータの再現)
// ---------------------------------------------------------------
/** SQL の文字列リテラル (テストが決めた定数だけを入れる。シングルクォートは重ねる) */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * migration より前から範囲外の値を持っていた行を作る。
 * トリガーを 1 つのトランザクションの中だけ無効にして INSERT し、有効に戻す (途中で失敗しても、まとめて取り消される)。
 * sqlValues は列名 → SQL の式 (例: { calories_kcal: '-5', protein_g: "'NaN'" })。
 */
async function plantLegacyRow(label: string, sqlValues: Record<string, string>): Promise<string> {
  const id = randomUUID();
  const columns: Record<string, string> = {
    id: lit(id),
    daily_meal_id: lit(dailyMealId),
    meal_type: lit('lunch'),
    dish_name: lit(dishName(label)),
    ...sqlValues,
  };
  await pgQuery(`
    ALTER TABLE public.planned_meals DISABLE TRIGGER ${TRIGGER};
    INSERT INTO public.planned_meals (${Object.keys(columns).join(', ')})
    VALUES (${Object.values(columns).join(', ')});
    ALTER TABLE public.planned_meals ENABLE TRIGGER ${TRIGGER};
  `);
  expect(await triggerEnabled(), 'トリガーを有効に戻せていない').toBe('O');
  return id;
}

/** 5 列とも範囲外の行の値 (readRowText の形) */
const ALL_BAD = {
  meal_type: 'brunch',
  calories_kcal: '-5',
  protein_g: 'NaN',
  fat_g: '99999',
  carbs_g: '-1',
} as const;

describe('#1205 D. すでに範囲外の値を持つ行 (本番に元からあるデータの再現)', () => {
  let allBadId = '';
  let calorieBadId = '';

  beforeAll(async () => {
    allBadId = await plantLegacyRow('legacy-all-bad', {
      meal_type: lit(ALL_BAD.meal_type),
      calories_kcal: ALL_BAD.calories_kcal,
      protein_g: lit(ALL_BAD.protein_g),
      fat_g: ALL_BAD.fat_g,
      carbs_g: ALL_BAD.carbs_g,
    });
    calorieBadId = await plantLegacyRow('legacy-calorie-bad', { calories_kcal: '30000', protein_g: '12.5' });
  }, 60_000);

  it('前提: 作った行は本当にトリガーの範囲外の値を持ち、トリガーは有効', async () => {
    expect(await readRowText(allBadId)).toMatchObject(ALL_BAD);
    expect(await readRowText(calorieBadId)).toMatchObject({ calories_kcal: '30000', protein_g: '12.5' });
    expect(await triggerEnabled()).toBe('O');

    // 新しく同じ値を INSERT するのは、従来どおり拒否される (トリガーは効いている)
    const res = await insertAsUser({ calories_kcal: 30000 }, 'legacy-new-insert');
    expectCheckViolation(res, 'calories_kcal');
  });

  it('★既存の範囲外の行: 本人が is_completed を切り替えられる (範囲外の値は触らない)', async () => {
    const done = await asUser(userJwt)
      .from('planned_meals')
      .update({ is_completed: true, completed_at: new Date().toISOString() })
      .eq('id', allBadId);
    expect(done.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({ ...ALL_BAD, is_completed: true });

    const undone = await asUser(userJwt).from('planned_meals').update({ is_completed: false }).eq('id', allBadId);
    expect(undone.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({ ...ALL_BAD, is_completed: false });

    const second = await asUser(userJwt).from('planned_meals').update({ is_completed: true }).eq('id', calorieBadId);
    expect(second.error).toBeNull();
    expect(await readRowText(calorieBadId)).toMatchObject({ calories_kcal: '30000', is_completed: true });
  });

  it('★既存の範囲外の行: 無関係な列 (料理名・メモ・説明・表示順・モード) の更新も通る', async () => {
    const res = await asUser(userJwt)
      .from('planned_meals')
      .update({ dish_name: 'renamed-legacy', memo: 'メモ', description: '説明', display_order: 3, mode: 'buy' })
      .eq('id', allBadId);
    expect(res.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({ ...ALL_BAD, dish_name: 'renamed-legacy', memo: 'メモ' });
  });

  it('★既存の範囲外の行: 同じ日の食事の一括更新 (範囲外の行を含む) も通る', async () => {
    const res = await asUser(userJwt)
      .from('planned_meals')
      .update({ is_completed: true })
      .eq('daily_meal_id', dailyMealId);
    expect(res.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({ ...ALL_BAD, is_completed: true });
    expect(await readRowText(calorieBadId)).toMatchObject({ calories_kcal: '30000', is_completed: true });
  });

  it('★既存の範囲外の行: service_role (Edge Function が使う経路) の更新も通る', async () => {
    const res = await srAdmin.from('planned_meals').update({ is_completed: false, memo: 'service' }).eq('id', allBadId);
    expect(res.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({ ...ALL_BAD, is_completed: false, memo: 'service' });
  });

  it('★既存の範囲外の行: 範囲外の値を同じ値で書き直しても通る (値が変わらない列は検査しない)', async () => {
    // クライアントが行全体を送り返す場合など
    const res = await asUser(userJwt)
      .from('planned_meals')
      .update({
        meal_type: ALL_BAD.meal_type,
        calories_kcal: Number(ALL_BAD.calories_kcal),
        protein_g: ALL_BAD.protein_g,
        fat_g: Number(ALL_BAD.fat_g),
        carbs_g: Number(ALL_BAD.carbs_g),
        is_completed: true,
      })
      .eq('id', allBadId);
    expect(res.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({ ...ALL_BAD, is_completed: true });
  });

  it('★既存の範囲外の行: 範囲外の値を「ほかの範囲外の値」に変える更新は拒否され、元の値が残る', async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ['calories_kcal', { calories_kcal: -6 }],
      ['protein_g', { protein_g: 'Infinity' }],
      ['fat_g', { fat_g: 100000 }],
      ['carbs_g', { carbs_g: -2 }],
      ['meal_type', { meal_type: 'dessert' }],
    ];
    for (const [column, change] of attempts) {
      const res = await asUser(userJwt).from('planned_meals').update(change).eq('id', allBadId);
      expectCheckViolation(res, column);
    }
    expect(await readRowText(allBadId)).toMatchObject(ALL_BAD);
  });

  it('★既存の範囲外の行: 範囲内の値や NULL に直す更新は通る (ほかの列が範囲外のままでも)', async () => {
    const calories = await asUser(userJwt).from('planned_meals').update({ calories_kcal: 500 }).eq('id', allBadId);
    expect(calories.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({ ...ALL_BAD, calories_kcal: '500' });

    const protein = await asUser(userJwt).from('planned_meals').update({ protein_g: null }).eq('id', allBadId);
    expect(protein.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({ protein_g: null, fat_g: ALL_BAD.fat_g, carbs_g: ALL_BAD.carbs_g });

    // 残りもすべて直すと、行全体が範囲内になる
    const rest = await asUser(userJwt)
      .from('planned_meals')
      .update({ meal_type: 'lunch', fat_g: 20, carbs_g: 60 })
      .eq('id', allBadId);
    expect(rest.error).toBeNull();
    expect(await readRowText(allBadId)).toMatchObject({
      meal_type: 'lunch',
      calories_kcal: '500',
      protein_g: null,
      fat_g: '20',
      carbs_g: '60',
    });
  });

  it('★migration を (範囲外の行があるまま) 流し直しても失敗せず、トリガーは有効のまま。そのあとも範囲外の行を更新できる', async () => {
    // CREATE OR REPLACE FUNCTION / TRIGGER のため何度流してもよい。既存の行は読まない。
    const legacyId = await plantLegacyRow('legacy-reapply', { calories_kcal: '-9', carbs_g: "'-Infinity'" });

    await pgQuery(MIGRATION_SQL);
    await pgQuery(MIGRATION_SQL);
    expect(await triggerEnabled()).toBe('O');

    expect(await readRowText(legacyId)).toMatchObject({ calories_kcal: '-9', carbs_g: '-Infinity' });
    const res = await asUser(userJwt).from('planned_meals').update({ is_completed: true }).eq('id', legacyId);
    expect(res.error).toBeNull();

    // 流し直したあとも、新しい範囲外の書き込みは拒否される
    const bad = await asUser(userJwt).from('planned_meals').update({ protein_g: -1 }).eq('id', legacyId);
    expectCheckViolation(bad, 'protein_g');
  });
});
