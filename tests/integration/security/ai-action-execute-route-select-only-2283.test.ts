/**
 * #2283 判断待ち 8 の Y2: AI 相談の提案の記録 (ai_action_logs) を利用者には読むだけにした (*_ai_action_logs_select_only.sql) あとも、
 * 提案のカードの「実行する」「断る」(POST / DELETE /api/ai/consultation/actions/[actionId]/execute) が今までどおり動くことを、
 * 実 DB と next dev で確かめる。route は行を本人のセッションで読み (SELECT のポリシー)、持ち主を確かめてから service_role の
 * クライアント (getAiActionLogWriter。#2283 Y1) で書く。
 *
 * 確かめること (E-n はこのファイルの it の番号):
 *   - E-1: 本人が提案の行の id で POST すると 200 で実行され、行は executed になり、結果 (冷蔵庫の食材の行) ができる
 *   - E-2: 本人がメッセージ ID で POST しても (Web の提案のカードの形) 同じく実行される
 *   - E-3: 実行済みの行へもう一度 POST すると 400 (すでに処理済み)。行は変わらない (本人のセッションでの読み取りが通っている)
 *   - E-4: 本人が DELETE すると 200 で、行は rejected になる
 *   - E-5: 他人が持ち主の行へ POST / DELETE すると 404 で、行は pending のまま (他人の行は読めないので見つからない)
 * 会話の続きの POST の自動実行は AI (knowledge-gpt) を呼ぶので、ここでは流さない。同じ手順 (service_role で作る → 本人のセッションで
 * 実行 → service_role で確定) は tests/integration/rls/ai-action-logs-select-only-2283.test.ts の S-2 が実 DB で確かめる。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と next dev (INTEGRATION_BASE_URL。既定 http://localhost:3000)。本番には接続しない。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/ai-action-execute-route-select-only-2283.test.ts
 * 作った行とユーザーは afterAll で消す。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE, AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE } from '@/lib/ai/ai-api-messages';
import { AI_ACTION_LOG_STATUS } from '@/lib/ai/consultation-action-lifecycle';
import { AI_SENDING_ACTION_TYPES } from '@/lib/ai/consultation-action-executor';
import { apiCall, apiCallNoAuth } from '../helpers/api';
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

const TABLE = 'ai_action_logs';
/** AI を使わない (同意も AI の利用回数も要らない) アクション。本人のセッションで冷蔵庫の食材の行を 1 つ作る */
const ACTION_TYPE = 'add_pantry_item';
const executePath = (id: string) => `/api/ai/consultation/actions/${id}/execute`;

interface ExecuteBody {
  success?: boolean;
  result?: { itemId?: string; created?: boolean; error?: string };
  actionType?: string;
  error?: string;
}

// ---------------------------------------------------------------
// テストユーザー・相談・メッセージ・提案の行
// ---------------------------------------------------------------
const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
/** 準備と後片付けの時間の上限 (ミリ秒。next dev が route を最初に呼ばれたときにコンパイルする) */
const SETUP_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;
const NAME = (label: string) => `#2283 y2 route ${label} ${RUN}`;

interface TestUser {
  id: string;
  jwt: string;
  sessionId: string;
}

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];
let owner: TestUser;
let other: TestUser;

async function createUser(label: string): Promise<TestUser> {
  const email = `y2-2283-route-${label}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `y2-2283-route-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  const session = await srAdmin.from('ai_consultation_sessions').insert({ user_id: data.user.id, title: `y2-2283-route-${label}` }).select('id').single();
  if (session.error || !session.data) throw new Error(`session ${label}: ${session.error?.message}`);
  createdSessionIds.push(session.data.id);
  return { id: data.user.id, jwt: signIn.data.session.access_token, sessionId: session.data.id };
}

/** service_role で AI の返答のメッセージと、その提案の pending の行を作る */
async function seedProposal(user: TestUser, label: string): Promise<{ actionId: string; messageId: string; name: string }> {
  const message = await srAdmin
    .from('ai_consultation_messages')
    .insert({ session_id: user.sessionId, role: 'assistant', content: `y2-2283-route-${label}` })
    .select('id')
    .single();
  if (message.error || !message.data) throw new Error(`message ${label}: ${message.error?.message}`);
  const name = NAME(label);
  const log = await srAdmin
    .from(TABLE)
    .insert({
      session_id: user.sessionId,
      message_id: message.data.id,
      action_type: ACTION_TYPE,
      action_params: { name },
      status: AI_ACTION_LOG_STATUS.pending,
    })
    .select('id')
    .single();
  if (log.error || !log.data) throw new Error(`seed ${TABLE} ${label}: ${log.error?.message}`);
  return { actionId: log.data.id, messageId: message.data.id, name };
}

