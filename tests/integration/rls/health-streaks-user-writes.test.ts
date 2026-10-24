/**
 * #1917: 利用者 (authenticated) が health_streaks に書ける種類を daily_record だけにする
 * (migration 20261024110000_health_streaks_user_writes_daily_record_only.sql)。
 *
 * 修正前は INSERT / UPDATE のポリシーが auth.uid() = user_id だけで streak_type を絞らず、利用者が PostgREST から
 * 自分の meal_record / breakfast の行を作り (または daily_record の行の streak_type を書き換え)、current_streak に任意の値を入れて、
 * 比較ランキングの指標 record_streak / breakfast_streak (supabase/functions/calculate-segment-stats) を操作できた。
 *
 * 確かめること:
 *   - S-1: 本人は daily_record の行を作り、書き換えられる (唯一の書き手 updateHealthStreak を利用者のセッションで流して、作る・進めるが通る)
 *   - S-2: 本人でも daily_record 以外 (meal_record・breakfast・ほかの種類) の行は作れない (42501・行はできない。upsert も同じ)
 *   - S-3: 本人でも daily_record の行の streak_type を meal_record / breakfast に書き換えられない (42501・行は変わらない)
 *   - S-4: daily_record 以外の既存の行 (service_role が作った) は、本人でも書き換えられない (0 行・値は変わらない)。
 *          読む・消すは今までどおりできる (SELECT・DELETE のポリシーは変えていない)
 *   - S-5: 他人・未認証は今までどおり書けない
 *   - S-6: service_role は今までどおり meal_record / breakfast を書ける (運営・集計の処理の口は残る)
 *   - S-7: 戻し口 (supabase/rollbacks/) を 1 つのトランザクションで流して巻き戻す (DB には残らない):
 *          INSERT・UPDATE のポリシーが種類を絞らない元の式に戻る。巻き戻ったあとの DB は本冊が当たったまま
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/health-streaks-user-writes.test.ts
 * 戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { STREAK_TYPE, updateHealthStreak } from '@/lib/health-streaks';

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

const TABLE = 'health_streaks';
/** RLS の WITH CHECK に反した書き込み・権限の無い書き込みの SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 比較ランキングの集計 (calculate-segment-stats) が読む種類。利用者は書けない */
const RANKING_STREAK_TYPES = ['meal_record', 'breakfast'] as const;
/** GET /api/health/streaks が受け付ける、ほかの種類 (書き手は無い) */
const OTHER_STREAK_TYPES = ['health_record', 'exercise_record'] as const;
/** 操作に使う連続日数 (順位を上げようとする値) */
const FORGED_STREAK = 999;
/** updateHealthStreak に渡す記録日 (連続する 2 日) */
const FIRST_RECORD_DATE = '2026-01-10';
const NEXT_RECORD_DATE = '2026-01-11';
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒) */
const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

interface TestUser {
  id: string;
  jwt: string;
}

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
let seq = 0;

