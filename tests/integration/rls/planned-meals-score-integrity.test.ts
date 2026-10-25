/**
 * #2025: planned_meals の 3 列 (is_completed / completed_at / veg_score) をサーバの計算値だけにする。完了は RPC
 * planned_meals_set_completed だけにする (migration 20261025130000_planned_meals_set_completed_rpc.sql)。
 * 設計: docs/design/cross/23-planned-meals-score-integrity.md §7.20
 *
 * 修正前は RLS "Users can manage own planned meals" (FOR ALL) と表の INSERT / UPDATE の権限で、利用者が PostgREST から
 * 自分の行の veg_score / is_completed に任意の値を入れ、比較ランキング (veg_score_avg / breakfast_rate) と組織のチャレンジの
 * veg_score を操作できた。
 *
 * 段 A (設計書 §15) の分だけを置く: RPC の it (I-1〜I-4・I-8) と RPC の戻し口 (I-13)。
 * 段 B で I-10・I-11・I-14・I-15、段 C で 3 列の it (I-5〜I-7・I-9) と権限の戻し口 (I-12) を足す。
 *
 * 確かめること (I-n はこのファイルの it の番号。括弧の S-n は設計書 §0.3 のシナリオ):
 *   - I-1 (S-1・S-3): 本人は RPC で自分の献立を完了にできる。completed_at は DB の時刻 (呼ぶ前後の時刻の間)。updated_at が進む
 *   - I-2 (S-2・S-24): もう一度 RPC で完了にしても completed_at は変わらない。未完了にすると NULL
 *   - I-3 (S-20): 他人の献立の id・無い id は RPC が PLANNED_MEAL_NOT_FOUND (P0002)。行は変わらない
 *   - I-4 (S-19): 未認証 (anon) は RPC を実行できない (42501)
 *   - I-8 (S-25): service_role は今までどおり 3 列を読み書きできる (集計・献立の生成の口は残る)
 *   - I-13 (S-23): RPC の戻し口を 1 つのトランザクションで流して巻き戻す: 関数が消え、planned_meals の列の権限は変わらない。
 *          巻き戻ったあとの DB は関数があるまま
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/planned-meals-score-integrity.test.ts
 * 戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import {
  PLANNED_MEALS_SET_COMPLETED_RPC,
  PLANNED_MEAL_NOT_FOUND_CODE,
  PLANNED_MEAL_NOT_FOUND_SQLSTATE,
  plannedMealsSetCompletedArgs,
} from '@homegohan/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
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

const TABLE = 'planned_meals';
/** 権限の無い書き込み・RLS の WITH CHECK に反した書き込みの SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** service_role が書く野菜スコア (正本の尺度の中の値) */
const SERVER_VEG_SCORE = 80;
/** 献立の日 (JST の暦日。集計の対象かどうかはここでは見ない) */
const DAY_DATE = '2026-01-10';
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒) */
const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;
/** DB の時刻と Node の時刻の差として許す幅 (ミリ秒) */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

interface TestUser {
  id: string;
  jwt: string;
  /** サインイン済みの利用者の client (auth.getUser() が本人を返す) */
  session: SupabaseClient;
}

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
let seq = 0;

async function createUser(label: string): Promise<TestUser> {
  const email = `rls-pm-score-${label}-${RUN}-${++seq}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const session = anon();
  const signIn = await session.auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token, session };
}

/** service_role で user_daily_meals の 1 日を作る */
async function seedDay(userId: string, dayDate: string = DAY_DATE): Promise<string> {
  const { data, error } = await srAdmin.from('user_daily_meals').insert({ user_id: userId, day_date: dayDate }).select('id').single();
  if (error || !data) throw new Error(`seed user_daily_meals: ${error?.message}`);
  return data.id as string;
}

/** service_role で献立の行を作る (3 列は既定のまま) */
async function seedMeal(dailyMealId: string, label: string): Promise<string> {
  const { data, error } = await srAdmin
    .from(TABLE)
    .insert({ daily_meal_id: dailyMealId, meal_type: 'lunch', dish_name: `it2025-${label}` })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed ${TABLE} ${label}: ${error?.message}`);
  return data.id as string;
}