async function rowOf(id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await srAdmin.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`${TABLE} ${id}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function pantryCount(userId: string, name: string): Promise<number> {
  const { data, error } = await srAdmin.from('pantry_items').select('id').eq('user_id', userId).eq('name', name);
  if (error) throw new Error(`pantry_items: ${error.message}`);
  return (data ?? []).length;
}

beforeAll(async () => {
  // next dev に route を先にコンパイルさせる (認証なしで 401 になるだけ。結果は見ない)
  try {
    await apiCallNoAuth('POST', executePath(randomUUID()));
  } catch {
    // 温めるだけ。dev サーバーに届かないときは、あとのテストが失敗して知らせる
  }
  owner = await createUser('owner');
  other = await createUser('other');
}, SETUP_TIMEOUT_MS);

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
}, SETUP_TIMEOUT_MS);

describe('#2283 Y2 提案のカードの「実行する」「断る」は今までどおり動く', () => {
  it('前提: このテストのアクションは AI を使わない (同意・AI の利用回数に依らない)', () => {
    expect(AI_SENDING_ACTION_TYPES.has(ACTION_TYPE)).toBe(false);
  });

  it('E-1: 本人が提案の行の id で POST すると実行され、行は executed になり、冷蔵庫の食材の行ができる', async () => {
    const { actionId, name } = await seedProposal(owner, 'e1');
    const res = await apiCall<ExecuteBody>('POST', executePath(actionId), owner.jwt);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, actionType: ACTION_TYPE, result: { created: true } });
    expect(await rowOf(actionId)).toMatchObject({ status: AI_ACTION_LOG_STATUS.executed, result: { created: true } });
    expect((await rowOf(actionId))?.executed_at).not.toBeNull();
    expect(await pantryCount(owner.id, name)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('E-2: 本人がメッセージ ID で POST しても (Web の提案のカードの形) 実行される', async () => {
    const { actionId, messageId, name } = await seedProposal(owner, 'e2');
    const res = await apiCall<ExecuteBody>('POST', executePath(messageId), owner.jwt);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, actionType: ACTION_TYPE });
    expect(await rowOf(actionId)).toMatchObject({ status: AI_ACTION_LOG_STATUS.executed });
    expect(await pantryCount(owner.id, name)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('E-3: 実行済みの行へもう一度 POST すると 400 (すでに処理済み)。行は変わらず、もう一度実行しない', async () => {
    const { actionId, name } = await seedProposal(owner, 'e3');
    const first = await apiCall<ExecuteBody>('POST', executePath(actionId), owner.jwt);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const executed = await rowOf(actionId);
    const second = await apiCall<ExecuteBody>('POST', executePath(actionId), owner.jwt);
    expect(second.status, JSON.stringify(second.body)).toBe(400);
    expect(second.body.error).toBe(AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE);
    expect(await rowOf(actionId)).toEqual(executed);
    expect(await pantryCount(owner.id, name)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('E-4: 本人が DELETE すると 200 で、行は rejected になる (実行しない)', async () => {
    const { actionId, name } = await seedProposal(owner, 'e4');
    const res = await apiCall<ExecuteBody>('DELETE', executePath(actionId), owner.jwt);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(await rowOf(actionId)).toMatchObject({ status: AI_ACTION_LOG_STATUS.rejected });
    expect(await pantryCount(owner.id, name)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('E-5: 他人が持ち主の行へ POST / DELETE すると 404 で、行は pending のまま', async () => {
    const { actionId, messageId, name } = await seedProposal(owner, 'e5');
    const before = await rowOf(actionId);
    for (const id of [actionId, messageId]) {
      const posted = await apiCall<ExecuteBody>('POST', executePath(id), other.jwt);
      expect(posted.status, JSON.stringify(posted.body)).toBe(404);
      expect(posted.body.error).toBe(AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE);
      const deleted = await apiCall<ExecuteBody>('DELETE', executePath(id), other.jwt);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(404);
      expect(deleted.body.error).toBe(AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE);
    }
    expect(await rowOf(actionId)).toEqual(before);
    expect(before).toMatchObject({ status: AI_ACTION_LOG_STATUS.pending });
    expect(await pantryCount(owner.id, name)).toBe(0);
    expect(await pantryCount(other.id, name)).toBe(0);
  }, TEST_TIMEOUT_MS);
});
