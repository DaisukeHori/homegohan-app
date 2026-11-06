/**
 * #2283 (B) 終了した (閉じた) AI 相談への会話の続きの POST を、実 DB (ローカル Supabase) と next dev で確かめる
 *
 * 単体テスト (tests/ai-consultation-closed-session-route-2283.test.ts) は Supabase を作り物にしている。このテストは本物で、
 * 作り物では確かめられない次のかみ合わせを見る:
 *   - 閉じる route (POST /api/ai/consultation/sessions/[sessionId]/close) が書く status の値 ('closed') と、
 *     会話の続きの route (POST .../messages) の判定 (src/lib/ai/consultation-session-closed.ts) が同じ値を見ていること
 *   - 本人のセッション (RLS) で select('*') した相談の行に status が入っていて、所有者の確認のあとに 409 で断ること
 *   - 断ったときに、メッセージの行 (ai_consultation_messages)・提案の記録 (ai_action_logs)・AI の利用回数
 *     (ai_usage_counters) が増えないこと
 *
 * 相談は API で作り、会話を 1 件だけ置いて (サービスロール) 閉じる。会話が 1 件だけなら閉じる route は要約を作らない
 * (AI を呼ばない) ので、結合テストの next dev に AI の鍵が無くても閉じられる。会話の続きの route は、同意 (T15) と緊急停止の
 * 判定のあとに相談を確かめるので、同意はサービスロールで記録しておく (本番の同意の画面と同じ関数)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/ai-consultation-closed-session-2283.test.ts
 *   (dev サーバが 3000 以外のとき: INTEGRATION_BASE_URL=http://localhost:3414 を付ける)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { createTestUserWithRoles, cleanupTestUser, testEmail, type TestUser } from '../helpers/users';
import { grantAiConsent } from '@/lib/ai/consent';
import { AI_CONSULTATION_SESSION_CLOSED_CODE, AI_CONSULTATION_SESSION_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';
import { CONSULTATION_SESSION_CLOSED_STATUS, CONSULTATION_SESSION_STATUS_CLOSED } from '@/lib/ai/consultation-session-closed';

const TS = Date.now();
const SESSIONS_TABLE = 'ai_consultation_sessions';
const MESSAGES_TABLE = 'ai_consultation_messages';
const ACTION_LOGS_TABLE = 'ai_action_logs';
const USAGE_TABLE = 'ai_usage_counters';
const CONSENTS_TABLE = 'external_data_consents';
/** 閉じる前に置く会話 (1 件だけなら、閉じる route は要約を作らず AI を呼ばない) */
const SEEDED_MESSAGE = '閉じる前の相談の文 (#2283 の結合テスト)';
/** 閉じた相談へ送る文 */
const SENT_AFTER_CLOSE = '閉じたあとに送った文 (#2283 の結合テスト)';
/**
 * next dev は route を最初に呼ばれたときにコンパイルする (CI の初回は 1 本あたり数十秒)。テストの前に認証なしで 1 回ずつ
 * 呼んで先にコンパイルさせる (401 になるだけで副作用は無い。tests/integration/security/feature-flags-runtime.test.ts と同じ)。
 * id は UUID の形の値なら何でもよい (認証で先に断る)
 */
const WARM_UP_SESSION_ID = '00000000-0000-4000-8000-000000002283';
const WARM_UP_ROUTES = [
  '/api/ai/consultation/sessions',
  `/api/ai/consultation/sessions/${WARM_UP_SESSION_ID}/close`,
  `/api/ai/consultation/sessions/${WARM_UP_SESSION_ID}/messages`,
] as const;
/** 温める処理の上限 (ルート 3 本のコンパイル。feature-flags-runtime.test.ts の温めと同じ値) */
const WARM_UP_HOOK_TIMEOUT_MS = 240_000;

let user: TestUser;
let sessionId: string;

const messagesPath = (id: string) => `/api/ai/consultation/sessions/${id}/messages`;

/** 相談のメッセージの行数 */
async function messageCount(id: string): Promise<number> {
  const { count, error } = await supabaseAdmin.from(MESSAGES_TABLE).select('id', { count: 'exact', head: true }).eq('session_id', id);
  expect(error, `${MESSAGES_TABLE} の数え上げ`).toBeNull();
  return count ?? 0;
}

/** 相談の提案の記録の行数 */
async function actionLogCount(id: string): Promise<number> {
  const { count, error } = await supabaseAdmin.from(ACTION_LOGS_TABLE).select('id', { count: 'exact', head: true }).eq('session_id', id);
  expect(error, `${ACTION_LOGS_TABLE} の数え上げ`).toBeNull();
  return count ?? 0;
}

