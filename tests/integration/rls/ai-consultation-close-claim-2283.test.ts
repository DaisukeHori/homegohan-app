/**
 * #2283 W1: AI 相談の「相談を終了」の確定と、閉じた相談の要約の読み取りの、実 DB (PostgREST) での振る舞い。
 *
 * 確かめること (I-n はこのファイルの it の番号):
 *   - I-1: 閉じる route と同じ、状態の条件つきの書き換え (閉じていない行だけ。.or('status.is.null,status.neq.closed')
 *          → .select('id').maybeSingle()) は、1 回目は行を返し、2 回目 (すでに closed) は行を返さない (data: null・error: null)。
 *          同時の 2 本の「相談を終了」のうち、要約と利用回数に進めるのが 1 本目だけになる根拠
 *   - I-2: status が NULL の行も、同じ書き換えで閉じられる (NULL も閉じていない相談として扱う)
 *   - I-3: 閉じた相談の要約の読み取り (PAST_SESSION_SUMMARY_COLUMNS) は、context_snapshot の key_facts・user_insights だけを
 *          JSON の path で返し、snapshot の丸ごと (入れ子の pastSessionSummaries を含む) を返さない。キーが無い行は null
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-consultation-close-claim-2283.test.ts
 * 本番には接続しない。作った行とユーザーは afterAll で消す。
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { PAST_SESSION_SUMMARY_COLUMNS } from '@/lib/ai/consultation-past-sessions';
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

/** 閉じる route が書く状態 */
const CLOSED_STATUS = 'closed';
/** 閉じる route の「閉じていない行だけ」の条件 (route と同じ文字列) */
const NOT_CLOSED_FILTER = 'status.is.null,status.neq.closed';

const KEY_FACTS = [{ date: '2026-11-01', category: '体重', content: '62kg' }];
const USER_INSIGHTS = ['朝食を抜きがち'];

// ---------------------------------------------------------------
// テストユーザー
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const LONG = 120_000;
const TITLE = `w1-2283-${TS}`;
let userId = '';
let jwt = '';

beforeAll(async () => {
  const email = `w1-2283-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: userId, nickname: 'w1-2283', age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
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

/** 閉じる route と同じ、閉じていない行だけを閉じる書き換え */
function closeIfOpen(id: string) {
  return asUser(jwt)
    .from('ai_consultation_sessions')
    .update({ status: CLOSED_STATUS, updated_at: new Date().toISOString() })
    .eq('id', id)
    .or(NOT_CLOSED_FILTER)
    .select('id')
    .maybeSingle();
}

describe('#2283 W1 相談を終了の確定と、閉じた相談の要約の読み取り', () => {
  it('I-1: 閉じていない行だけを閉じる書き換えは、1 回目だけ行を返し、2 回目は行を返さない', async () => {
    const { data: created, error } = await asUser(jwt).from('ai_consultation_sessions').insert({ user_id: userId, title: TITLE }).select('id').single();
    if (error || !created) throw new Error(`session: ${error?.message}`);

    const first = await closeIfOpen(created.id as string);
    expect(first.error).toBeNull();
    expect(first.data?.id).toBe(created.id);

    const second = await closeIfOpen(created.id as string);
    expect(second.error).toBeNull();
    expect(second.data).toBeNull();

    const { data: row } = await srAdmin.from('ai_consultation_sessions').select('status').eq('id', created.id).single();
    expect(row?.status).toBe(CLOSED_STATUS);
  }, LONG);

  it('I-2: status が NULL の行も、同じ書き換えで閉じられる', async () => {
    const { data: created, error } = await srAdmin.from('ai_consultation_sessions').insert({ user_id: userId, title: TITLE, status: null }).select('id, status').single();
    if (error || !created) throw new Error(`session: ${error?.message}`);
    expect(created.status).toBeNull();

    const closed = await closeIfOpen(created.id as string);
    expect(closed.error).toBeNull();
    expect(closed.data?.id).toBe(created.id);
  }, LONG);

  it('I-3: 閉じた相談の要約の読み取りは key_facts・user_insights だけを返し、snapshot の丸ごとを返さない', async () => {
    const nestedSnapshot = {
      profile: { age: 30 },
      pastSessionSummaries: [{ id: 'old', context_snapshot: { pastSessionSummaries: [{ context_snapshot: {} }] } }],
      key_facts: KEY_FACTS,
      user_insights: USER_INSIGHTS,
    };
    const withFacts = await asUser(jwt)
      .from('ai_consultation_sessions')
      .insert({ user_id: userId, title: `${TITLE}-facts`, status: CLOSED_STATUS, summary: '要約', context_snapshot: nestedSnapshot })
      .select('id')
      .single();
    expect(withFacts.error).toBeNull();
    const withoutFacts = await asUser(jwt)
      .from('ai_consultation_sessions')
      .insert({ user_id: userId, title: `${TITLE}-empty`, status: CLOSED_STATUS, summary: '要約', context_snapshot: { profile: null } })
      .select('id')
      .single();
    expect(withoutFacts.error).toBeNull();

    const { data, error } = await asUser(jwt)
      .from('ai_consultation_sessions')
      .select(PAST_SESSION_SUMMARY_COLUMNS)
      .eq('user_id', userId)
      .eq('status', CLOSED_STATUS)
      .not('summary', 'is', null);
    expect(error).toBeNull();
    const rows: Array<Record<string, unknown>> = data ?? [];
    const facts = rows.find((r) => r.id === withFacts.data?.id);
    const empty = rows.find((r) => r.id === withoutFacts.data?.id);
    expect(facts?.key_facts).toEqual(KEY_FACTS);
    expect(facts?.user_insights).toEqual(USER_INSIGHTS);
    expect(empty?.key_facts).toBeNull();
    expect(empty?.user_insights).toBeNull();
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'key_facts', 'key_topics', 'summary', 'summary_generated_at', 'title', 'user_insights']);
    }
  }, LONG);
});
