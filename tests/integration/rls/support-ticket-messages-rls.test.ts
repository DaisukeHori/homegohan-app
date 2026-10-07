/**
 * #1233 support_ticket_messages RLS 所有権検証の回帰テスト
 *
 * 修正前のポリシー (20260508120000_operator_phase_4_5_foundation.sql) は
 *   ticket_messages_select: USING (NOT is_internal OR <staff>)   ← 所有権条件なし
 *   ticket_messages_insert: WITH CHECK (sender_id = auth.uid())  ← ticket の所有権検証なし
 * のため、未認証を含む誰でも全ユーザーの非内部メッセージを読め、
 * 認証済みなら他人のチケットへ (is_internal=true を含め) 投稿できた。
 *
 * 期待する認可 (修正後):
 *   - SELECT: チケット所有者は自分のチケットの is_internal=false のみ。staff (support/admin/super_admin) は全件
 *   - INSERT: sender_id = auth.uid() を全員に必須。所有者は自チケットへ is_internal=false のみ、staff は任意チケットへ可
 *   - UPDATE / DELETE: ポリシー無し (暗黙 DENY)
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/support-ticket-messages-rls.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

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
// クライアントファクトリ (rls-policy-smoke.test.ts と同型)
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
// テストユーザー (rls-policy-smoke.test.ts と同型)
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
//   O: チケット T の所有者 / A: 攻撃者 (チケット X の所有者) / S: staff (support)
//   M1 = (T, sender=O, internal=false) / M2 = (T, sender=S, internal=true) / M3 = (X, sender=A, internal=false)
// ---------------------------------------------------------------
const TS = Date.now();

let owner: RlsTestUser;
let attacker: RlsTestUser;
let staff: RlsTestUser;
let ticketT: string;
let ticketX: string;
let m1: string;
let m2: string;
let m3: string;

async function insertTicket(userId: string, subject: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('support_tickets')
    .insert({ user_id: userId, subject, category: 'other', priority: 'medium', status: 'open' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to insert ticket: ${error?.message}`);
  return data.id as string;
}

async function insertMessage(ticketId: string, senderId: string, isInternal: boolean, body: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('support_ticket_messages')
    .insert({ ticket_id: ticketId, sender_id: senderId, is_internal: isInternal, body })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to insert message: ${error?.message}`);
  return data.id as string;
}

/** 成功した INSERT の行が実在することを service_role で確認し、即削除する */
async function expectInsertedAndCleanup(body: string): Promise<void> {
  const { data } = await srAdmin.from('support_ticket_messages').select('id').eq('body', body);
  expect((data ?? []).length).toBe(1);
  await srAdmin.from('support_ticket_messages').delete().eq('body', body);
}

beforeAll(async () => {
  owner = await createRlsTestUser({ email: `rls-1233-owner-${TS}@homegohan.test`, roles: ['user'] });
  attacker = await createRlsTestUser({ email: `rls-1233-attacker-${TS}@homegohan.test`, roles: ['user'] });
  staff = await createRlsTestUser({ email: `rls-1233-staff-${TS}@homegohan.test`, roles: ['support'] });

  ticketT = await insertTicket(owner.userId, `#1233 owner ticket ${TS}`);
  ticketX = await insertTicket(attacker.userId, `#1233 attacker ticket ${TS}`);

  m1 = await insertMessage(ticketT, owner.userId, false, `#1233 M1 owner public ${TS}`);
  m2 = await insertMessage(ticketT, staff.userId, true, `#1233 M2 staff internal ${TS}`);
  m3 = await insertMessage(ticketX, attacker.userId, false, `#1233 M3 attacker public ${TS}`);
}, 60_000);

afterAll(async () => {
  // メッセージはチケット削除で CASCADE。sender_id の FK があるためユーザー削除はその後
  const ticketIds = [ticketT, ticketX].filter(Boolean);
  if (ticketIds.length > 0) {
    await srAdmin.from('support_tickets').delete().in('id', ticketIds);
    const { data: leftover } = await srAdmin
      .from('support_ticket_messages')
      .select('id')
      .in('ticket_id', ticketIds);
    expect(leftover ?? []).toEqual([]);
  }
  for (const u of [owner, attacker, staff]) {
    if (u?.userId) await deleteRlsTestUser(u.userId);
  }
}, 30_000);