/** 利用者の AI の利用回数の合計 (全日・全機能) */
async function usageTotal(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin.from(USAGE_TABLE).select('count').eq('user_id', userId);
  expect(error, `${USAGE_TABLE} の読み取り`).toBeNull();
  return ((data ?? []) as Array<{ count: number }>).reduce((sum, row) => sum + row.count, 0);
}

beforeAll(async () => {
  for (const path of WARM_UP_ROUTES) {
    try {
      await apiCallNoAuth('POST', path);
    } catch {
      // 温めるだけ。dev サーバーに届かないときは、あとのテストが失敗して知らせる
    }
  }
}, WARM_UP_HOOK_TIMEOUT_MS);

beforeAll(async () => {
  user = await createTestUserWithRoles({ email: testEmail('closed-consult-2283', TS), roles: [] });
  await grantAiConsent({ userId: user.userId, ipAddress: null, userAgent: null }, supabaseAdmin);
});

afterAll(async () => {
  if (!user) return;
  // 相談を消すとメッセージ・提案の記録も消える (外部キーの ON DELETE CASCADE)
  await supabaseAdmin.from(SESSIONS_TABLE).delete().eq('user_id', user.userId);
  await supabaseAdmin.from(USAGE_TABLE).delete().eq('user_id', user.userId);
  await supabaseAdmin.from(CONSENTS_TABLE).delete().eq('user_id', user.userId);
  await cleanupTestUser(user.userId);
});

describe('#2283 (B) 終了した相談への会話の続き (実 DB + next dev)', () => {
  it('閉じる route で閉じた相談は、DB の status が closed になる (会話の続きの判定と同じ値)', async () => {
    const created = await apiCall<{ session?: { id: string } }>('POST', '/api/ai/consultation/sessions', user.jwt, { title: 'AI相談' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.session?.id).toBeTruthy();
    sessionId = created.body.session!.id;

    const { error: seedError } = await supabaseAdmin.from(MESSAGES_TABLE).insert({ session_id: sessionId, role: 'user', content: SEEDED_MESSAGE });
    expect(seedError, `${MESSAGES_TABLE} に会話を置く`).toBeNull();

    const closed = await apiCall('POST', `/api/ai/consultation/sessions/${sessionId}/close`, user.jwt, {});
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const { data: row, error } = await supabaseAdmin.from(SESSIONS_TABLE).select('status').eq('id', sessionId).single();
    expect(error).toBeNull();
    expect(row?.status).toBe(CONSULTATION_SESSION_STATUS_CLOSED);
  });

  it('閉じた相談への POST は 409 と名前付きの文・code を返し、メッセージ・提案の記録・AI の利用回数を増やさない', async () => {
    expect(sessionId, '前のテストで相談を作って閉じている').toBeTruthy();
    const messagesBefore = await messageCount(sessionId);
    const actionLogsBefore = await actionLogCount(sessionId);
    const usageBefore = await usageTotal(user.userId);

    const res = await apiCall<{ error?: unknown; code?: unknown }>('POST', messagesPath(sessionId), user.jwt, { message: SENT_AFTER_CLOSE });

    expect(res.status, JSON.stringify(res.body)).toBe(CONSULTATION_SESSION_CLOSED_STATUS);
    expect(res.body).toEqual({ error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE, code: AI_CONSULTATION_SESSION_CLOSED_CODE });
    expect(await messageCount(sessionId)).toBe(messagesBefore);
    expect(await actionLogCount(sessionId)).toBe(actionLogsBefore);
    expect(await usageTotal(user.userId)).toBe(usageBefore);
    const { data: sent, error } = await supabaseAdmin.from(MESSAGES_TABLE).select('id').eq('session_id', sessionId).eq('content', SENT_AFTER_CLOSE);
    expect(error).toBeNull();
    expect(sent).toEqual([]);
  });

  it('流れで返す送信 (?stream=true) も同じく 409 で、メッセージを増やさない', async () => {
    expect(sessionId, '前のテストで相談を作って閉じている').toBeTruthy();
    const messagesBefore = await messageCount(sessionId);

    const res = await apiCall<{ code?: unknown }>('POST', `${messagesPath(sessionId)}?stream=true`, user.jwt, { message: SENT_AFTER_CLOSE });

    expect(res.status, JSON.stringify(res.body)).toBe(CONSULTATION_SESSION_CLOSED_STATUS);
    expect(res.body.code).toBe(AI_CONSULTATION_SESSION_CLOSED_CODE);
    expect(await messageCount(sessionId)).toBe(messagesBefore);
  });
});
