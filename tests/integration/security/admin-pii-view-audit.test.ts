/**
 * #1200 管理者・サポートによるユーザー PII 閲覧が admin_audit_logs に記録されること
 * (実 DB の列・制約・RLS と、実際の API ルートを通した確認)
 *
 * 単体テスト (tests/admin-pii-view-audit.test.ts) はモックなので、次の点はここで実物を確認する:
 *   - 運営ロール (admin / support) の user-scoped client で INSERT が RLS を通ること
 *     (audit_logs_insert_admins: actor_id = auth.uid() かつ運営ロール)
 *   - x-forwarded-for に複数 IP が入っていても、ip_address (inet) には先頭の 1 IP が入り、
 *     INSERT が失敗しないこと
 *   - 閲覧された「本人」(target_id) と閲覧者 (actor_id) で、開示請求のときに引けること
 *   - ノート追加の監査が、存在しない列 admin_id ではなく actor_id で実際に保存されること
 *   - 404 / 403 では記録されないこと
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/admin-pii-view-audit.test.ts
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const createdUserIds: string[] = [];
const NICKNAME_PREFIX = '#1200-view-audit';

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-view-audit-${label}-${TS}@homegohan.test`;
  // テスト用ユーザーのパスワードは固定値を置かず、実行ごとに作る
  const password = `Aa1!${randomUUID()}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const { error: profileError } = await srAdmin.from('user_profiles').upsert(
    { id: data.user.id, nickname: `${NICKNAME_PREFIX}-${label}-${TS}`, age_group: '30s', gender: 'other' },
    { onConflict: 'id' },
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);

  // roles は特権列ガードにより本人では変更できないため service_role で設定する
  if (roles) {
    const { error: roleError } = await srAdmin.from('user_profiles').update({ roles }).eq('id', data.user.id);
    if (roleError) throw new Error(`roles ${label}: ${roleError.message}`);
  }

  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  jwt: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt}`,
    // Next.js の SSR 認証は cookie も読むため、tests/integration/helpers/api.ts と同様に両方付ける
    Cookie: `sb-access-token=${jwt}`,
    ...opts.headers,
  };
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // JSON 以外はそのまま
  }
  return { status: res.status, body };
}

interface AuditRow {
  id: string;
  actor_id: string | null;
  action_type: string;
  target_id: string | null;
  target_type: string | null;
  severity: string;
  details: Record<string, any> | null;
  ip_address: string | null;
  user_agent: string | null;
}

async function auditRows(filter: { actorId: string; actionType?: string; targetId?: string }): Promise<AuditRow[]> {
  let query = srAdmin.from('admin_audit_logs').select('*').eq('actor_id', filter.actorId);
  if (filter.actionType) query = query.eq('action_type', filter.actionType);
  if (filter.targetId) query = query.eq('target_id', filter.targetId);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw new Error(`auditRows: ${error.message}`);
  return (data ?? []) as AuditRow[];
}

let admin: TestUser;
let support: TestUser;
let general: TestUser;
let target: TestUser;
let ticketId = '';

const SECRET_SUBJECT = `相談の件名 ${TS}`;
const SECRET_BODY = `相談の本文 ${TS}`;

const FORWARDED_FOR = '203.0.113.7, 70.41.3.18';
const USER_AGENT = `it-1200/${TS}`;
const viewHeaders = { 'x-forwarded-for': FORWARDED_FOR, 'user-agent': USER_AGENT };

beforeAll(async () => {
  [admin, support, general, target] = await Promise.all([
    createUser('admin', ['admin']),
    createUser('support', ['support']),
    createUser('general'),
    createUser('target'),
  ]);

  // 閲覧される側のチケット・メッセージ・管理ノート (service_role で作る)
  const { data: ticket, error: ticketError } = await srAdmin
    .from('support_tickets')
    .insert({ user_id: target.id, subject: SECRET_SUBJECT, category: 'account', priority: 'medium', status: 'open' })
    .select('id')
    .single();
  if (ticketError || !ticket) throw new Error(`ticket: ${ticketError?.message}`);
  ticketId = ticket.id as string;

  const { error: messageError } = await srAdmin
    .from('support_ticket_messages')
    .insert({ ticket_id: ticketId, sender_id: target.id, is_internal: false, body: SECRET_BODY });
  if (messageError) throw new Error(`message: ${messageError.message}`);
}, 90_000);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // actor_id の外部キー (NO ACTION) があるため、ユーザー削除より先に監査ログを消す (service_role のみ可能)
    await srAdmin.from('admin_audit_logs').delete().in('actor_id', createdUserIds);
    await srAdmin.from('admin_user_notes').delete().in('user_id', createdUserIds);
  }
  if (ticketId) {
    await srAdmin.from('support_ticket_messages').delete().eq('ticket_id', ticketId);
    await srAdmin.from('support_tickets').delete().eq('id', ticketId);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('#1200 GET /api/admin/users/[id] -> admin.user.view', () => {
  it('admin が閲覧すると、actor / target / action / IP / User-Agent が 1 行保存される', async () => {
    const res = await call('GET', `/api/admin/users/${target.id}`, admin.jwt, { headers: viewHeaders });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(target.id);

    const rows = await auditRows({ actorId: admin.id, actionType: 'admin.user.view', targetId: target.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: admin.id,
      action_type: 'admin.user.view',
      target_id: target.id,
      target_type: 'user',
      severity: 'info',
      user_agent: USER_AGENT,
    });
    // x-forwarded-for が複数 IP でも inet 列に入る (先頭の 1 IP だけ)
    expect(rows[0].ip_address).toBe('203.0.113.7');
  });

  it('details は項目名だけで、閲覧した値 (ニックネーム) を含まない', async () => {
    const rows = await auditRows({ actorId: admin.id, actionType: 'admin.user.view', targetId: target.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].details?.viewed_fields).toEqual(expect.arrayContaining(['id', 'nickname', 'roles']));
    expect(JSON.stringify(rows[0].details)).not.toContain(NICKNAME_PREFIX);
  });

  it('support ロールが閲覧しても記録される (actor_id は support 本人)', async () => {
    const res = await call('GET', `/api/admin/users/${target.id}`, support.jwt, { headers: viewHeaders });
    expect(res.status).toBe(200);

    const rows = await auditRows({ actorId: support.id, actionType: 'admin.user.view', targetId: target.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(support.id);
  });

  it('対象ユーザーがいない (404) ときは記録しない', async () => {
    const missingId = '00000000-0000-4000-8000-000000001200';
    const res = await call('GET', `/api/admin/users/${missingId}`, admin.jwt, { headers: viewHeaders });
    expect(res.status).toBe(404);

    const rows = await auditRows({ actorId: admin.id, targetId: missingId });
    expect(rows).toHaveLength(0);
  });

  it('権限が無い一般ユーザー (403) のときは何も記録しない', async () => {
    const res = await call('GET', `/api/admin/users/${target.id}`, general.jwt, { headers: viewHeaders });
    expect(res.status).toBe(403);

    const rows = await auditRows({ actorId: general.id });
    expect(rows).toHaveLength(0);
  });
});

describe('#1200 チケットとサポート画面のユーザー詳細の閲覧', () => {
  it('チケット詳細: 閲覧された本人 (チケットを作ったユーザー) を target にして記録する', async () => {
    const res = await call('GET', `/api/admin/support/tickets/${ticketId}`, support.jwt, { headers: viewHeaders });
    expect(res.status).toBe(200);
    expect(res.body.data.subject).toBe(SECRET_SUBJECT);

    const rows = await auditRows({ actorId: support.id, actionType: 'admin.support.ticket.view' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_id: target.id,
      target_type: 'user',
      severity: 'info',
      ip_address: '203.0.113.7',
      user_agent: USER_AGENT,
    });
    expect(rows[0].details?.ticket_id).toBe(ticketId);
    // 件名・本文の値は details に入れない
    expect(JSON.stringify(rows[0].details)).not.toContain(SECRET_SUBJECT);
    expect(JSON.stringify(rows[0].details)).not.toContain(SECRET_BODY);
  });

  it('メッセージ一覧: 同じく本人を target にして記録する', async () => {
    const res = await call('GET', `/api/admin/support/tickets/${ticketId}/messages`, support.jwt, {
      headers: viewHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const rows = await auditRows({ actorId: support.id, actionType: 'admin.support.ticket.view_messages' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_id: target.id, target_type: 'user', ip_address: '203.0.113.7' });
    expect(rows[0].details?.ticket_id).toBe(ticketId);
    expect(JSON.stringify(rows[0].details)).not.toContain(SECRET_BODY);
  });

  it('サポート画面のユーザー詳細: 返したときに記録する (自分自身の詳細で確認)', async () => {
    // GET /api/support/users/[id] は user_profiles を本人の権限 (RLS: 自分の行のみ) で読むため、
    // 現状は自分自身の id でだけ 200 になる。他人の id が読めない件は本 Issue の対象外。
    const res = await call('GET', `/api/support/users/${support.id}`, support.jwt, { headers: viewHeaders });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(support.id);

    const rows = await auditRows({ actorId: support.id, actionType: 'admin.user.view_support' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_id: support.id,
      target_type: 'user',
      severity: 'info',
      ip_address: '203.0.113.7',
      user_agent: USER_AGENT,
    });
    expect(rows[0].details?.viewed_fields).toEqual(
      expect.arrayContaining(['user.nickname', 'user.ageGroup', 'user.gender', 'stats', 'inquiries', 'notes']),
    );
    expect(JSON.stringify(rows[0].details)).not.toContain(NICKNAME_PREFIX);
  });
});

describe('#1200 ノート追加の監査 (旧実装は存在しない列 admin_id に書いて黙って失敗していた)', () => {
  it('POST で追加すると、actor_id で admin.user.note_add が保存される', async () => {
    // POST /api/support/users/[id]/notes は対象の存在確認を本人の権限 (user_profiles は RLS で自分の行のみ)
    // で行うため、現状は自分自身の id でだけ 200 になる。他人の id が 404 になる件は本 Issue の対象外。
    const res = await call('POST', `/api/support/users/${support.id}/notes`, support.jwt, {
      body: { note: `追加するノート ${TS}` },
      headers: viewHeaders,
    });
    expect(res.status).toBe(200);
    const noteId = res.body.note.id as string;

    const rows = await auditRows({ actorId: support.id, actionType: 'admin.user.note_add', targetId: support.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: support.id,
      target_type: 'user',
      severity: 'info',
      ip_address: '203.0.113.7',
    });
    expect(rows[0].details).toEqual({ note_id: noteId });
  });
});