/** service_role で行を読む (RLS と列の権限の影響を受けない) */
async function mealRow(id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(TABLE).select('id, dish_name, is_completed, completed_at, veg_score, updated_at').eq('id', id).maybeSingle();
  if (error) throw new Error(`read ${TABLE}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

const ROOT = path.resolve(__dirname, '../../..');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const readRollback = (name: string): string => {
  const file = fs.readdirSync(ROLLBACKS_DIR).find((f) => f.endsWith(`_${name}.down.sql`));
  if (!file) throw new Error(`戻し口 ${name} が無い`);
  return fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf-8');
};
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'PLANNED_MEALS_SCORE_ROLLBACK_RESULT:';

/** authenticated の planned_meals の列ごとの権限・anon / authenticated の表の権限・RPC の有無を json の 1 行で読む SQL */
const STATE_JSON = `json_build_object(
    'authUpdatable', (SELECT coalesce(json_agg(column_name::text ORDER BY column_name), '[]'::json) FROM information_schema.column_privileges
                        WHERE table_schema = 'public' AND table_name = '${TABLE}' AND grantee = 'authenticated' AND privilege_type = 'UPDATE'),
    'tableGrants', (SELECT coalesce(json_agg((grantee || ':' || privilege_type)::text ORDER BY grantee, privilege_type), '[]'::json)
                      FROM information_schema.table_privileges
                     WHERE table_schema = 'public' AND table_name = '${TABLE}' AND grantee IN ('anon', 'authenticated')),
    'rpcExists', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '${PLANNED_MEALS_SET_COMPLETED_RPC}')
  )`;

interface DbState {
  authUpdatable: string[];
  /** '<grantee>:<privilege_type>' (例 'authenticated:INSERT') */
  tableGrants: string[];
  rpcExists: number;
}

function findMarkedText(body: unknown): string | null {
  if (typeof body === 'string') return body.includes(ROLLBACK_RESULT_MARKER) ? body : null;
  if (body && typeof body === 'object') {
    for (const value of Object.values(body as Record<string, unknown>)) {
      const found = findMarkedText(value);
      if (found) return found;
    }
  }
  return null;
}

/** sql (戻し口) を流し、状態を返す。全部が 1 つのトランザクションで、最後の例外 (結果を載せる) で巻き戻る */
async function stateAfterRolledBack(sql: string): Promise<DbState> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%', ${STATE_JSON}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const json = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  // 結果は 1 段の配列を持つ 1 つのオブジェクト。最後の } までが結果
  return JSON.parse(json.slice(0, json.lastIndexOf('}') + 1)) as DbState;
}

async function currentState(): Promise<DbState> {
  const [row] = await pgQuery<{ state: string }>(`SELECT ${STATE_JSON}::text AS state;`);
  return JSON.parse(row.state) as DbState;
}

let owner: TestUser;
let other: TestUser;
let ownerDayId: string;
let otherDayId: string;
let ownerMealId: string;
let otherMealId: string;

beforeAll(async () => {
  [owner, other] = await Promise.all([createUser('owner'), createUser('other')]);
  [ownerDayId, otherDayId] = await Promise.all([seedDay(owner.id), seedDay(other.id)]);
  [ownerMealId, otherMealId] = await Promise.all([seedMeal(ownerDayId, 'owner'), seedMeal(otherDayId, 'other')]);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) await srAdmin.from('user_daily_meals').delete().in('user_id', createdUserIds);
  for (const id of createdUserIds) await srAdmin.auth.admin.deleteUser(id);
}, SETUP_TIMEOUT_MS);

describe('#2025 planned_meals: 完了は RPC だけ', () => {
  it('I-1 (S-1・S-3): 本人は RPC で自分の献立を完了にでき、completed_at は DB の時刻、updated_at が進む', async () => {
    const before = await mealRow(ownerMealId);
    const from = Date.now();
    const { data, error } = await asUser(owner.jwt).rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs(ownerMealId, true));
    const to = Date.now();
    expect(error).toBeNull();
    const rows = (Array.isArray(data) ? data : [data]) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ownerMealId, is_completed: true });
    const completedAt = Date.parse(String(rows[0].completed_at));
    // DB と Node の時計の差を CLOCK_SKEW_TOLERANCE_MS まで許す
    expect(completedAt).toBeGreaterThanOrEqual(from - CLOCK_SKEW_TOLERANCE_MS);
    expect(completedAt).toBeLessThanOrEqual(to + CLOCK_SKEW_TOLERANCE_MS);
    const after = await mealRow(ownerMealId);
    expect(after).toMatchObject({ is_completed: true, completed_at: rows[0].completed_at });
    expect(Date.parse(String(after!.updated_at))).toBeGreaterThanOrEqual(Date.parse(String(before!.updated_at)));
  }, TEST_TIMEOUT_MS);

  it('I-2 (S-2・S-24): もう一度完了にしても completed_at は変わらない。未完了にすると NULL', async () => {
    const first = await mealRow(ownerMealId);
    const again = await asUser(owner.jwt).rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs(ownerMealId, true));
    expect(again.error).toBeNull();
    expect(await mealRow(ownerMealId)).toMatchObject({ is_completed: true, completed_at: first!.completed_at });
    const undone = await asUser(owner.jwt).rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs(ownerMealId, false));
    expect(undone.error).toBeNull();
    expect(await mealRow(ownerMealId)).toMatchObject({ is_completed: false, completed_at: null });
  }, TEST_TIMEOUT_MS);

  it('I-3 (S-20): 他人の献立・無い id は PLANNED_MEAL_NOT_FOUND (P0002)。行は変わらない', async () => {
    const before = await mealRow(otherMealId);
    const foreign = await asUser(owner.jwt).rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs(otherMealId, true));
    expect(foreign.error?.code).toBe(PLANNED_MEAL_NOT_FOUND_SQLSTATE);
    expect(foreign.error?.message).toContain(PLANNED_MEAL_NOT_FOUND_CODE);
    expect(await mealRow(otherMealId)).toEqual(before);
    const missing = await asUser(owner.jwt).rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs('00000000-0000-4000-8000-000000000000', true));
    expect(missing.error?.code).toBe(PLANNED_MEAL_NOT_FOUND_SQLSTATE);
  }, TEST_TIMEOUT_MS);

  it('I-4 (S-19): 未認証 (anon) は RPC を実行できない (42501)', async () => {
    const { error } = await anon().rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs(ownerMealId, true));
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await mealRow(ownerMealId)).toMatchObject({ is_completed: false });
  }, TEST_TIMEOUT_MS);
});

describe('#2025 planned_meals: サーバの書き手 (service_role) の口は残る', () => {
  it('I-8 (S-25): service_role は今までどおり 3 列を読み書きできる', async () => {
    const { data, error } = await srAdmin
      .from(TABLE)
      .update({ veg_score: SERVER_VEG_SCORE, is_completed: true, completed_at: '2026-01-10T03:00:00Z' })
      .eq('id', otherMealId)
      .select('veg_score, is_completed');
    expect(error).toBeNull();
    expect(data).toEqual([{ veg_score: SERVER_VEG_SCORE, is_completed: true }]);
    const inserted = await srAdmin.from(TABLE).insert({ daily_meal_id: otherDayId, meal_type: 'breakfast', dish_name: 'it2025-sr', is_completed: false }).select('id');
    expect(inserted.error).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('#2025 戻し口を流したときの状態 (1 つのトランザクションで流して巻き戻す)', () => {
  it('I-13 (S-23): RPC の戻し口で関数が消え、planned_meals の列の権限は変わらない。巻き戻ったあとの DB は関数があるまま', async () => {
    const before = await currentState();
    const after = await stateAfterRolledBack(readRollback('planned_meals_set_completed_rpc'));
    expect(after.rpcExists).toBe(0);
    expect(after.authUpdatable).toEqual(before.authUpdatable);
    expect(after.tableGrants).toEqual(before.tableGrants);

    expect((await currentState()).rpcExists).toBe(1);
  }, TEST_TIMEOUT_MS);
});
