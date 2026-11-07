/**
 * #2299 の B の前段 W2a: AI 相談の提案の記録 (ai_action_logs) に、実行の印 (approved) を付けたリクエストごとの token の列
 * claim_token を足す migration (*_ai_action_logs_claim_token.sql) の、実 DB (PostgREST) での振る舞い。
 *
 * 確かめること (K-n はこのファイルの it の番号):
 *   | 呼び出し元              | 操作                                                     | 期待                              |
 *   |-------------------------|----------------------------------------------------------|-----------------------------------|
 *   | カタログ                | 列の型・NULL 可・既定値・コメント                         | uuid・NULL 可・既定値なし (K-1)   |
 *   | service_role (サーバー) | claim_token を付けずに作る (今までのアプリの作り方)       | NULL のまま (K-2)                 |
 *   | service_role            | claim_token を書く・claim_token で絞った条件つきの書き換え | 自分の token だけ当たる (K-2)     |
 *   | 本人 (相談の持ち主)     | claim_token を読む                                       | 読める (K-3)                      |
 *   | 本人                    | claim_token の UPDATE・claim_token つきの INSERT          | 42501・行は変わらない (K-3)       |
 *   | 未認証 (anon)           | claim_token の SELECT・UPDATE                             | 42501 (K-4)                       |
 *   | 戻し口                  | 1 つのトランザクションで流して巻き戻す                    | 流した直後は列が無い・巻き戻ったあとは列がある (K-5) |
 *   | アプリの書き戻し (W2b)  | 2 つの token で ABA の順 (A の 1 回目が書けたのに応答を失う → B が印を取る → A の 2 回目) | A の 2 回目は 0 行・B の行は上書きされず、B の書き戻しが当たる (K-6) |
 * 権限とポリシーそのもの (SELECT だけの 1 本・anon は権限なし) は tests/integration/rls/ai-action-logs-select-only-2283.test.ts が見る。
 * claim_token を claim のときに書き、書き戻しを claim_token で絞るアプリの側は後段の W2b (K-6 は、その書き戻しの関数
 * writeBackAiActionLog を、route と同じ書き手 getAiActionLogWriter で流す)。
 *
 * 修正前 (migration を流す前) は K-1・K-2・K-3 の読み取り・K-5 が赤になる (列が無い)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-action-logs-claim-token-2299.test.ts
 * カタログと戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 * 作った行とユーザーは afterAll で消す。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { AI_ACTION_LOG_STATUS } from '@/lib/ai/consultation-action-lifecycle';
import { type AiActionLogWriter, newAiActionLogClaimToken, writeBackAiActionLog } from '@/lib/ai/consultation-action-log-writes';
import { getAiActionLogWriter } from '@/lib/ai/ai-action-log-writer';
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

const TABLE = 'ai_action_logs';
const COLUMN = 'claim_token';
/** 権限が無い操作 (permission denied) の SQLSTATE */
const INSUFFICIENT_PRIVILEGE = '42501';
/** 本冊の名前 (version を除く) */
const MIGRATION_NAME = 'ai_action_logs_claim_token';
/** 本冊が付ける列のコメント (migration の COMMENT ON COLUMN と同じ文) */
const COLUMN_COMMENT =
  '実行の印 (approved) を付けたリクエストごとの token。書き戻しはこの token で絞り、別のリクエストの印を上書きしない (#2299)。';

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

/** claim_token の列が (落とされずに) あるかを 'yes' / 'no' で返す SQL の式 */
const COLUMN_EXISTS_SQL = `(CASE WHEN EXISTS (
  SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.${TABLE}'::regclass AND attname = '${COLUMN}' AND NOT attisdropped
) THEN 'yes' ELSE 'no' END)`;

/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'AI_ACTION_LOGS_CLAIM_TOKEN_ROLLBACK_RESULT:';

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

/** 戻し口を流し、その直後に列があるか ('yes' / 'no') を例外の文に載せて、トランザクションごと巻き戻す */
async function columnExistsAfterRolledBack(sql: string): Promise<string> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%;', ${COLUMN_EXISTS_SQL};
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const rest = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  return rest.slice(0, rest.indexOf(';'));
}

