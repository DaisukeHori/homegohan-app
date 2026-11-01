/**
 * #2189 W1: ai_action_logs の種類の制約 ai_action_logs_action_type_check (*_ai_action_logs_action_type_generate_single_meal.sql) と、
 * 提案の行の実行中の印 (pending → approved の条件つきの 1 文) の実 DB での振る舞い。
 *
 * 確かめること (I-n はこのファイルの it の番号):
 *   - I-1: 本人のクライアントで、実行の側 (src/lib/ai/consultation-action-executor.ts の case) の全部の種類の行を作れる
 *          (修正前は generate_single_meal が 23514 で作れず、自動実行も「実行する」も実行されなかった)
 *   - I-2: どの一覧にも無い種類の行は 23514 で作れない (制約が外れていない)
 *   - I-3: 実行の API の取り方 (update status=approved where id and status=pending) を同時に 2 本流すと、行を返すのは 1 本だけ
 *          (2 つの画面から同時に押しても、二重に実行しない)
 *   - I-4: 戻し口を 1 つのトランザクションで流して巻き戻す (DB には残らない): 戻したあとの制約には generate_single_meal が無い。
 *          巻き戻ったあとは、いまの制約に generate_single_meal がある
 *
 * 修正前 (migration を流す前) は I-1 (generate_single_meal) と I-4 (いまの制約) が赤になる。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-action-logs-action-type.test.ts
 * カタログと戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 * 作った行とユーザーは afterAll で消す。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { AI_ACTION_LOG_STATUS } from '@/lib/ai/consultation-action-lifecycle';
import {
  AI_ACTION_LOGS_ACTION_TYPE_CHECK,
  AI_ACTION_LOGS_ACTION_TYPE_MIGRATION_NAME,
  CHECK_VIOLATION_SQLSTATE,
  executorActionTypes,
} from '../../helpers/consultation-action-types';
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

const ROOT = path.resolve(__dirname, '../../..');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const readRollback = (): string => {
  const file = fs.readdirSync(ROLLBACKS_DIR).find((f) => f.endsWith(`_${AI_ACTION_LOGS_ACTION_TYPE_MIGRATION_NAME}.down.sql`));
  if (!file) throw new Error(`戻し口 ${AI_ACTION_LOGS_ACTION_TYPE_MIGRATION_NAME} が無い`);
  return fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf-8');
};

/** 修正で足した種類 */
const ADDED_TYPE = 'generate_single_meal';
/** どの一覧にも無い種類 */
const UNKNOWN_TYPE = 'not_a_real_action_2189';
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'AI_ACTION_LOGS_ACTION_TYPE_ROLLBACK_RESULT:';
/** 制約の定義に generate_single_meal があるかを数える SQL (1 = ある・0 = 無い) */
const ADDED_TYPE_IN_CHECK_SQL = `(SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.ai_action_logs'::regclass AND conname = '${AI_ACTION_LOGS_ACTION_TYPE_CHECK}' AND pg_get_constraintdef(oid) LIKE '%''${ADDED_TYPE}''%')`;

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
async function addedTypeCountAfterRolledBack(sql: string): Promise<number> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%;', ${ADDED_TYPE_IN_CHECK_SQL}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const rest = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  return Number(rest.slice(0, rest.indexOf(';')));
}

async function currentAddedTypeCount(): Promise<number> {
  const res = await pgRequest(`SELECT ${ADDED_TYPE_IN_CHECK_SQL} AS count;`);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  const [row] = res.body as Array<{ count: string | number }>;
  return Number(row.count);
}

// ---------------------------------------------------------------
// テストユーザー・相談・メッセージ
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const LONG = 120_000;
let userId = '';
let jwt = '';
let sessionId = '';
let messageId = '';

beforeAll(async () => {
  const email = `w1-2189-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: userId, nickname: 'w1-2189', age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  jwt = signIn.data.session.access_token;

  const db = asUser(jwt);
  const session = await db.from('ai_consultation_sessions').insert({ user_id: userId, title: 'w1-2189' }).select('id').single();
  if (session.error || !session.data) throw new Error(`session: ${session.error?.message}`);
  sessionId = session.data.id;
  const message = await db
    .from('ai_consultation_messages')
    .insert({ session_id: sessionId, role: 'assistant', content: 'w1-2189' })
    .select('id')
    .single();
  if (message.error || !message.data) throw new Error(`message: ${message.error?.message}`);
  messageId = message.data.id;
}, LONG);

afterAll(async () => {
  if (sessionId) {
    await srAdmin.from('ai_action_logs').delete().eq('session_id', sessionId);
    await srAdmin.from('ai_consultation_messages').delete().eq('session_id', sessionId);
    await srAdmin.from('ai_consultation_sessions').delete().eq('id', sessionId);
  }
  if (userId) {
    await srAdmin.from('user_profiles').delete().eq('id', userId);
    await srAdmin.auth.admin.deleteUser(userId);
  }
}, LONG);

function logRow(actionType: string, status: string = AI_ACTION_LOG_STATUS.pending) {
  return { session_id: sessionId, message_id: messageId, action_type: actionType, action_params: {}, status };
}

describe('#2189 W1 ai_action_logs の種類の制約と実行中の印', () => {
  it('I-1: 実行の側の全部の種類の行を、本人のクライアントで作れる (generate_single_meal を含む)', async () => {
    const types = executorActionTypes();
    expect(types).toContain(ADDED_TYPE);
    const db = asUser(jwt);
    const failures: Array<{ type: string; code?: string }> = [];
    for (const type of types) {
      const { error } = await db.from('ai_action_logs').insert(logRow(type, AI_ACTION_LOG_STATUS.running)).select('id').single();
      if (error) failures.push({ type, code: error.code });
    }
    expect(failures).toEqual([]);
  }, LONG);

  it('I-2: どの一覧にも無い種類の行は 23514 で作れない', async () => {
    const { error } = await asUser(jwt).from('ai_action_logs').insert(logRow(UNKNOWN_TYPE)).select('id').single();
    expect(error?.code).toBe(CHECK_VIOLATION_SQLSTATE);
  }, LONG);

  it('I-3: pending → approved の条件つきの書き換えを同時に 2 本流すと、行を返すのは 1 本だけ', async () => {
    const created = await asUser(jwt).from('ai_action_logs').insert(logRow('add_pantry_item')).select('id').single();
    expect(created.error).toBeNull();
    const id = created.data!.id as string;
    const results = await Promise.all(
      [asUser(jwt), asUser(jwt)].map((db) =>
        db
          .from('ai_action_logs')
          .update({ status: AI_ACTION_LOG_STATUS.running })
          .eq('id', id)
          .eq('status', AI_ACTION_LOG_STATUS.pending)
          .select('id')
          .maybeSingle(),
      ),
    );
    expect(results.map((r) => r.error)).toEqual([null, null]);
    expect(results.filter((r) => r.data !== null)).toHaveLength(1);
    const { data } = await srAdmin.from('ai_action_logs').select('status').eq('id', id).single();
    expect(data?.status).toBe(AI_ACTION_LOG_STATUS.running);
  }, LONG);

  it('I-4: 戻し口を流すと generate_single_meal が制約から外れる (巻き戻すので DB には残らない)', async () => {
    expect(await currentAddedTypeCount()).toBe(1);
    expect(await addedTypeCountAfterRolledBack(readRollback())).toBe(0);
    expect(await currentAddedTypeCount()).toBe(1);
  }, LONG);
});
