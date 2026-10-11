/**
 * #1413 ログアウトの直前の push token の削除の異常を、サーバーログ (POST /api/log → app_logs) に残せる経路と残せない経路
 * (結合テスト: ローカルの Supabase と next dev の /api/log を使う)
 *
 * モバイルは、ログアウトの直前の push token の削除が失敗・0 件だったとき、その記録を /api/log に送る
 * (apps/mobile/src/lib/pushNotifications.ts の unregisterExpoPushToken)。サインアウトでセッションが消える前に送る順番にしてあるが、
 * Web から始まったサインアウト・session-expired では、端末が送るより前に Web の signOut() (既定の scope は global) が
 * サーバー側のセッションを失効させている。そのときモバイルは、処理の最初に控えたアクセストークンを Authorization に明示して
 * 削除と記録の送信を行う。以前のコメント・テストは「控えたトークンで記録も送れる」と書いていたが、そうではない:
 *   - PostgREST (user_push_tokens の DELETE) は JWT の署名と期限しか見ないので、失効後でも期限内なら本人の行を消せる
 *   - /api/log (src/app/api/log/route.ts) はサーバーで getUser() (GoTrue の GET /user) を呼ぶ。GET /user は JWT の
 *     session_id のセッションが残っているかまで確かめるので、失効後は 401 になり、app_logs には残らない
 * ここで本物のサーバーを使って、この食い違いを固定する (片方が変わったら、pushNotifications.ts の説明と設計書 mobile/05 §5 を直す)。
 *
 * 確かめること:
 *   L-1: セッションが生きているうち (端末からのサインアウトは、サインアウトの前に送る) は、/api/log に送った記録が app_logs に残る。
 *        モバイルが送るキー (push_value_source / explicit_auth_header など) は、sanitizeLogEntry にマスクされずに残る
 *   L-2: Web の signOut() でセッションが失効したあとは、同じアクセストークンで
 *        user_push_tokens の DELETE は通る (本人の行が消える) が、/api/log は 401 で、app_logs には何も足されない
 *
 * 本文はモバイルと同じ組み立て (apps/mobile/src/lib/push-issue-log.ts) を使う。
 *
 * 実行 (ローカル Supabase + ローカルの Next dev サーバが必要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   INTEGRATION_BASE_URL=http://localhost:3000 \
 *     npx vitest run --config vitest.integration.config.ts tests/integration/security/push-issue-log-after-session-revoked.test.ts
 */

import { createClient, isAuthSessionMissingError, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

import {
  type PushIssueLogBody,
  buildPushIssueLogBody,
  unregisterNoRowsServerFields,
} from '../../../apps/mobile/src/lib/push-issue-log';
import { apiCall } from '../helpers/api';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ユーザーを作ってサインアウトさせるテストなので、本番や共有環境へ誤って向けない (ローカルのスタックだけを対象にする)
const supabaseHost = new URL(url).hostname;
if (supabaseHost !== 'localhost' && supabaseHost !== '127.0.0.1') {
  throw new Error(
    `NEXT_PUBLIC_SUPABASE_URL はローカルの Supabase を指してください (現在のホスト: ${supabaseHost})`,
  );
}

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;

/** /api/log (src/app/api/log/route.ts) が app_logs に入れるときの source */
const CLIENT_LOG_SOURCE = 'client';

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);

const TS = Date.now();
const PASSWORD = 'PushLog!2026-it1413';
/** この端末の push token (ダミー。Expo に問い合わせない) */
const DEVICE_PUSH_VALUE = `ExponentPushToken[it-1413-${TS}]`;

let userId: string;
/** 端末のセッション (サインインしたクライアント)。L-2 で Web の signOut() と同じく、このセッションを失効させる */
let device: SupabaseClient;
/** 端末が処理の最初に控えたアクセストークン (webViewAuthMessages.ts の takeSessionSnapshot と同じ値) */
let accessToken: string;

/** 0 件の記録の本文 (モバイルと同じ組み立て) */
function noRowsBody(explicitAuthHeader: boolean): PushIssueLogBody {
  return buildPushIssueLogBody(
    'push_token_unregister_no_rows',
    unregisterNoRowsServerFields({ platform: 'ios', pushValueSource: 'stored', explicitAuthHeader }),
  );
}

/** このユーザーの app_logs の行 (service role で読む。テストが作ったユーザーだけなので、他のログは混ざらない) */
async function appLogsOfUser() {
  const { data, error } = await srAdmin
    .from('app_logs')
    .select('level, source, message, metadata')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`app_logs を読めません: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  const email = `it-1413-push-log-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;

  device = client(anonKey);
  const signIn = await device.auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  accessToken = signIn.data.session.access_token;

  // この端末の push token の行 (登録済みの状態)
  const { error: insertError } = await srAdmin
    .from('user_push_tokens')
    .insert({ user_id: userId, expo_push_token: DEVICE_PUSH_VALUE, platform: 'ios' });
  if (insertError) throw new Error(`user_push_tokens の準備に失敗: ${insertError.message}`);
});

afterAll(async () => {
  if (!userId) return;
  // このテストが作ったものだけを消す (app_logs はユーザーの削除で user_id が NULL になるので、先に消す)
  await srAdmin.from('app_logs').delete().eq('user_id', userId);
  await srAdmin.from('user_push_tokens').delete().eq('user_id', userId);
  await srAdmin.auth.admin.deleteUser(userId);
});

describe('#1413 ログアウトの直前の削除の記録 (/api/log) と、削除 (PostgREST) の認証の違い', () => {
  it('L-1: セッションが生きているうちは、/api/log に送った記録が app_logs に残る (送ったキーはマスクされない)', async () => {
    const body = noRowsBody(false);

    const res = await apiCall('POST', '/api/log', accessToken, body);

    expect(res.status).toBe(HTTP_OK);
    expect(await appLogsOfUser()).toEqual([
      { level: body.level, source: CLIENT_LOG_SOURCE, message: body.message, metadata: body.metadata },
    ]);
  });

  it('L-2: Web の signOut() でセッションが失効したあとは、同じアクセストークンで DELETE は通るが、/api/log は 401 で記録は残らない', async () => {
    // Web の設定・マイページのログアウトと同じ signOut() (既定の scope は global)。端末と同じセッションを失効させる
    const { error: signOutError } = await device.auth.signOut();
    expect(signOutError).toBeNull();

    // 失効は GoTrue の具体的なエラーで確かめる (/api/log の getUser() と同じ GET /user)。通信エラーなどを失効と取り違えない
    const { error: getUserError } = await client(anonKey).auth.getUser(accessToken);
    expect(isAuthSessionMissingError(getUserError)).toBe(true);

    // 削除: PostgREST は JWT の署名と期限しか見ないので、控えたアクセストークンで本人の行を消せる
    const deleted = await client(anonKey, accessToken)
      .from('user_push_tokens')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .eq('expo_push_token', DEVICE_PUSH_VALUE);
    expect(deleted.error).toBeNull();
    expect(deleted.count).toBe(1);

    // 記録: /api/log はセッションの存在まで確かめるので、同じアクセストークンを明示しても 401。app_logs には足されない
    const before = await appLogsOfUser();
    const res = await apiCall('POST', '/api/log', accessToken, noRowsBody(true));

    expect(res.status).toBe(HTTP_UNAUTHORIZED);
    expect(await appLogsOfUser()).toEqual(before);
  });
});
