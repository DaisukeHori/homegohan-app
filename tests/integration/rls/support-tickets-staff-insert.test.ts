/**
 * #1248 support_tickets: 運営 (support / admin / super_admin) による顧客の代理起票の回帰テスト
 *
 * 修正前の support_tickets の INSERT ポリシーは
 *   tickets_insert_user: WITH CHECK (user_id = auth.uid())
 * の 1 本だけだった。運営画面の POST /api/admin/support/tickets は運営スタッフのセッションで
 * user_id = <顧客> の行を INSERT するため RLS で拒否され、500 DB_ERROR になっていた。
 *
 * 期待する認可 (修正後):
 *   - 運営 (roles に support / admin / super_admin のいずれか) は任意の user_id でチケットを起票できる
 *   - 一般ユーザーは自分の user_id でだけ起票できる (他人の user_id は 42501 のまま)
 *   - support / admin / super_admin 以外の運営系ロール (sales / finance / content_moderator / org_admin) は代理起票できない
 *   - 未認証 (anon) は起票できない
 *
 * PostgREST を supabase-js で直接叩く RLS のテストと、運営画面の API (要 dev サーバー) のテストを含む。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/support-tickets-staff-insert.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ---------------------------------------------------------------
// クライアントファクトリ (support-ticket-messages-rls.test.ts と同型)
// ---------------------------------------------------------------
function anonClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function serviceRoleClient(): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function authedClient(accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const srAdmin = serviceRoleClient();

// ---------------------------------------------------------------
// テストユーザー (support-ticket-messages-rls.test.ts と同型)
// ---------------------------------------------------------------
interface RlsTestUser {
  userId: string;
  email: string;
  jwt: string;
}

async function createRlsTestUser(params: { email: string; roles: string[] }): Promise<RlsTestUser> {
  const password = 'TestPass!2026-rls';

  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email: params.email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user ${params.email}: ${authError?.message}`);
  }
  const userId = authData.user.id;

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signInResult = await anonClient().auth.signInWithPassword({ email: params.email, password });
  if (signInResult.error || !signInResult.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${params.email}: ${signInResult.error?.message}`);
  }
  const jwt = signInResult.data.session.access_token;

  // 本人の JWT で自分のプロフィールを作成 (Users can insert own profile)
  const { error: insertError } = await authedClient(jwt).from('user_profiles').insert({
    id: userId,
    nickname: `rls-test-${userId.slice(0, 8)}`,
    age_group: '30s',
    gender: 'other',
  });
  if (insertError) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to insert profile for ${params.email}: ${insertError.message}`);
  }

  // roles は特権列ガードにより本人では変更できないため service_role で設定する
  const { error: updateError } = await srAdmin
    .from('user_profiles')
    .update({ roles: params.roles })
    .eq('id', userId);
  if (updateError) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to set roles for ${params.email}: ${updateError.message}`);
  }

  return { userId, email: params.email, jwt };
}

async function deleteRlsTestUser(userId: string): Promise<void> {
  await srAdmin.from('user_profiles').delete().eq('id', userId);
  await srAdmin.auth.admin.deleteUser(userId);
}

// ---------------------------------------------------------------
// フィクスチャ
//   customer: 起票される顧客 / other: 別の一般ユーザー
//   support / admin / superAdmin: 運営 3 ロール
//   otherOps: support / admin / super_admin を持たない運営系ロール
// ---------------------------------------------------------------
const TS = Date.now();
const SUBJECT_PREFIX = `#1248 ${TS}`;

let customer: RlsTestUser;
let other: RlsTestUser;
let support: RlsTestUser;
let admin: RlsTestUser;
let superAdmin: RlsTestUser;
let otherOps: RlsTestUser;

function ticketRow(userId: string, label: string) {
  return {
    user_id: userId,
    subject: `${SUBJECT_PREFIX} ${label}`,
    category: 'other',
    priority: 'medium',
    status: 'open',
  };
}

/** 件名のチケットの行数を service_role で数える (RLS の影響を受けない) */
async function countTickets(label: string): Promise<number> {
  const { data, error } = await srAdmin
    .from('support_tickets')
    .select('id')
    .eq('subject', `${SUBJECT_PREFIX} ${label}`);
  if (error) throw new Error(`Failed to count tickets: ${error.message}`);
  return (data ?? []).length;
}

