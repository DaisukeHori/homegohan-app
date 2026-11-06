/**
 * #2283 判断待ち 8 の Y2: AI 相談の提案の記録 (ai_action_logs) を、利用者 (authenticated) には読むだけにし、未認証 (anon) には何も
 * 許さない migration (*_ai_action_logs_select_only.sql) の、実 DB (PostgREST) での振る舞い。
 *
 * 直接の操作の結果 (この表で固定する。R-n / S-n / C-n はこのファイルの it の番号):
 *   | 呼び出し元                 | 操作                                         | 修正前                 | 修正後                        |
 *   |----------------------------|----------------------------------------------|------------------------|-------------------------------|
 *   | 本人 (相談の持ち主)        | 自分の相談の行の SELECT (会話の GET・モバイルの読み込み直しの形) | 読める | 読める (R-1)                  |
 *   | 他人                       | 持ち主の行の SELECT                          | 0 行                   | 0 行 (R-2)                    |
 *   | 本人                       | 自分の相談の行の INSERT / UPDATE / DELETE    | 書ける                 | 42501・行は変わらない (R-3)   |
 *   | 未認証 (anon)              | SELECT / INSERT / UPDATE / DELETE            | 0 行 / 42501 / 0 行    | 42501 (R-4)                   |
 *   | service_role (サーバー)    | 作成・条件つきの書き換え (実行中の印)・書き戻し・削除 | 書ける         | 書ける (S-1)                  |
 *   | 本人                       | 自分の相談を消す (外部キーの CASCADE)        | 提案の行も消える       | 提案の行も消える (R-5)        |
 * 会話の続きの POST の自動実行と同じ手順 (service_role で行を作り、本人のセッションで実行し、service_role で確定する) は今までどおり
 * 動き、同じ作成を本人のクライアントで行うと 42501 になる (S-2)。実行の API (POST・DELETE) は
 * tests/integration/security/ai-action-execute-route-select-only-2283.test.ts が next dev に対して確かめる。
 * カタログ (C-1): ポリシーは SELECT だけの 1 本 (TO authenticated・自分の相談の行)、anon / authenticated / service_role の権限。
 * 戻し口 (C-2): 1 つのトランザクションで流して巻き戻す (DB には残らない)。流した直後は本冊の直前の形 (FOR ALL の 1 本・
 *   anon と authenticated の書き込み)、巻き戻ったあとは今の形のまま。
 *
 * 修正前 (migration を流す前) は R-3・R-4・S-2 の後半・C-1 が赤になる。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-action-logs-select-only-2283.test.ts
 * カタログと戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 * 作った行とユーザーは afterAll で消す。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ws from 'ws';
import { AI_ACTION_LOG_STATUS, aiActionLogStatusAfterRun } from '@/lib/ai/consultation-action-lifecycle';
import { writeBackAiActionLog } from '@/lib/ai/consultation-action-log-writes';
import { getAiActionLogWriter } from '@/lib/ai/ai-action-log-writer';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

// 献立生成のエンジン切り替え (#1148) はこのテストのアクション (冷蔵庫の食材の追加) に関係しないので OFF 固定 (feature_flags を読みに行かない)
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';

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

const TABLE = 'ai_action_logs';
/** 権限が無い操作 (permission denied) の SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 本冊の名前 (version を除く) */
const MIGRATION_NAME = 'ai_action_logs_select_only';
/** 本冊が作る SELECT だけのポリシー */
const OWNER_SELECT_POLICY = 'Users can view actions in own sessions';
/** 本冊が消す (戻し口が作り直す) FOR ALL のポリシー */
const OWNER_ALL_POLICY = 'Users can manage actions in own sessions';
/** pg_policy.polcmd の値 (r = SELECT・* = ALL) */
const POLCMD_SELECT = 'r';
const POLCMD_ALL = '*';
/** 自動実行の手順のログの名前 (writeBackAiActionLog の routeName) */
const AUTO_EXECUTE_ROUTE_NAME = 'tests/integration/rls/ai-action-logs-select-only-2283';

