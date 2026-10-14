/**
 * #1103 (T45) 夜食 (midnight_snack) を正式な食事区分とする: meals.meal_type の値の検査 (トリガー) の回帰テスト
 *
 * 食事区分は 朝食 breakfast・昼食 lunch・夕食 dinner・おやつ snack・夜食 midnight_snack の 5 値。
 * planned_meals.meal_type は 20261008110000 (#1205) のトリガー trg_planned_meals_validate_values が 5 値だけを通す。
 * 一方、meals.meal_type (NOT NULL の text) には、本番のスナップショット (supabase/baseline/prod_schema.sql) でも
 * 値の制約が無く、どんな文字列でも保存できた (#221 の meal_type の CHECK は台帳では適用済みだが、本番には無い)。
 *
 * 修正 (20261010042500_meals_meal_type_trigger.sql): meals に BEFORE INSERT OR UPDATE OF meal_type の行トリガー
 * trg_meals_validate_meal_type (関数 validate_meals_meal_type) を足す。planned_meals と同じ 5 値だけを通し、
 * それ以外は SQLSTATE 23514 (check_violation) で拒否する。
 * 検査するのは「書き込む値」だけ: INSERT は meal_type、UPDATE は meal_type の値が変わるときだけ。
 *
 * CHECK 制約 (NOT VALID) にしなかった理由 (このテストの D):
 *   NOT VALID の CHECK 制約も、その後の INSERT / UPDATE では行全体を検査する。本番の meals の中身は事前に確かめられないため、
 *   5 値以外の meal_type を持つ行がすでにあると、その行は memo や photo_url の更新でも 23514 で拒否されてしまう。
 *   トリガーなら、meal_type を変えない更新は今までどおり通る。VALIDATE CONSTRAINT の後続 migration も要らない。
 *
 * 確認すること:
 *   A. カタログ: トリガー・関数の定義が期待どおりで、meals に CHECK 制約は足していない。関数は RPC から直接呼べない
 *   B. 5 値以外の meal_type の書き込みは 23514 (HTTP 400) で拒否され、エラーに列名と許可する値が入る
 *      (INSERT・UPDATE・複数行の INSERT・本人のセッション・service_role)。拒否された行は残らない
 *   C. 5 値 (夜食を含む) は meals にも planned_meals にも通る。planned_meals の 5 値以外は、meals と同じく拒否される
 *   D. すでに 5 値以外の meal_type を持つ行 (本番に元からあるデータの再現) は、meal_type を変えない更新が通る。
 *      migration を流し直しても同じ
 *   E. 家族へのペースト (RPC paste_meal_to_family。meals へ INSERT する唯一の DB 関数) は、5 値ならそのまま通る。
 *      5 値以外のコピー元だけは、新しい行を作る INSERT が 23514 で失敗する (意図した変化。何も書き残さない)
 *   F. ロールバックで検査が外れ、migration を流し直すと戻る (どちらも 2 回続けて流せる)
 *
 * 5 値以外の行を作る (トリガーを 1 つのトランザクションの中だけ無効にして INSERT する)・カタログを読む・
 * migration を流し直すのは、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で行う。
 * 複数の文を 1 回の要求で流すと 1 つのトランザクションになるため、ほかの接続からはトリガーが無効に見える瞬間はない。
 * 本番には接続しない。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/meals-meal-type-trigger.test.ts
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { PLANNED_MEAL_TYPES } from '../../../src/lib/planned-meal-validation';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_FILE = 'supabase/migrations/20261010042500_meals_meal_type_trigger.sql';
const ROLLBACK_FILE = 'supabase/rollbacks/20261010042500_meals_meal_type_trigger.down.sql';

const TRIGGER = 'trg_meals_validate_meal_type';
const FUNCTION = 'validate_meals_meal_type';

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
 * ローカルスタックの postgres-meta で SQL を流す (カタログの読み取り・5 値以外の行の作成・migration の流し直しに使う)。
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

/** SQL の文字列リテラル (テストが決めた定数だけを入れる。シングルクォートは重ねる) */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
let userId = '';
let userJwt = '';
let dailyMealId = '';
let seq = 0;

