/**
 * #2283 V2: AI 相談 (ai_consultation_sessions) の状態の制約 ai_consultation_sessions_status_check
 * (*_ai_consultation_sessions_status_closed.sql) の実 DB での振る舞い。
 *
 * 確かめること (I-n はこのファイルの it の番号):
 *   - I-1: 本人のクライアントで、閉じる route と同じ書き換え (update status = 'closed' where id) ができる。
 *          閉じた相談は、要約の引き継ぎと同じ読み取り (.eq('status', 'closed')) で読める
 *          (修正前は 23514 で書き換えられず、閉じる route は 500 を返していた)
 *   - I-2: 今までの状態 (active・completed・archived) も、本人のクライアントで書ける (今までの値を消していない)。
 *          状態を渡さずに作った行は既定値の active になる
 *   - I-3: どの一覧にも無い状態は、作るときも書き換えるときも 23514 で拒む (制約が外れていない)
 *   - I-4: 戻し口を 1 つのトランザクションで流して巻き戻す (DB には残らない): 戻したあとの制約には closed が無い。
 *          巻き戻ったあとは、いまの制約に closed がある
 *
 * 修正前 (migration を流す前) は I-1 と I-4 (いまの制約) が赤になる。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-consultation-sessions-status-closed.test.ts
 * カタログと戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 * 作った行とユーザーは afterAll で消す。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { CHECK_VIOLATION_SQLSTATE } from '../../helpers/consultation-action-types';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

/** 状態の制約の名前 */
const STATUS_CHECK = 'ai_consultation_sessions_status_check';
/** closed を制約に足した migration の名前 (版の番号を除く) */
const MIGRATION_NAME = 'ai_consultation_sessions_status_closed';

const ROOT = path.resolve(__dirname, '../../..');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const readRollback = (): string => {
  const file = fs.readdirSync(ROLLBACKS_DIR).find((f) => f.endsWith(`_${MIGRATION_NAME}.down.sql`));
  if (!file) throw new Error(`戻し口 ${MIGRATION_NAME} が無い`);
  return fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf-8');
};

/** 修正で足した状態 (閉じる route が書く値) */
const ADDED_STATUS = 'closed';
/** 列の既定値 */
const DEFAULT_STATUS = 'active';
/** 今までの状態 (修正前の制約の一覧) */
const PREVIOUS_STATUSES = ['active', 'completed', 'archived'] as const;
/** どの一覧にも無い状態 */
const UNKNOWN_STATUS = 'not_a_real_status_2283';
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'AI_CONSULTATION_SESSIONS_STATUS_ROLLBACK_RESULT:';
/** 制約の定義に closed があるかを数える SQL (1 = ある・0 = 無い) */
const ADDED_STATUS_IN_CHECK_SQL = `(SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.ai_consultation_sessions'::regclass AND conname = '${STATUS_CHECK}' AND pg_get_constraintdef(oid) LIKE '%''${ADDED_STATUS}''%')`;

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

/** 戻し口を流し、その直後の数を例外の文に載せて、トランザクションごと巻き戻す */
async function addedStatusCountAfterRolledBack(sql: string): Promise<number> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%;', ${ADDED_STATUS_IN_CHECK_SQL}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const rest = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  return Number(rest.slice(0, rest.indexOf(';')));
}

async function currentAddedStatusCount(): Promise<number> {
  const res = await pgRequest(`SELECT ${ADDED_STATUS_IN_CHECK_SQL} AS count;`);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  const [row] = res.body as Array<{ count: string | number }>;
  return Number(row.count);
}

// ---------------------------------------------------------------
// テストユーザー
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const LONG = 120_000;
const TITLE = `v2-2283-${TS}`;
let userId = '';
let jwt = '';

beforeAll(async () => {
  const email = `v2-2283-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: userId, nickname: 'v2-2283', age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  jwt = signIn.data.session.access_token;
}, LONG);

afterAll(async () => {
  if (userId) {
    await srAdmin.from('ai_consultation_sessions').delete().eq('user_id', userId);
    await srAdmin.from('user_profiles').delete().eq('id', userId);
    await srAdmin.auth.admin.deleteUser(userId);
  }
}, LONG);

/** 本人のクライアントで、状態を渡さずに相談を作る (作成の route と同じ形)。作った行の id と状態を返す */
async function createSession(): Promise<{ id: string; status: string }> {
  const { data, error } = await asUser(jwt)
    .from('ai_consultation_sessions')
    .insert({ user_id: userId, title: TITLE })
    .select('id, status')
    .single();
  if (error || !data) throw new Error(`session: ${error?.message}`);
  return { id: data.id as string, status: data.status as string };
}

describe('#2283 V2 ai_consultation_sessions の状態の制約', () => {
  it('I-1: 閉じる route と同じ書き換えで closed にでき、要約の引き継ぎと同じ読み取りで読める', async () => {
    const created = await createSession();
    const db = asUser(jwt);
    const closed = await db
      .from('ai_consultation_sessions')
      .update({ status: ADDED_STATUS, updated_at: new Date().toISOString() })
      .eq('id', created.id)
      .select('status')
      .single();
    expect(closed.error).toBeNull();
    expect(closed.data?.status).toBe(ADDED_STATUS);

    const past = await db.from('ai_consultation_sessions').select('id').eq('user_id', userId).eq('status', ADDED_STATUS);
    expect(past.error).toBeNull();
    expect((past.data ?? []).map((row) => row.id)).toContain(created.id);
  }, LONG);

  it('I-2: 今までの状態 (active・completed・archived) も書ける。状態を渡さずに作った行は active', async () => {
    const created = await createSession();
    expect(created.status).toBe(DEFAULT_STATUS);
    const db = asUser(jwt);
    const failures: Array<{ status: string; code?: string }> = [];
    for (const status of PREVIOUS_STATUSES) {
      const inserted = await db.from('ai_consultation_sessions').insert({ user_id: userId, title: TITLE, status }).select('status').single();
      if (inserted.error || inserted.data?.status !== status) failures.push({ status, code: inserted.error?.code });
      const updated = await db.from('ai_consultation_sessions').update({ status }).eq('id', created.id).select('status').single();
      if (updated.error || updated.data?.status !== status) failures.push({ status, code: updated.error?.code });
    }
    expect(failures).toEqual([]);
  }, LONG);

  it('I-3: どの一覧にも無い状態は、作るときも書き換えるときも 23514 で拒む', async () => {
    const db = asUser(jwt);
    const inserted = await db
      .from('ai_consultation_sessions')
      .insert({ user_id: userId, title: TITLE, status: UNKNOWN_STATUS })
      .select('id')
      .single();
    expect(inserted.error?.code).toBe(CHECK_VIOLATION_SQLSTATE);

    const created = await createSession();
    const updated = await db.from('ai_consultation_sessions').update({ status: UNKNOWN_STATUS }).eq('id', created.id).select('id').single();
    expect(updated.error?.code).toBe(CHECK_VIOLATION_SQLSTATE);
    const { data } = await srAdmin.from('ai_consultation_sessions').select('status').eq('id', created.id).single();
    expect(data?.status).toBe(DEFAULT_STATUS);
  }, LONG);

  it('I-4: 戻し口を流すと closed が制約から外れる (巻き戻すので DB には残らない)', async () => {
    expect(await currentAddedStatusCount()).toBe(1);
    expect(await addedStatusCountAfterRolledBack(readRollback())).toBe(0);
    expect(await currentAddedStatusCount()).toBe(1);
  }, LONG);
});