async function columnExistsNow(): Promise<string> {
  const res = await pgRequest(`SELECT ${COLUMN_EXISTS_SQL} AS present;`);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  const [row] = res.body as Array<{ present: string }>;
  return row.present;
}

// ---------------------------------------------------------------
// テストユーザー・相談・メッセージ・提案の行
// ---------------------------------------------------------------
const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const LONG = 120_000;
/** この実行で作った行の印 */
const MARK = `#2299 w2a ${RUN}`;

interface TestUser {
  id: string;
  jwt: string;
  sessionId: string;
  messageId: string;
}

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];
let owner: TestUser;

async function createUser(label: string): Promise<TestUser> {
  const email = `w2a-2299-${label}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `w2a-2299-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);

  const session = await srAdmin.from('ai_consultation_sessions').insert({ user_id: data.user.id, title: `w2a-2299-${label}` }).select('id').single();
  if (session.error || !session.data) throw new Error(`session ${label}: ${session.error?.message}`);
  createdSessionIds.push(session.data.id);
  const message = await srAdmin
    .from('ai_consultation_messages')
    .insert({ session_id: session.data.id, role: 'assistant', content: `w2a-2299-${label}` })
    .select('id')
    .single();
  if (message.error || !message.data) throw new Error(`message ${label}: ${message.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token, sessionId: session.data.id, messageId: message.data.id };
}

function logRow(user: Pick<TestUser, 'sessionId' | 'messageId'>, status: string = AI_ACTION_LOG_STATUS.pending) {
  return { session_id: user.sessionId, message_id: user.messageId, action_type: 'add_pantry_item', action_params: { name: MARK }, status };
}

/** service_role で提案の行を 1 つ作り、id を返す (claim_token は付けない = 今までのアプリの作り方) */
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

/** K-6 の書き戻しのログの名前 (writeBackAiActionLog の routeName) */
const WRITE_BACK_ROUTE_NAME = 'tests/integration/rls/ai-action-logs-claim-token-2299';
/** 応答を失った (DB には書けたのに接続が切れた) ときに返す、偽の error */
const LOST_RESPONSE_ERROR = { message: 'response lost after the write (test)', code: 'XX000' };

/** 書き戻しの問い合わせの形 (update のあとの eq / select / maybeSingle だけを中継する) */
interface WriteBackQuery {
  eq(column: string, value: unknown): WriteBackQuery;
  select(columns: string): WriteBackQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * 本物の書き手 (getAiActionLogWriter) を包み、1 回目の update を DB に書いたうえで応答を失わせる (error を返す)。
 * 応答を失った直後 (2 回目の試みの前) に afterLostResponse を流す (ここで別の実行が印を取る)
 */
function writerLosingFirstResponse(afterLostResponse: () => Promise<void>): AiActionLogWriter {
  const real = getAiActionLogWriter();
  let attempts = 0;
  const wrap = (inner: WriteBackQuery): WriteBackQuery => ({
    eq: (column, value) => wrap(inner.eq(column, value)),
    select: (columns) => wrap(inner.select(columns)),
    maybeSingle: async () => {
      attempts += 1;
      const result = await inner.maybeSingle();
      if (attempts > 1) return result;
      // 1 回目は DB には書けている (書けていなければ、この順の前提が崩れている)
      expect(result.error).toBeNull();
      expect(result.data).not.toBeNull();
      await afterLostResponse();
      return { data: null, error: LOST_RESPONSE_ERROR };
    },
  });
  const from = (table: string) => ({
    update: (payload: Record<string, unknown>) => wrap(real.from(table).update(payload) as unknown as WriteBackQuery),
  });
  return { from } as unknown as AiActionLogWriter;
}

beforeAll(async () => {
  owner = await createUser('owner');
}, LONG);

afterAll(async () => {
  for (const sessionId of createdSessionIds) {
    await srAdmin.from(TABLE).delete().eq('session_id', sessionId);
    await srAdmin.from('ai_consultation_messages').delete().eq('session_id', sessionId);
    await srAdmin.from('ai_consultation_sessions').delete().eq('id', sessionId);
  }
  for (const userId of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', userId);
    await srAdmin.auth.admin.deleteUser(userId);
  }
}, LONG);

describe('#2299 W2a ai_action_logs.claim_token の列', () => {
  it('K-1: 列は uuid・NULL 可・既定値なしで、コメントが付いている', async () => {
    const res = await pgRequest(`
SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, a.atthasdef AS has_default,
       pg_catalog.col_description(a.attrelid, a.attnum) AS comment
  FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = 'public.${TABLE}'::regclass AND a.attname = '${COLUMN}' AND NOT a.attisdropped;`);
    expect(res.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body).toEqual([{ type: 'uuid', not_null: false, has_default: false, comment: COLUMN_COMMENT }]);
  }, LONG);

  it('K-2: service_role は claim_token を付けずに作れ (NULL のまま)、claim_token を書け、claim_token で絞った書き換えは自分の token にだけ当たる', async () => {
    const id = await seedLog(owner);
    expect(await rowOf(id)).toMatchObject({ [COLUMN]: null, status: AI_ACTION_LOG_STATUS.pending });

    // 実行の印を付けるときに token も書く (W2b の claim の形: pending のときだけ approved にする 1 文)
    const token = randomUUID();
    const claimed = await srAdmin
      .from(TABLE)
      .update({ status: AI_ACTION_LOG_STATUS.running, [COLUMN]: token })
      .eq('id', id)
      .eq('status', AI_ACTION_LOG_STATUS.pending)
      .select('id');
    expect(claimed.error).toBeNull();
    expect(claimed.data).toEqual([{ id }]);
    expect(await rowOf(id)).toMatchObject({ [COLUMN]: token, status: AI_ACTION_LOG_STATUS.running });

    // 別のリクエストの token で絞った書き戻しは 0 行 (行は変わらない)
    const before = await rowOf(id);
    const otherToken = randomUUID();
    const stale = await srAdmin
      .from(TABLE)
      .update({ status: AI_ACTION_LOG_STATUS.pending })
      .eq('id', id)
      .eq('status', AI_ACTION_LOG_STATUS.running)
      .eq(COLUMN, otherToken)
      .select('id');
    expect(stale.error).toBeNull();
    expect(stale.data).toEqual([]);
    expect(await rowOf(id)).toEqual(before);

    // 自分の token で絞った書き戻しは 1 行
    const own = await srAdmin
      .from(TABLE)
      .update({ status: AI_ACTION_LOG_STATUS.executed, result: { note: MARK } })
      .eq('id', id)
      .eq('status', AI_ACTION_LOG_STATUS.running)
      .eq(COLUMN, token)
      .select('id');
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ id }]);
    expect(await rowOf(id)).toMatchObject({ [COLUMN]: token, status: AI_ACTION_LOG_STATUS.executed, result: { note: MARK } });

    // 作るときに token を付けることもできる (会話の続きの POST の自動実行の形)
    const insertToken = randomUUID();
    const inserted = await srAdmin
      .from(TABLE)
      .insert({ ...logRow(owner, AI_ACTION_LOG_STATUS.running), [COLUMN]: insertToken })
      .select(`id, ${COLUMN}`)
      .single();
    expect(inserted.error).toBeNull();
    expect(inserted.data).toMatchObject({ [COLUMN]: insertToken });
  }, LONG);

  it('K-3: 本人は claim_token を読めるが、UPDATE・claim_token つきの INSERT はできない (42501・行は変わらない)', async () => {
    const id = await seedLog(owner);
    const token = randomUUID();
    const claimed = await srAdmin.from(TABLE).update({ status: AI_ACTION_LOG_STATUS.running, [COLUMN]: token }).eq('id', id).select('id');
    expect(claimed.error).toBeNull();
    const db = asUser(owner.jwt);

    const read = await db.from(TABLE).select(`id, ${COLUMN}`).eq('id', id).maybeSingle();
    expect(read.error).toBeNull();
    expect(read.data).toEqual({ id, [COLUMN]: token });

    const before = await rowOf(id);
    const updated = await db.from(TABLE).update({ [COLUMN]: randomUUID() }).eq('id', id).select('id');
    expect(updated.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const cleared = await db.from(TABLE).update({ [COLUMN]: null, status: AI_ACTION_LOG_STATUS.pending }).eq('id', id).select('id');
    expect(cleared.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowOf(id)).toEqual(before);

    const directName = `${MARK} k3`;
    const inserted = await db
      .from(TABLE)
      .insert({ ...logRow(owner, AI_ACTION_LOG_STATUS.running), action_params: { name: directName }, [COLUMN]: randomUUID() })
      .select('id');
    expect(inserted.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const { data: directRows, error: directError } = await srAdmin.from(TABLE).select('id').eq('action_params->>name', directName);
    expect(directError).toBeNull();
    expect(directRows).toEqual([]);
  }, LONG);

  it('K-4: 未認証 (anon) は claim_token を読めず書けない (42501・行は変わらない)', async () => {
    const id = await seedLog(owner);
    const before = await rowOf(id);
    const db = anon();
    const selected = await db.from(TABLE).select(COLUMN).eq('id', id);
    expect(selected.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const updated = await db.from(TABLE).update({ [COLUMN]: randomUUID() }).eq('id', id).select('id');
    expect(updated.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rowOf(id)).toEqual(before);
  }, LONG);

  it('K-6: 2 つの token で ABA の順を流しても、A の 2 回目の書き戻しは B の行を上書きせず (0 行・{ error: null })、B の書き戻しが当たる', async () => {
    const id = await seedLog(owner);
    const tokenA = newAiActionLogClaimToken();
    const tokenB = newAiActionLogClaimToken();
    /** execute の POST の claim と同じ 1 文 (pending のときだけ実行中の印にし、token を書く) */
    const claim = (token: string) =>
      srAdmin
        .from(TABLE)
        .update({ status: AI_ACTION_LOG_STATUS.running, [COLUMN]: token })
        .eq('id', id)
        .eq('status', AI_ACTION_LOG_STATUS.pending)
        .select('id');
    const claimedA = await claim(tokenA);
    expect(claimedA.error).toBeNull();
    expect(claimedA.data).toEqual([{ id }]);

    // A: やり直せる失敗で pending に戻す書き戻し。1 回目は書けたのに応答を失い、その間に B が印を取る
    let claimedB: Awaited<ReturnType<typeof claim>> | null = null;
    const writerA = writerLosingFirstResponse(async () => {
      expect(await rowOf(id)).toMatchObject({ status: AI_ACTION_LOG_STATUS.pending, [COLUMN]: tokenA });
      claimedB = await claim(tokenB);
    });
    const resultA = await writeBackAiActionLog(
      writerA,
      WRITE_BACK_ROUTE_NAME,
      { userId: owner.id, actionLogId: id, actionType: 'add_pantry_item', claimToken: tokenA },
      { status: AI_ACTION_LOG_STATUS.pending, executed_at: null },
    );

    expect(claimedB).toMatchObject({ error: null, data: [{ id }] });
    expect(resultA).toEqual({ error: null });
    // A の 2 回目は token が一致しないので書かない (修正前は B の approved を pending で上書きしていた)
    expect(await rowOf(id)).toMatchObject({ status: AI_ACTION_LOG_STATUS.running, [COLUMN]: tokenB });

    // B: 実行が成功して executed に書き戻す。B の token で当たる
    const resultB = await writeBackAiActionLog(
      getAiActionLogWriter(),
      WRITE_BACK_ROUTE_NAME,
      { userId: owner.id, actionLogId: id, actionType: 'add_pantry_item', claimToken: tokenB },
      { status: AI_ACTION_LOG_STATUS.executed, result: { note: MARK }, executed_at: new Date().toISOString() },
    );
    expect(resultB).toEqual({ error: null });
    expect(await rowOf(id)).toMatchObject({ status: AI_ACTION_LOG_STATUS.executed, [COLUMN]: tokenB, result: { note: MARK } });
  }, LONG);

  it('K-5: 戻し口を流すと列が消える (巻き戻すので DB には残らない)', async () => {
    expect(await columnExistsNow()).toBe('yes');
    expect(await columnExistsAfterRolledBack(readRollback())).toBe('no');
    // 巻き戻ったあとは列があるまま
    expect(await columnExistsNow()).toBe('yes');
  }, LONG);
});