/** 行を区別するための一意なメモ / 料理名 (後始末は user の削除 (meals) と user_daily_meals の削除 (planned_meals) で連鎖する) */
function labelOf(label: string): string {
  seq += 1;
  return `meal-type-guard-${label}-${seq}`;
}

type Table = 'meals' | 'planned_meals';
type Values = Record<string, unknown>;

/** meals へ INSERT する (既定は有効な meal_type = lunch。values で上書きする) */
async function insertMeal(who: SupabaseClient, values: Values, label: string) {
  return who
    .from('meals')
    .insert({ user_id: userId, eaten_at: new Date().toISOString(), meal_type: 'lunch', memo: labelOf(label), ...values })
    .select('id, meal_type')
    .single();
}

/** planned_meals へ INSERT する (本人のセッション。モバイルが Supabase クライアントで直接 INSERT するのと同じ経路) */
async function insertPlannedMeal(who: SupabaseClient, values: Values, label: string) {
  return who
    .from('planned_meals')
    .insert({ daily_meal_id: dailyMealId, meal_type: 'lunch', dish_name: labelOf(label), ...values })
    .select('id, meal_type')
    .single();
}

function insertInto(table: Table, who: SupabaseClient, values: Values, label: string) {
  return table === 'meals' ? insertMeal(who, values, label) : insertPlannedMeal(who, values, label);
}

/** 想定外の meal_type の書き込みが、CHECK 制約違反と同じ SQLSTATE 23514 (PostgREST では HTTP 400) で拒否され、エラーに列名が入ること */
function expectMealTypeViolation(
  res: { error: { code?: string; message: string } | null; status?: number },
  table: Table,
) {
  expect(res.error, `${table}.meal_type の想定外の値の書き込みが拒否されるはずが、書き込みが通った`).not.toBeNull();
  expect(res.error!.code).toBe('23514');
  expect(res.error!.message).toContain(`${table}.meal_type`);
  expect(res.status).toBe(400);
}

/** service_role で meal_type を読む */
async function readMealType(table: Table, id: string): Promise<string | null> {
  const { data, error } = await srAdmin.from(table).select('meal_type').eq('id', id).maybeSingle();
  if (error) throw new Error(`${table} ${id}: ${error.message}`);
  return data ? (data as { meal_type: string }).meal_type : null;
}

/** メモで meals の行数を数える (拒否された INSERT が行を残していないことの確認) */
async function countMealsByMemo(memo: string): Promise<number> {
  const { data, error } = await srAdmin.from('meals').select('id').eq('memo', memo);
  if (error) throw new Error(`meals memo=${memo}: ${error.message}`);
  return (data ?? []).length;
}

/** トリガーの有効状態 ('O' = 有効、'D' = 無効)。無ければ null */
async function triggerEnabled(): Promise<string | null> {
  const rows = await pgQuery<{ tgenabled: string }>(`
    SELECT tgenabled
    FROM pg_trigger
    WHERE tgrelid = 'public.meals'::regclass AND tgname = '${TRIGGER}' AND NOT tgisinternal
  `);
  return rows.length === 0 ? null : rows[0].tgenabled;
}

beforeAll(async () => {
  const email = `rls-meals-meal-type-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: 'meals-meal-type', age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`user_profiles: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  userJwt = signIn.data.session.access_token;
  const { data: day, error: dayError } = await asUser(userJwt)
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: '2026-10-09' })
    .select('id')
    .single();
  if (dayError || !day) throw new Error(`user_daily_meals: ${dayError?.message}`);
  dailyMealId = (day as { id: string }).id;
}, 60_000);

afterAll(async () => {
  // meals はユーザーの削除で連鎖して消えるが、5 値以外の行を作ったあともトリガーは有効に戻してあるので、明示的に消しておく。
  // planned_meals は user_daily_meals の削除で連鎖して消える
  if (userId) await srAdmin.from('meals').delete().eq('user_id', userId);
  if (dailyMealId) await srAdmin.from('user_daily_meals').delete().eq('id', dailyMealId);
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
}, 60_000);