const ROOT = path.resolve(__dirname, '../../..');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const readRollback = (): string => {
  const file = fs.readdirSync(ROLLBACKS_DIR).find((f) => f.endsWith(`_${MIGRATION_NAME}.down.sql`));
  if (!file) throw new Error(`戻し口 ${MIGRATION_NAME} が無い`);
  return fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf-8');
};

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

/** 表の権限の全部 (PostgreSQL 17) */
const TABLE_PRIVILEGES = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'] as const;
const ROLES = ['anon', 'authenticated', 'service_role'] as const;
type Role = (typeof ROLES)[number];

/**
 * ai_action_logs のポリシー (名前=polcmd) と、3 つのロールの権限 (ロール:権限) を 1 つの文にする SQL。
 * 例: 'Users can view actions in own sessions=r#authenticated:SELECT,...'
 */
const STATE_SQL = `(
  (SELECT coalesce(string_agg(polname || '=' || polcmd::text, '|' ORDER BY polname), '')
     FROM pg_catalog.pg_policy WHERE polrelid = 'public.${TABLE}'::regclass)
  || '#' ||
  (SELECT coalesce(string_agg(r || ':' || p, ',' ORDER BY r, p), '')
     FROM unnest(ARRAY[${ROLES.map((r) => `'${r}'`).join(', ')}]) AS r,
          unnest(ARRAY[${TABLE_PRIVILEGES.map((p) => `'${p}'`).join(', ')}]) AS p
    WHERE pg_catalog.has_table_privilege(r, 'public.${TABLE}', p))
)`;

interface TableState {
  /** ポリシーの名前 → polcmd */
  policies: Record<string, string>;
  /** ロール → 持っている権限 (並べたもの) */
  grants: Record<Role, string[]>;
}

function parseState(text: string): TableState {
  const [policyPart, grantPart] = text.split('#');
  const policies: Record<string, string> = {};
  for (const entry of policyPart ? policyPart.split('|') : []) {
    const at = entry.lastIndexOf('=');
    policies[entry.slice(0, at)] = entry.slice(at + 1);
  }
  const grants: Record<Role, string[]> = { anon: [], authenticated: [], service_role: [] };
  for (const entry of grantPart ? grantPart.split(',') : []) {
    const [role, privilege] = entry.split(':');
    grants[role as Role].push(privilege);
  }
  for (const role of ROLES) grants[role].sort();
  return { policies, grants };
}

async function currentState(): Promise<TableState> {
  const res = await pgRequest(`SELECT ${STATE_SQL} AS state;`);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  const [row] = res.body as Array<{ state: string }>;
  return parseState(row.state);
}

/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'AI_ACTION_LOGS_SELECT_ONLY_ROLLBACK_RESULT:';

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

/** 戻し口を流し、その直後の状態を例外の文に載せて、トランザクションごと巻き戻す */
async function stateAfterRolledBack(sql: string): Promise<TableState> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%;', ${STATE_SQL}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const rest = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  return parseState(rest.slice(0, rest.indexOf(';')));
}

// ---------------------------------------------------------------
// テストユーザー・相談・メッセージ・提案の行
// ---------------------------------------------------------------
const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const LONG = 120_000;
/** 本人の書き込みが通っていないことを見つける印 */
const DIRECT = `#2283 y2 direct ${RUN}`;

interface TestUser {
  id: string;
  jwt: string;
  sessionId: string;
  messageId: string;
}

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];
let owner: TestUser;
let other: TestUser;

async function createUser(label: string): Promise<TestUser> {
  const email = `y2-2283-${label}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `y2-2283-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  const { sessionId, messageId } = await createConversation(data.user.id, label);
  return { id: data.user.id, jwt: signIn.data.session.access_token, sessionId, messageId };
}

/** service_role で相談と AI の返答のメッセージを 1 つずつ作る */
async function createConversation(userId: string, label: string): Promise<{ sessionId: string; messageId: string }> {
  const session = await srAdmin.from('ai_consultation_sessions').insert({ user_id: userId, title: `y2-2283-${label}` }).select('id').single();
  if (session.error || !session.data) throw new Error(`session ${label}: ${session.error?.message}`);
  createdSessionIds.push(session.data.id);
  const message = await srAdmin
    .from('ai_consultation_messages')
    .insert({ session_id: session.data.id, role: 'assistant', content: `y2-2283-${label}` })
    .select('id')
    .single();
  if (message.error || !message.data) throw new Error(`message ${label}: ${message.error?.message}`);
  return { sessionId: session.data.id, messageId: message.data.id };
}