beforeAll(async () => {
  [customer, other, support, admin, superAdmin, otherOps] = await Promise.all([
    createRlsTestUser({ email: `rls-1248-customer-${TS}@homegohan.test`, roles: ['user'] }),
    createRlsTestUser({ email: `rls-1248-other-${TS}@homegohan.test`, roles: ['user'] }),
    createRlsTestUser({ email: `rls-1248-support-${TS}@homegohan.test`, roles: ['support'] }),
    createRlsTestUser({ email: `rls-1248-admin-${TS}@homegohan.test`, roles: ['admin'] }),
    createRlsTestUser({ email: `rls-1248-sa-${TS}@homegohan.test`, roles: ['super_admin'] }),
    createRlsTestUser({
      email: `rls-1248-otherops-${TS}@homegohan.test`,
      roles: ['sales', 'finance', 'content_moderator', 'org_admin'],
    }),
  ]);
}, 60_000);

afterAll(async () => {
  // support_tickets.user_id の FK (ON DELETE なし) があるため、チケットを先に消す。メッセージは CASCADE
  const { data: tickets } = await srAdmin
    .from('support_tickets')
    .select('id')
    .like('subject', `${SUBJECT_PREFIX} %`);
  const ticketIds = (tickets ?? []).map((t) => t.id as string);
  if (ticketIds.length > 0) {
    await srAdmin.from('support_tickets').delete().in('id', ticketIds);
    const { data: leftover } = await srAdmin
      .from('support_ticket_messages')
      .select('id')
      .in('ticket_id', ticketIds);
    expect(leftover ?? []).toEqual([]);
  }

  const users = [customer, other, support, admin, superAdmin, otherOps].filter((u) => u?.userId);
  await srAdmin
    .from('admin_audit_logs')
    .delete()
    .in('actor_id', users.map((u) => u.userId));
  for (const u of users) {
    await deleteRlsTestUser(u.userId);
  }
}, 30_000);

// ================================================================
// RLS (PostgREST 直叩き)
// ================================================================
describe('#1248 support_tickets INSERT (RLS)', () => {
  it('R-1: support は顧客の user_id でチケットを起票できる', async () => {
    const { data, error } = await authedClient(support.jwt)
      .from('support_tickets')
      .insert(ticketRow(customer.userId, 'R-1'))
      .select('id, user_id')
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(customer.userId);
    expect(await countTickets('R-1')).toBe(1);
  });

  it('R-2: admin は顧客の user_id でチケットを起票できる', async () => {
    const { data, error } = await authedClient(admin.jwt)
      .from('support_tickets')
      .insert(ticketRow(customer.userId, 'R-2'))
      .select('id, user_id')
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(customer.userId);
    expect(await countTickets('R-2')).toBe(1);
  });

  it('R-3: super_admin は顧客の user_id でチケットを起票できる', async () => {
    const { data, error } = await authedClient(superAdmin.jwt)
      .from('support_tickets')
      .insert(ticketRow(customer.userId, 'R-3'))
      .select('id, user_id')
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(customer.userId);
    expect(await countTickets('R-3')).toBe(1);
  });

  it('R-4: support / admin / super_admin 以外の運営系ロールは代理起票できない (42501)', async () => {
    const { error } = await authedClient(otherOps.jwt)
      .from('support_tickets')
      .insert(ticketRow(customer.userId, 'R-4'));
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await countTickets('R-4')).toBe(0);
  });

  it('R-5: 一般ユーザーは他人の user_id でチケットを起票できない (42501)', async () => {
    const { error } = await authedClient(other.jwt)
      .from('support_tickets')
      .insert(ticketRow(customer.userId, 'R-5'));
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await countTickets('R-5')).toBe(0);
  });

  it('R-6: 未認証 (anon) は起票できない (42501)', async () => {
    const { error } = await anonClient()
      .from('support_tickets')
      .insert(ticketRow(customer.userId, 'R-6'));
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
    expect(await countTickets('R-6')).toBe(0);
  });

  it('R-7: 一般ユーザーは自分の user_id でなら起票できる (tickets_insert_user は従来どおり)', async () => {
    const { data, error } = await authedClient(customer.jwt)
      .from('support_tickets')
      .insert(ticketRow(customer.userId, 'R-7'))
      .select('id, user_id')
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(customer.userId);
    expect(await countTickets('R-7')).toBe(1);
  });
});