// ---------------------------------------------------------------
// A. カタログ
// ---------------------------------------------------------------
describe('#1103 A. トリガーと関数の定義 (カタログ)', () => {
  it('BEFORE INSERT OR UPDATE OF meal_type の行トリガーが有効で、関数は SECURITY INVOKER・search_path が空の plpgsql', async () => {
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
      WHERE t.tgrelid = 'public.meals'::regclass
        AND t.tgname = '${TRIGGER}'
        AND NOT t.tgisinternal
    `);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tgenabled).toBe('O');
    expect(row.def).toContain('BEFORE INSERT OR UPDATE OF meal_type ON public.meals');
    expect(row.def).toContain('FOR EACH ROW');
    expect(row.def).toContain(`${FUNCTION}()`);
    expect(row.prosecdef).toBe(false);
    expect(row.proconfig).toEqual(['search_path=""']);
    expect(row.lanname).toBe('plpgsql');
    expect(row.rettype).toBe('trigger');
  });

  it('★meals に CHECK 制約は足していない (既存の行の更新を止めうる NOT VALID の CHECK にしない)', async () => {
    const rows = await pgQuery<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.meals'::regclass AND contype = 'c'
      ORDER BY conname
    `);
    expect(rows).toEqual([]);
  });

  it('planned_meals 側の検査 (20261008110000) は変えていない: 同じ 5 値のトリガーが有効なまま', async () => {
    const rows = await pgQuery<{ tgenabled: string; def: string }>(`
      SELECT t.tgenabled, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      WHERE t.tgrelid = 'public.planned_meals'::regclass AND t.tgname = 'trg_planned_meals_validate_values' AND NOT t.tgisinternal
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].tgenabled).toBe('O');
    expect(rows[0].def).toContain('meal_type');
  });

  it('トリガー関数は、anon・ログインユーザー・service_role とも /rest/v1/rpc から直接呼べない (戻り値が trigger の関数は PostgREST に公開されない)', async () => {
    // そのため、関数に GRANT / REVOKE は付けていない (planned_meals の validate_planned_meal_values と同じ)
    for (const [label, who] of [
      ['anon', anon()],
      ['ログインユーザー', asUser(userJwt)],
      ['service_role', srAdmin],
    ] as const) {
      const res = await who.rpc(FUNCTION);
      expect(res.error, `${label}で呼べてしまっている`).not.toBeNull();
      expect(res.status, label).toBe(404);
      expect(res.data ?? null, label).toBeNull();
    }
  });
});

// ---------------------------------------------------------------
// B. 5 値以外の meal_type は拒否される
// ---------------------------------------------------------------
describe('#1103 B. meals.meal_type の 5 値以外の書き込みは 23514 で拒否される', () => {
  const BAD_VALUES = [
    'brunch',
    '',
    'Breakfast',
    'MIDNIGHT_SNACK',
    'breakfast ',
    ' lunch',
    'midnight-snack',
    'midnight snack',
    'late_night',
    '朝食',
    '夜食',
    'dessert',
    'snack,lunch',
  ];

  for (const bad of BAD_VALUES) {
    it(`★meal_type = ${JSON.stringify(bad)} の INSERT は拒否され、行は残らない`, async () => {
      const memo = labelOf('bad-insert');
      const res = await insertMeal(asUser(userJwt), { meal_type: bad, memo }, 'unused');
      expectMealTypeViolation(res, 'meals');
      expect(await countMealsByMemo(memo)).toBe(0);
    });
  }

  it('★エラーのメッセージに、許可する 5 値 (夜食 midnight_snack を含む) と指定された値が入る', async () => {
    const res = await insertMeal(asUser(userJwt), { meal_type: 'brunch' }, 'bad-message');
    expectMealTypeViolation(res, 'meals');
    for (const allowed of ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack']) {
      expect(res.error!.message).toContain(allowed);
    }
    expect(res.error!.message).toContain('brunch');
  });

  it('★長すぎる meal_type でも、エラーは 23514 で返る (メッセージに入る値は 50 文字まで)', async () => {
    const res = await insertMeal(asUser(userJwt), { meal_type: 'x'.repeat(5000) }, 'bad-long');
    expectMealTypeViolation(res, 'meals');
    expect(res.error!.message.length).toBeLessThan(300);
  });

  it('meal_type が NULL の INSERT は、従来どおり NOT NULL 制約 (23502) で拒否される', async () => {
    const res = await insertMeal(asUser(userJwt), { meal_type: null }, 'bad-null');
    expect(res.error).not.toBeNull();
    expect(res.error!.code).toBe('23502');
  });

  it('★複数行の INSERT に 1 行でも 5 値以外が混ざると、文全体が拒否され、どの行も残らない', async () => {
    const goodMemo = labelOf('bulk-good');
    const badMemo = labelOf('bulk-bad');
    const res = await asUser(userJwt)
      .from('meals')
      .insert([
        { user_id: userId, eaten_at: new Date().toISOString(), meal_type: 'midnight_snack', memo: goodMemo },
        { user_id: userId, eaten_at: new Date().toISOString(), meal_type: 'brunch', memo: badMemo },
      ])
      .select('id');
    expectMealTypeViolation(res, 'meals');
    expect(await countMealsByMemo(goodMemo)).toBe(0);
    expect(await countMealsByMemo(badMemo)).toBe(0);
  });

  it('★既存の行の meal_type を 5 値以外に書き換える UPDATE は拒否され、元の値が残る。5 値の中の書き換えは通る', async () => {
    const created = await insertMeal(asUser(userJwt), { meal_type: 'dinner' }, 'update');
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    for (const bad of ['brunch', '', 'Dinner', '夜食']) {
      const res = await asUser(userJwt).from('meals').update({ meal_type: bad }).eq('id', id);
      expectMealTypeViolation(res, 'meals');
    }
    expect(await readMealType('meals', id)).toBe('dinner');

    const toNight = await asUser(userJwt).from('meals').update({ meal_type: 'midnight_snack' }).eq('id', id);
    expect(toNight.error).toBeNull();
    expect(await readMealType('meals', id)).toBe('midnight_snack');

    const toSnack = await asUser(userJwt).from('meals').update({ meal_type: 'snack' }).eq('id', id);
    expect(toSnack.error).toBeNull();
    expect(await readMealType('meals', id)).toBe('snack');
  });

  it('★service_role (Edge Function などが使う経路) の INSERT・UPDATE も検査される', async () => {
    const bad = await insertMeal(srAdmin, { meal_type: 'brunch' }, 'service-bad');
    expectMealTypeViolation(bad, 'meals');

    const created = await insertMeal(srAdmin, { meal_type: 'midnight_snack' }, 'service-ok');
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    const update = await srAdmin.from('meals').update({ meal_type: 'dessert' }).eq('id', id);
    expectMealTypeViolation(update, 'meals');
    expect(await readMealType('meals', id)).toBe('midnight_snack');
  });
});

// ---------------------------------------------------------------
// C. 5 値は meals にも planned_meals にも通る
// ---------------------------------------------------------------
describe('#1103 C. 5 値 (夜食を含む) は通る。meals と planned_meals は同じ値を通す', () => {
  const tables: Table[] = ['meals', 'planned_meals'];

  it('前提: アプリの 5 値 (PLANNED_MEAL_TYPES) は 朝食・昼食・夕食・おやつ・夜食', () => {
    expect([...PLANNED_MEAL_TYPES]).toEqual(['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack']);
  });

  for (const table of tables) {
    describe(table, () => {
      for (const mealType of PLANNED_MEAL_TYPES) {
        it(`${mealType} の INSERT は通り、そのまま保存される`, async () => {
          const res = await insertInto(table, asUser(userJwt), { meal_type: mealType }, `ok-${mealType}`);
          expect(res.error).toBeNull();
          expect(res.data).toMatchObject({ meal_type: mealType });
        });

        it(`${mealType} への UPDATE (lunch から) は通る`, async () => {
          const created = await insertInto(table, asUser(userJwt), { meal_type: 'lunch' }, `update-to-${mealType}`);
          expect(created.error).toBeNull();
          const id = (created.data as { id: string }).id;

          const res = await asUser(userJwt).from(table).update({ meal_type: mealType }).eq('id', id);
          expect(res.error).toBeNull();
          expect(await readMealType(table, id)).toBe(mealType);
        });
      }

      it('★midnight_snack (夜食) は拒否されない。#221 の 4 値だけの CHECK を足すと夜食が弾かれるため、5 値で検査している', async () => {
        const res = await insertInto(table, asUser(userJwt), { meal_type: 'midnight_snack' }, 'midnight');
        expect(res.error).toBeNull();
      });

      it('service_role (Edge Function が使う経路) の 5 値の INSERT は通る', async () => {
        for (const mealType of PLANNED_MEAL_TYPES) {
          const res = await insertInto(table, srAdmin, { meal_type: mealType }, `service-${mealType}`);
          expect(res.error).toBeNull();
        }
      });

      for (const bad of ['brunch', '', 'Midnight_Snack', '夜食']) {
        it(`5 値以外 ${JSON.stringify(bad)} は拒否される (meals と planned_meals で同じ)`, async () => {
          const res = await insertInto(table, asUser(userJwt), { meal_type: bad }, 'parity-bad');
          expectMealTypeViolation(res, table);
        });
      }
    });
  }

  it('meal_type 以外の列の書き込みは、これまでどおり (memo・photo_url・eaten_at)', async () => {
    const created = await insertMeal(asUser(userJwt), { photo_url: 'https://example.invalid/a.jpg' }, 'other-columns');
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;
    const res = await asUser(userJwt)
      .from('meals')
      .update({ memo: 'メモ', photo_url: null, eaten_at: new Date().toISOString() })
      .eq('id', id);
    expect(res.error).toBeNull();
  });
});

// ---------------------------------------------------------------
// D. すでに 5 値以外の meal_type を持つ行 (本番に元からあるデータの再現)
// ---------------------------------------------------------------
/**
 * migration より前から 5 値以外の meal_type を持っていた行を作る。
 * トリガーを 1 つのトランザクションの中だけ無効にして INSERT し、有効に戻す (途中で失敗しても、まとめて取り消される)。
 */
async function plantLegacyMeal(label: string, mealType: string): Promise<{ id: string; memo: string }> {
  const id = randomUUID();
  const memo = labelOf(label);
  await pgQuery(`
    ALTER TABLE public.meals DISABLE TRIGGER ${TRIGGER};
    INSERT INTO public.meals (id, user_id, eaten_at, meal_type, memo)
    VALUES (${lit(id)}, ${lit(userId)}, now(), ${lit(mealType)}, ${lit(memo)});
    ALTER TABLE public.meals ENABLE TRIGGER ${TRIGGER};
  `);
  expect(await triggerEnabled(), 'トリガーを有効に戻せていない').toBe('O');
  return { id, memo };
}

describe('#1103 D. すでに 5 値以外の meal_type を持つ行 (本番に元からあるデータの再現)', () => {
  const LEGACY = 'brunch';
  let legacyId = '';

  beforeAll(async () => {
    legacyId = (await plantLegacyMeal('legacy', LEGACY)).id;
  }, 60_000);

  it('前提: 作った行は本当に 5 値以外の meal_type を持ち、トリガーは有効。新しく同じ値を INSERT するのは拒否される', async () => {
    expect(await readMealType('meals', legacyId)).toBe(LEGACY);
    expect(await triggerEnabled()).toBe('O');
    const res = await insertMeal(asUser(userJwt), { meal_type: LEGACY }, 'legacy-new-insert');
    expectMealTypeViolation(res, 'meals');
  });

  it('★既存の行: 本人が memo・photo_url を更新できる (meal_type は触らない)', async () => {
    const res = await asUser(userJwt)
      .from('meals')
      .update({ memo: 'メモを直した', photo_url: 'https://example.invalid/legacy.jpg' })
      .eq('id', legacyId);
    expect(res.error).toBeNull();
    expect(await readMealType('meals', legacyId)).toBe(LEGACY);
  });

  it('★既存の行: 家族へのペーストで付く paste_group_id の更新も通る (meal_type を変えない更新)', async () => {
    const res = await srAdmin.from('meals').update({ paste_group_id: randomUUID() }).eq('id', legacyId);
    expect(res.error).toBeNull();
    expect(await readMealType('meals', legacyId)).toBe(LEGACY);
  });

  it('★既存の行: 同じ meal_type で書き直しても通る (値が変わらないときは検査しない)', async () => {
    // クライアントが行全体を送り返す場合など
    const res = await asUser(userJwt)
      .from('meals')
      .update({ meal_type: LEGACY, memo: '行全体を送り返した' })
      .eq('id', legacyId);
    expect(res.error).toBeNull();
    expect(await readMealType('meals', legacyId)).toBe(LEGACY);
  });

  it('★既存の行: 5 値以外を「ほかの 5 値以外」に変える更新は拒否され、元の値が残る', async () => {
    const res = await asUser(userJwt).from('meals').update({ meal_type: 'dessert' }).eq('id', legacyId);
    expectMealTypeViolation(res, 'meals');
    expect(await readMealType('meals', legacyId)).toBe(LEGACY);
  });

  it('★既存の行: 5 値の中の値に直す更新は通る', async () => {
    const { id } = await plantLegacyMeal('legacy-fix', 'late_night');
    const res = await asUser(userJwt).from('meals').update({ meal_type: 'midnight_snack' }).eq('id', id);
    expect(res.error).toBeNull();
    expect(await readMealType('meals', id)).toBe('midnight_snack');
  });

  it('★既存の行: 本人が削除できる', async () => {
    const { id } = await plantLegacyMeal('legacy-delete', 'late_night');
    const res = await asUser(userJwt).from('meals').delete().eq('id', id);
    expect(res.error).toBeNull();
    expect(await readMealType('meals', id)).toBeNull();
  });

  it('★migration を (5 値以外の行があるまま) 流し直しても失敗せず、トリガーは有効のまま。そのあとも既存の行を更新できる', async () => {
    // CREATE OR REPLACE FUNCTION / TRIGGER のため何度流してもよい。既存の行は読まない。
    const migrationSql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), 'utf8');
    const { id } = await plantLegacyMeal('legacy-reapply', 'late_night');

    await pgQuery(migrationSql);
    await pgQuery(migrationSql);
    expect(await triggerEnabled()).toBe('O');

    expect(await readMealType('meals', id)).toBe('late_night');
    const res = await asUser(userJwt).from('meals').update({ memo: '流し直したあとも更新できる' }).eq('id', id);
    expect(res.error).toBeNull();

    // 流し直したあとも、新しい 5 値以外の書き込みは拒否される
    const bad = await asUser(userJwt).from('meals').update({ meal_type: 'dessert' }).eq('id', id);
    expectMealTypeViolation(bad, 'meals');
  });
});

// ---------------------------------------------------------------
// E. 家族へのペースト (RPC paste_meal_to_family): meals へ書く DB 関数はこれだけ
// ---------------------------------------------------------------
describe('#1103 E. 家族へのペースト (paste_meal_to_family)', () => {
  let adultId = '';
  let familyId = '';

  /** ペースト先 (大人) の meals を、service_role で読む */
  async function mealsOf(ownerId: string, memo: string) {
    const { data, error } = await srAdmin.from('meals').select('id, meal_type, paste_group_id').eq('user_id', ownerId).eq('memo', memo);
    if (error) throw new Error(`meals of ${ownerId}: ${error.message}`);
    return (data ?? []) as Array<{ id: string; meal_type: string; paste_group_id: string | null }>;
  }

  beforeAll(async () => {
    // 2 人目 (大人) を作り、1 人目 (代表者) と同じ家族にする。招待の流れは別のテストが確かめるので、service_role で直接入れる
    const email = `rls-meals-meal-type-adult-${TS}@homegohan.test`;
    const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser (adult): ${error?.message}`);
    adultId = data.user.id;
    const { error: profileError } = await srAdmin
      .from('user_profiles')
      .upsert({ id: adultId, nickname: 'meals-meal-type-adult', age_group: '30s', gender: 'other' }, { onConflict: 'id' });
    if (profileError) throw new Error(`user_profiles (adult): ${profileError.message}`);

    const { data: family, error: familyError } = await srAdmin
      .from('family_groups')
      .insert({ name: `meal-type-guard family ${TS}`, representative_id: userId })
      .select('id')
      .single();
    if (familyError || !family) throw new Error(`family_groups: ${familyError?.message}`);
    familyId = (family as { id: string }).id;
    const { error: memberError } = await srAdmin.from('family_members').insert([
      { family_id: familyId, user_id: userId, role: 'representative', status: 'active', share_meals: true },
      { family_id: familyId, user_id: adultId, role: 'adult', status: 'active', share_meals: true },
    ]);
    if (memberError) throw new Error(`family_members: ${memberError.message}`);
    // paste_meal_to_family は呼び出した人の user_profiles.family_id を見る
    const { error: familyIdError } = await srAdmin.from('user_profiles').update({ family_id: familyId }).in('id', [userId, adultId]);
    if (familyIdError) throw new Error(`user_profiles.family_id: ${familyIdError.message}`);
  }, 60_000);

  afterAll(async () => {
    // family_groups.representative_id は ON DELETE RESTRICT なので、ユーザーより先に家族を消す (family_members は連鎖)
    if (familyId) {
      await srAdmin.from('user_profiles').update({ family_id: null }).in('id', [userId, adultId].filter(Boolean));
      await srAdmin.from('membership_audit').delete().eq('scope_id', familyId);
      await srAdmin.from('family_groups').delete().eq('id', familyId);
    }
    if (adultId) {
      await srAdmin.from('meals').delete().eq('user_id', adultId);
      await srAdmin.auth.admin.deleteUser(adultId);
    }
  }, 60_000);

  for (const mealType of PLANNED_MEAL_TYPES) {
    it(`${mealType} の食事は、家族へペーストでき、コピー先にも ${mealType} が入る`, async () => {
      const source = await insertMeal(asUser(userJwt), { meal_type: mealType }, `paste-${mealType}`);
      expect(source.error).toBeNull();
      const sourceId = (source.data as { id: string }).id;
      const { data: sourceRow } = await srAdmin.from('meals').select('memo').eq('id', sourceId).single();
      const memo = (sourceRow as { memo: string }).memo;

      const res = await asUser(userJwt).rpc('paste_meal_to_family', { p_source_meal_id: sourceId, p_target_user_ids: [adultId] });
      expect(res.error).toBeNull();
      expect(typeof res.data).toBe('string');

      const copies = await mealsOf(adultId, memo);
      expect(copies).toHaveLength(1);
      expect(copies[0].meal_type).toBe(mealType);
      expect(copies[0].paste_group_id).toBe(res.data);
    });
  }

  it('★5 値以外の meal_type を持つ元の行 (本番に元からあるデータの再現) のペーストは 23514 で失敗し、コピー先に行は残らず、コピー元も変わらない', async () => {
    // 新しい行に 5 値以外を入れないための意図した変化。コピー元の行そのものは何も変わらない (RPC 全体が取り消される)
    const { id, memo } = await plantLegacyMeal('legacy-paste', 'brunch');

    const res = await asUser(userJwt).rpc('paste_meal_to_family', { p_source_meal_id: id, p_target_user_ids: [adultId] });
    expect(res.error, '5 値以外のコピー元がペーストできてしまった').not.toBeNull();
    expect(res.error!.code).toBe('23514');
    expect(res.error!.message).toContain('meals.meal_type');

    expect(await mealsOf(adultId, memo)).toHaveLength(0);
    const { data: source } = await srAdmin.from('meals').select('meal_type, paste_group_id').eq('id', id).single();
    expect(source).toEqual({ meal_type: 'brunch', paste_group_id: null });
  });
});