function logRow(user: Pick<TestUser, 'sessionId' | 'messageId'>, status: string = AI_ACTION_LOG_STATUS.pending) {
  return { session_id: user.sessionId, message_id: user.messageId, action_type: 'add_pantry_item', action_params: { name: DIRECT }, status };
}

/** service_role で提案の行を 1 つ作り、id を返す */
async function seedLog(user: Pick<TestUser, 'sessionId' | 'messageId'>, status: string = AI_ACTION_LOG_STATUS.pending): Promise<string> {
  const { data, error } = await srAdmin.from(TABLE).insert(logRow(user, status)).select('id').single();
  if (error || !data) throw new Error(`seed ${TABLE}: ${error?.message}`);
  return (data as { id: string }).id;
}

async function rowOf(id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`${TABLE} ${id}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

beforeAll(async () => {
  owner = await createUser('owner');
  other = await createUser('other');
}, LONG);

afterAll(async () => {
  for (const sessionId of createdSessionIds) {
    await srAdmin.from(TABLE).delete().eq('session_id', sessionId);
    await srAdmin.from('ai_consultation_messages').delete().eq('session_id', sessionId);
    await srAdmin.from('ai_consultation_sessions').delete().eq('id', sessionId);
  }
  for (const userId of createdUserIds) {
    await srAdmin.from('pantry_items').delete().eq('user_id', userId);
    await srAdmin.from('user_profiles').delete().eq('id', userId);
    await srAdmin.auth.admin.deleteUser(userId);
  }
}, LONG);

describe('#2283 Y2 ai_action_logs は利用者には読むだけ (直接の操作)', () => {
  it('R-1: 本人は自分の相談の行を読める (相談と結んだ読み取り・メッセージ ID の読み取り)', async () => {
    const id = await seedLog(owner);
    const db = asUser(owner.jwt);
    const joined = await db.from(TABLE).select('id, status, ai_consultation_sessions!inner(user_id)').eq('id', id).maybeSingle();
    expect(joined.error).toBeNull();
    expect(joined.data).toMatchObject({ id, status: AI_ACTION_LOG_STATUS.pending, ai_consultation_sessions: { user_id: owner.id } });
    const byMessage = await db.from(TABLE).select('id, status').eq('message_id', owner.messageId);
    expect(byMessage.error).toBeNull();
    expect((byMessage.data ?? []).map((row) => row.id)).toContain(id);
  }, LONG);

  it('R-2: 他人は持ち主の行を読めない (0 行。エラーにはならない)', async () => {
    const id = await seedLog(owner);
    const db = asUser(other.jwt);
    const byId = await db.from(TABLE).select('id').eq('id', id);
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual([]);
    const bySession = await db.from(TABLE).select('id').eq('session_id', owner.sessionId);
    expect(bySession.error).toBeNull();
    expect(bySession.data).toEqual([]);
  }, LONG);

  it('R-3: 本人は自分の相談の行を INSERT / UPDATE / DELETE できない (42501・行は変わらない)', async () => {
    const db = asUser(owner.jwt);
    const directName = `${DIRECT} r3`;
    const inserted = await db
      .from(TABLE)
      .insert({ ...logRow(owner, AI_ACTION_LOG_STATUS.executed), action_params: { name: directName } })
      .select('id');
    expect(inserted.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const { data: directRows, error: directError } = await srAdmin.from(TABLE).select('id').eq('action_params->>name', directName);
    expect(directError).toBeNull();
    expect(directRows).toEqual([]);

    const id = await seedLog(owner);
    const before = await rowOf(id);
    const updated = await db.from(TABLE).update({ status: AI_ACTION_LOG_STATUS.executed, result: { note: DIRECT } }).eq('id', id).select('id');
    expect(updated.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const deleted = await db.from(TABLE).delete().eq('id', id).select('id');
    expect(deleted.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowOf(id)).toEqual(before);
  }, LONG);

  it('R-4: 未認証 (anon) は読めず書けない (42501・行は変わらない)', async () => {
    const id = await seedLog(owner);
    const before = await rowOf(id);
    const db = anon();
    const selected = await db.from(TABLE).select('id').eq('id', id);
    expect(selected.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const inserted = await db.from(TABLE).insert(logRow(owner)).select('id');
    expect(inserted.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const updated = await db.from(TABLE).update({ status: AI_ACTION_LOG_STATUS.executed }).eq('id', id).select('id');
    expect(updated.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const deleted = await db.from(TABLE).delete().eq('id', id).select('id');
    expect(deleted.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowOf(id)).toEqual(before);
  }, LONG);

  it('R-5: 本人が自分の相談を消すと、提案の行も一緒に消える (外部キーの CASCADE は利用者の権限に依らない)', async () => {
    const conversation = await createConversation(owner.id, 'cascade');
    const id = await seedLog(conversation);
    const deleted = await asUser(owner.jwt).from('ai_consultation_sessions').delete().eq('id', conversation.sessionId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id: conversation.sessionId }]);
    expect(await rowOf(id)).toBeNull();
  }, LONG);
});

describe('#2283 Y2 サーバー (service_role) の書き込みは今までどおり', () => {
  it('S-1: service_role は作成・条件つきの書き換え (pending → 実行中の印)・書き戻し・削除ができる', async () => {
    const created = await srAdmin.from(TABLE).insert(logRow(owner)).select('id').single();
    expect(created.error).toBeNull();
    const id = created.data!.id as string;
    // 実行の API の取り方 (pending のときだけ実行中の印にする 1 文)。2 本同時に流しても行を返すのは 1 本だけ
    const claims = await Promise.all(
      [srAdmin, client(serviceKey)].map((db) =>
        db.from(TABLE).update({ status: AI_ACTION_LOG_STATUS.running }).eq('id', id).eq('status', AI_ACTION_LOG_STATUS.pending).select('id').maybeSingle(),
      ),
    );
    expect(claims.map((r) => r.error)).toEqual([null, null]);
    expect(claims.filter((r) => r.data !== null)).toHaveLength(1);
    // 書き戻し (route と同じ関数・同じ書き手)
    const { error: writeBackError } = await writeBackAiActionLog(
      getAiActionLogWriter(),
      AUTO_EXECUTE_ROUTE_NAME,
      { userId: owner.id, actionLogId: id, actionType: 'add_pantry_item' },
      { status: AI_ACTION_LOG_STATUS.executed, result: { created: true }, executed_at: new Date().toISOString() },
    );
    expect(writeBackError).toBeNull();
    expect(await rowOf(id)).toMatchObject({ status: AI_ACTION_LOG_STATUS.executed, result: { created: true } });
    // 却下の書き方 (DELETE /execute)
    const rejectedId = await seedLog(owner);
    const rejected = await getAiActionLogWriter().from(TABLE).update({ status: AI_ACTION_LOG_STATUS.rejected }).eq('id', rejectedId);
    expect(rejected.error).toBeNull();
    expect(await rowOf(rejectedId)).toMatchObject({ status: AI_ACTION_LOG_STATUS.rejected });
    // 削除
    const deleted = await srAdmin.from(TABLE).delete().eq('id', id).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id }]);
  }, LONG);

  it('S-2: 会話の続きの POST の自動実行と同じ手順 (service_role で作る → 本人のセッションで実行 → service_role で確定) が動く。本人のクライアントでは作れない', async () => {
    const actionType = 'add_pantry_item';
    const actionParams = { name: `${DIRECT} auto` };
    const actionLogDb = getAiActionLogWriter();
    const { data: actionLog, error: insertError } = await actionLogDb
      .from(TABLE)
      .insert({ session_id: owner.sessionId, message_id: owner.messageId, action_type: actionType, action_params: actionParams, status: AI_ACTION_LOG_STATUS.running })
      .select('id')
      .single();
    expect(insertError).toBeNull();
    const actionLogId = (actionLog as { id: string }).id;
    const executionResult = await runConsultationAction(asUser(owner.jwt), { id: owner.id }, {
      id: actionLogId,
      action_type: actionType,
      action_params: actionParams,
      ai_consultation_sessions: { user_id: owner.id },
    });
    expect(executionResult.success).toBe(true);
    const status = aiActionLogStatusAfterRun(actionType, executionResult);
    expect(status).toBe(AI_ACTION_LOG_STATUS.executed);
    const { error: finalizeError } = await writeBackAiActionLog(
      actionLogDb,
      AUTO_EXECUTE_ROUTE_NAME,
      { userId: owner.id, actionLogId, actionType },
      { status, result: executionResult.result, executed_at: new Date().toISOString() },
    );
    expect(finalizeError).toBeNull();
    expect(await rowOf(actionLogId)).toMatchObject({ status: AI_ACTION_LOG_STATUS.executed, result: { created: true } });
    const { data: pantry } = await srAdmin.from('pantry_items').select('id').eq('user_id', owner.id).eq('name', actionParams.name);
    expect(pantry).toHaveLength(1);
    // 本人は自分の行を読み直せる (会話の GET・モバイルの読み込み直し)
    const reread = await asUser(owner.jwt).from(TABLE).select('status').eq('id', actionLogId).maybeSingle();
    expect(reread.data).toEqual({ status: AI_ACTION_LOG_STATUS.executed });

    // Y1 より前の形 (本人のクライアントで作る) は、権限で拒まれる
    const direct = await asUser(owner.jwt)
      .from(TABLE)
      .insert({ session_id: owner.sessionId, message_id: owner.messageId, action_type: actionType, action_params: actionParams, status: AI_ACTION_LOG_STATUS.running })
      .select('id');
    expect(direct.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  }, LONG);
});

describe('#2283 Y2 カタログと戻し口', () => {
  it('C-1: ポリシーは SELECT だけの 1 本 (TO authenticated・自分の相談の行)。anon は権限なし・authenticated は書き込みなし・service_role は書ける', async () => {
    const state = await currentState();
    expect(state.policies).toEqual({ [OWNER_SELECT_POLICY]: POLCMD_SELECT });
    expect(state.grants.anon).toEqual([]);
    expect(state.grants.authenticated).toEqual(['MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER']);
    expect(state.grants.service_role).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']));

    const res = await pgRequest(`
SELECT polroles::regrole[]::text AS roles, pg_get_expr(polqual, polrelid) AS using_expr, polwithcheck IS NULL AS no_with_check
  FROM pg_catalog.pg_policy WHERE polrelid = 'public.${TABLE}'::regclass AND polname = '${OWNER_SELECT_POLICY}';`);
    expect(res.ok, JSON.stringify(res.body)).toBe(true);
    const [policy] = res.body as Array<{ roles: string; using_expr: string; no_with_check: boolean }>;
    expect(policy.roles).toBe('{authenticated}');
    expect(policy.using_expr).toContain('ai_consultation_sessions.id = ai_action_logs.session_id');
    expect(policy.using_expr).toContain('ai_consultation_sessions.user_id = auth.uid()');
    expect(policy.no_with_check).toBe(true);

    const rls = await pgRequest(`SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.${TABLE}'::regclass;`);
    expect(rls.body).toEqual([{ relrowsecurity: true }]);
  }, LONG);

  it('C-2: 戻し口を流すと本冊の直前の形 (FOR ALL の 1 本・anon と authenticated の書き込み) に戻る (巻き戻すので DB には残らない)', async () => {
    const current = await currentState();
    const restored = await stateAfterRolledBack(readRollback());
    expect(restored.policies).toEqual({ [OWNER_ALL_POLICY]: POLCMD_ALL });
    const userGrantsBefore = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'UPDATE'];
    expect(restored.grants.anon).toEqual(userGrantsBefore);
    expect(restored.grants.authenticated).toEqual(userGrantsBefore);
    expect(restored.grants.service_role).toEqual(current.grants.service_role);
    // 巻き戻ったあとは今の形のまま
    expect(await currentState()).toEqual(current);
  }, LONG);
});