// ================================================================
// 運営画面の API (POST /api/admin/support/tickets)
// ================================================================
describe('#1248 POST /api/admin/support/tickets (顧客の代理起票)', () => {
  it('A-1: support が顧客の代理で起票すると 201。チケットと最初のメッセージ (運営の送信・非内部) が作られる', async () => {
    const body = `${SUBJECT_PREFIX} A-1 body`;
    const res = await apiCall('POST', '/api/admin/support/tickets', support.jwt, {
      user_id: customer.userId,
      subject: `${SUBJECT_PREFIX} A-1`,
      category: 'billing',
      priority: 'medium',
      body,
    });
    expect(res.status).toBe(201);
    const ticket = (res.body as { data: { id: string; user_id: string; status: string } }).data;
    expect(ticket.user_id).toBe(customer.userId);
    expect(ticket.status).toBe('open');

    const { data: messages } = await srAdmin
      .from('support_ticket_messages')
      .select('sender_id, is_internal, body')
      .eq('ticket_id', ticket.id);
    expect(messages).toEqual([{ sender_id: support.userId, is_internal: false, body }]);
  });

  it('A-2: admin が顧客の代理で起票すると 201', async () => {
    const res = await apiCall('POST', '/api/admin/support/tickets', admin.jwt, {
      user_id: customer.userId,
      subject: `${SUBJECT_PREFIX} A-2`,
      category: 'other',
      priority: 'low',
      body: `${SUBJECT_PREFIX} A-2 body`,
    });
    expect(res.status).toBe(201);
    expect((res.body as { data: { user_id: string } }).data.user_id).toBe(customer.userId);
  });

  it('A-3: 顧客は運営が代理で起票した自分のチケットと最初のメッセージを読める', async () => {
    const { data: tickets, error } = await authedClient(customer.jwt)
      .from('support_tickets')
      .select('id')
      .eq('subject', `${SUBJECT_PREFIX} A-1`);
    expect(error).toBeNull();
    expect((tickets ?? []).length).toBe(1);

    const { data: messages, error: msgError } = await authedClient(customer.jwt)
      .from('support_ticket_messages')
      .select('body')
      .eq('ticket_id', tickets![0].id);
    expect(msgError).toBeNull();
    expect(messages).toEqual([{ body: `${SUBJECT_PREFIX} A-1 body` }]);
  });

  it('A-4: 別の一般ユーザーは運営が代理で起票した他人のチケットを読めない (0 行)', async () => {
    const { data, error } = await authedClient(other.jwt)
      .from('support_tickets')
      .select('id')
      .eq('subject', `${SUBJECT_PREFIX} A-1`);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('A-5: 一般ユーザーが API で代理起票しようとすると 403 で、チケットは作られない', async () => {
    const res = await apiCall('POST', '/api/admin/support/tickets', other.jwt, {
      user_id: customer.userId,
      subject: `${SUBJECT_PREFIX} A-5`,
      category: 'other',
      priority: 'low',
      body: `${SUBJECT_PREFIX} A-5 body`,
    });
    expect(res.status).toBe(403);
    expect(await countTickets('A-5')).toBe(0);
  });
});