// ---------------------------------------------------------------
// F. ロールバック
// ---------------------------------------------------------------
describe('#1103 F. ロールバック', () => {
  it('★ロールバックで検査が外れ、もう一度 migration を流すと戻る (最後は migration 適用済みの状態)', async () => {
    const migrationSql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), 'utf8');
    const rollbackSql = fs.readFileSync(path.join(REPO_ROOT, ROLLBACK_FILE), 'utf8');

    try {
      await pgQuery(rollbackSql);
      await pgQuery(rollbackSql); // 2 回続けて流してもエラーにならない
      expect(await triggerEnabled()).toBeNull();
      const fn = await pgQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '${FUNCTION}'`,
      );
      expect(fn[0].n).toBe(0);

      // 外れている間は、この migration の前の挙動 (どんな値でも通る) に戻る。ここで入る行は afterAll で消える
      const open = await insertMeal(asUser(userJwt), { meal_type: 'brunch' }, 'after-rollback');
      expect(open.error).toBeNull();
    } finally {
      // 途中で失敗しても、共有のローカル DB を migration 適用済みの状態に戻す
      await pgQuery(migrationSql);
    }

    expect(await triggerEnabled()).toBe('O');
    const closed = await insertMeal(asUser(userJwt), { meal_type: 'brunch' }, 'after-reapply');
    expectMealTypeViolation(closed, 'meals');
  });
});