async function createUser(label: string): Promise<TestUser> {
  const email = `rls-health-streaks-${label}-${RUN}-${++seq}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** service_role で、利用者のその種類の行を読む (RLS の影響を受けない) */
async function streakRow(userId: string, streakType: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(TABLE).select('*').eq('user_id', userId).eq('streak_type', streakType).maybeSingle();
  if (error) throw new Error(`read ${TABLE}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

/** service_role で行を作る (集計・運営の処理の書き方。既存の行の準備にも使う) */
async function seedRow(userId: string, streakType: string, currentStreak: number): Promise<string> {
  const { data, error } = await srAdmin
    .from(TABLE)
    .insert({ user_id: userId, streak_type: streakType, current_streak: currentStreak })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed ${TABLE} ${streakType}: ${error?.message}`);
  return data.id as string;
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
const OWN_ROLLBACK = fs.readFileSync(
  path.join(ROOT, 'supabase', 'rollbacks', '20261024110000_health_streaks_user_writes_daily_record_only.down.sql'),
  'utf-8',
);
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'HEALTH_STREAKS_ROLLBACK_RESULT:';

interface PolicyExprs {
  insertCheck: string | null;
  updateUsing: string | null;
  updateCheck: string | null;
}

/** INSERT・UPDATE のポリシーの式を、pg_policies から読む SQL (json の 1 行) */
const POLICY_EXPRS_JSON = `json_build_object(
    'insertCheck', (SELECT with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = '${TABLE}'
                      AND policyname = 'Users can insert own health streaks'),
    'updateUsing', (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = '${TABLE}'
                      AND policyname = 'Users can update own health streaks'),
    'updateCheck', (SELECT with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = '${TABLE}'
                      AND policyname = 'Users can update own health streaks')
  )`;

/** 応答の本文の中から、目印を含む文字列を探す (postgres-meta の失敗の本文の形が版で違っても拾えるように、値を順に見る) */
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

/** sql (戻し口) を流し、ポリシーの式を返す。全部が 1 つのトランザクションで、最後の例外 (結果を載せる) で巻き戻る */
async function policyExprsAfterRolledBack(sql: string): Promise<PolicyExprs> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%', ${POLICY_EXPRS_JSON}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const json = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  // 結果は入れ子の無い 1 つのオブジェクト (値は文字列か null。式に } は現れない) なので、最初の } までが結果
  return JSON.parse(json.slice(0, json.indexOf('}') + 1)) as PolicyExprs;
}

/** 式の比較用: 空白を詰める (pg_get_expr の改行・字下げの違いを見ない) */
const squash = (expr: string | null): string | null => (expr === null ? null : expr.replace(/\s+/g, ' ').trim());

let owner: TestUser;
let other: TestUser;

beforeAll(async () => {
  [owner, other] = await Promise.all([createUser('owner'), createUser('other')]);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) await srAdmin.from(TABLE).delete().in('user_id', createdUserIds);
  for (const id of createdUserIds) await srAdmin.auth.admin.deleteUser(id);
}, SETUP_TIMEOUT_MS);

describe('#1917 health_streaks: 利用者が書ける種類は daily_record だけ', () => {
  it('S-1: 唯一の書き手 updateHealthStreak を利用者のセッションで流すと、daily_record の行を作り、次の日に進められる', async () => {
    expect(STREAK_TYPE).toBe('daily_record');
    const db = asUser(owner.jwt);
    expect(await updateHealthStreak(db, owner.id, FIRST_RECORD_DATE)).toEqual({ ok: true });
    expect(await streakRow(owner.id, STREAK_TYPE)).toMatchObject({ current_streak: 1, last_activity_date: FIRST_RECORD_DATE });
    expect(await updateHealthStreak(db, owner.id, NEXT_RECORD_DATE)).toEqual({ ok: true });
    expect(await streakRow(owner.id, STREAK_TYPE)).toMatchObject({ current_streak: 2, last_activity_date: NEXT_RECORD_DATE });
  }, TEST_TIMEOUT_MS);

  it('S-2: 本人でも daily_record 以外の行は作れない (42501・行はできない。upsert も同じ)', async () => {
    const db = asUser(owner.jwt);
    for (const streakType of [...RANKING_STREAK_TYPES, ...OTHER_STREAK_TYPES]) {
      const inserted = await db.from(TABLE).insert({ user_id: owner.id, streak_type: streakType, current_streak: FORGED_STREAK });
      expect(inserted.error?.code, `${streakType} の INSERT`).toBe(INSUFFICIENT_PRIVILEGE);
      const upserted = await db
        .from(TABLE)
        .upsert({ user_id: owner.id, streak_type: streakType, current_streak: FORGED_STREAK }, { onConflict: 'user_id,streak_type' });
      expect(upserted.error?.code, `${streakType} の upsert`).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await streakRow(owner.id, streakType), `${streakType} の行`).toBeNull();
    }
  }, TEST_TIMEOUT_MS);

  it('S-3: 本人でも daily_record の行の streak_type を、比較ランキングが読む種類に書き換えられない (42501・行は変わらない)', async () => {
    const before = await streakRow(owner.id, STREAK_TYPE);
    expect(before).not.toBeNull();
    for (const streakType of RANKING_STREAK_TYPES) {
      const { error } = await asUser(owner.jwt)
        .from(TABLE)
        .update({ streak_type: streakType, current_streak: FORGED_STREAK })
        .eq('id', before!.id as string);
      expect(error?.code, `${streakType} への書き換え`).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await streakRow(owner.id, streakType)).toBeNull();
    }
    expect(await streakRow(owner.id, STREAK_TYPE)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it('S-4: daily_record 以外の既存の行は、本人でも書き換えられない (0 行・値は変わらない)。読む・消すは今までどおり', async () => {
    const db = asUser(owner.jwt);
    for (const streakType of RANKING_STREAK_TYPES) {
      const id = await seedRow(owner.id, streakType, 1);
      const before = await streakRow(owner.id, streakType);
      const updated = await db.from(TABLE).update({ current_streak: FORGED_STREAK }).eq('id', id).select('id');
      expect(updated.error).toBeNull();
      expect(updated.data).toEqual([]);
      expect(await streakRow(owner.id, streakType)).toEqual(before);

      const read = await db.from(TABLE).select('id').eq('id', id);
      expect(read.error).toBeNull();
      expect(read.data).toEqual([{ id }]);
      const deleted = await db.from(TABLE).delete().eq('id', id).select('id');
      expect(deleted.error).toBeNull();
      expect(deleted.data).toEqual([{ id }]);
      expect(await streakRow(owner.id, streakType)).toBeNull();
    }
  }, TEST_TIMEOUT_MS);

  it('S-5: 他人は本人の daily_record の行を作れず書き換えられない。未認証は作れない', async () => {
    const before = await streakRow(owner.id, STREAK_TYPE);
    const inserted = await asUser(other.jwt).from(TABLE).insert({ user_id: owner.id, streak_type: STREAK_TYPE });
    expect(inserted.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const updated = await asUser(other.jwt)
      .from(TABLE)
      .update({ current_streak: FORGED_STREAK })
      .eq('id', before!.id as string)
      .select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([]);
    const anonInsert = await anon().from(TABLE).insert({ user_id: other.id, streak_type: STREAK_TYPE });
    expect(anonInsert.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await streakRow(owner.id, STREAK_TYPE)).toEqual(before);
    expect(await streakRow(other.id, STREAK_TYPE)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('S-6: service_role は今までどおり meal_record / breakfast を作り、書き換えられる', async () => {
    for (const streakType of RANKING_STREAK_TYPES) {
      const id = await seedRow(other.id, streakType, 1);
      const { data, error } = await srAdmin.from(TABLE).update({ current_streak: 2 }).eq('id', id).select('current_streak');
      expect(error).toBeNull();
      expect(data).toEqual([{ current_streak: 2 }]);
    }
  }, TEST_TIMEOUT_MS);
});

describe('#1917 戻し口を流したときの health_streaks のポリシー (1 つのトランザクションで流して巻き戻す)', () => {
  it('S-7: 戻し口は INSERT・UPDATE のポリシーを、種類を絞らない元の式に戻す。巻き戻ったあとの DB は本冊が当たったまま', async () => {
    const ownRow = '(auth.uid() = user_id)';
    const ownDailyRecord = "((auth.uid() = user_id) AND (streak_type = 'daily_record'::text))";
    const rolledBack = await policyExprsAfterRolledBack(OWN_ROLLBACK);
    expect({
      insertCheck: squash(rolledBack.insertCheck),
      updateUsing: squash(rolledBack.updateUsing),
      updateCheck: squash(rolledBack.updateCheck),
    }).toEqual({ insertCheck: ownRow, updateUsing: ownRow, updateCheck: ownRow });

    // json の値の受け取り方 (文字列かオブジェクトか) が postgres-meta の版で違っても読めるように、文字列で返させて読む
    const [row] = await pgQuery<{ exprs: string }>(`SELECT ${POLICY_EXPRS_JSON}::text AS exprs;`);
    const now = JSON.parse(row.exprs) as PolicyExprs;
    expect({
      insertCheck: squash(now.insertCheck),
      updateUsing: squash(now.updateUsing),
      updateCheck: squash(now.updateCheck),
    }).toEqual({ insertCheck: ownDailyRecord, updateUsing: ownDailyRecord, updateCheck: ownDailyRecord });
  }, TEST_TIMEOUT_MS);
});