// ================================================================
// SELECT
// ================================================================
describe('#1233 support_ticket_messages SELECT', () => {
  it('S-1: anon は全件 SELECT しても 0 行 (未認証での漏洩を塞ぐ)', async () => {
    const { data, error } = await anonClient().from('support_ticket_messages').select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('S-2: anon がチケット T を指定して SELECT しても 0 行', async () => {
    const { data, error } = await anonClient()
      .from('support_ticket_messages')
      .select('id')
      .eq('ticket_id', ticketT);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('S-3: 攻撃者 A は他人のチケット T のメッセージを読めない (0 行)', async () => {
    const { data, error } = await authedClient(attacker.jwt)
      .from('support_ticket_messages')
      .select('id')
      .eq('ticket_id', ticketT);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('S-4: 攻撃者 A に見えるのは自分のチケット X の非内部メッセージ M3 だけ', async () => {
    const { data, error } = await authedClient(attacker.jwt)
      .from('support_ticket_messages')
      .select('id')
      .in('ticket_id', [ticketT, ticketX]);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([m3]);
  });

  it('S-5: 所有者 O は自分のチケット T の非内部メッセージ M1 だけ読める (内部メモ M2 は見えない)', async () => {
    const { data, error } = await authedClient(owner.jwt)
      .from('support_ticket_messages')
      .select('id')
      .eq('ticket_id', ticketT);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([m1]);
  });

  it('S-6: staff はチケット T の全メッセージ (M1 + 内部メモ M2) を読める', async () => {
    const { data, error } = await authedClient(staff.jwt)
      .from('support_ticket_messages')
      .select('id')
      .eq('ticket_id', ticketT);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id).sort()).toEqual([m1, m2].sort());
  });
});

// ================================================================
// INSERT
// ================================================================
describe('#1233 support_ticket_messages INSERT', () => {
  it('I-1: anon は投稿できない (42501)', async () => {
    const { error } = await anonClient()
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketT, sender_id: owner.userId, is_internal: false, body: `#1233 I-1 ${TS}` });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('I-2: 攻撃者 A は他人のチケット T へ投稿できない (42501)', async () => {
    const { error } = await authedClient(attacker.jwt)
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketT, sender_id: attacker.userId, is_internal: false, body: `#1233 I-2 ${TS}` });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('I-3: 攻撃者 A は他人のチケット T の内部スレッドへ投稿できない (42501)', async () => {
    const { error } = await authedClient(attacker.jwt)
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketT, sender_id: attacker.userId, is_internal: true, body: `#1233 I-3 ${TS}` });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('I-4: 攻撃者 A は所有者 O になりすまして投稿できない (42501)', async () => {
    const { error } = await authedClient(attacker.jwt)
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketT, sender_id: owner.userId, is_internal: false, body: `#1233 I-4 ${TS}` });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('I-5: 所有者 O は自分のチケット T へ非内部メッセージを投稿できる', async () => {
    const body = `#1233 I-5 ${TS}`;
    const { error } = await authedClient(owner.jwt)
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketT, sender_id: owner.userId, is_internal: false, body });
    expect(error).toBeNull();
    await expectInsertedAndCleanup(body);
  });

  it('I-6: 所有者 O は内部メモ (is_internal=true) を投稿できない (42501)', async () => {
    const { error } = await authedClient(owner.jwt)
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketT, sender_id: owner.userId, is_internal: true, body: `#1233 I-6 ${TS}` });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('I-7: 所有者 O でも他人のチケット X へは投稿できない (42501)', async () => {
    const { error } = await authedClient(owner.jwt)
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketX, sender_id: owner.userId, is_internal: false, body: `#1233 I-7 ${TS}` });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('I-8: staff は任意のチケット T へ内部メモを投稿できる', async () => {
    const body = `#1233 I-8 ${TS}`;
    const { error } = await authedClient(staff.jwt)
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketT, sender_id: staff.userId, is_internal: true, body });
    expect(error).toBeNull();
    await expectInsertedAndCleanup(body);
  });

  it('I-9: staff でも他人 (所有者 O) になりすまして投稿できない (42501)', async () => {
    const { error } = await authedClient(staff.jwt)
      .from('support_ticket_messages')
      .insert({ ticket_id: ticketT, sender_id: owner.userId, is_internal: false, body: `#1233 I-9 ${TS}` });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });
});

// ================================================================
// UPDATE / DELETE (ポリシー無し = 暗黙 DENY)
// ================================================================
describe('#1233 support_ticket_messages UPDATE / DELETE', () => {
  it('U-1: 攻撃者 A は他人のメッセージ M1 を書き換えられない (0 行・本文不変)', async () => {
    const { data, error } = await authedClient(attacker.jwt)
      .from('support_ticket_messages')
      .update({ body: `#1233 tampered ${TS}` })
      .eq('id', m1)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const { data: row } = await srAdmin.from('support_ticket_messages').select('body').eq('id', m1).single();
    expect(row?.body).toBe(`#1233 M1 owner public ${TS}`);
  });

  it('D-1: 攻撃者 A は他人のメッセージ M1 を削除できない (0 行・行は残る)', async () => {
    const { data, error } = await authedClient(attacker.jwt)
      .from('support_ticket_messages')
      .delete()
      .eq('id', m1)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const { data: row } = await srAdmin.from('support_ticket_messages').select('id').eq('id', m1);
    expect((row ?? []).length).toBe(1);
  });
});
