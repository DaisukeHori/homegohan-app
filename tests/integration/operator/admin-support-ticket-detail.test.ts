/**
 * Integration tests: 運営サポートチケット詳細 API (#849 / T07)
 *   GET   /api/admin/support/tickets/[id]
 *   PATCH /api/admin/support/tickets/[id]
 *   POST  /api/admin/support/tickets/[id]/assign
 *   GET   /api/admin/support/tickets/[id]/messages
 *   POST  /api/admin/support/tickets/[id]/messages
 *
 * 権限: support / admin / super_admin。ほかのロール (sales など) と一般ユーザーは 403、未認証は 401。
 * 入力エラーは 400 + code=VALIDATION_ERROR (AC の「422 相当」はこの 400)。
 *
 * テストデータは service_role で直接 seed する (別のエンドポイントの動作に依存しない)。
 * 各テストが自分用のチケットを作るので、実行順や他テストの状態に左右されない。
 *
 * 実行: CONTRIBUTING.md の「インテグレーションテスト」(ローカル Supabase + Next dev サーバ) を参照。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth, apiCallRaw } from '../helpers/api';
import {
  TestUserPool,
  dataOf,
  expectError,
  latestAuditLog,
  randomUuid,
} from '../helpers/admin-test-utils';

const TS = Date.now();
const pool = new TestUserPool(TS, 'tdsup');

let supportUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser; // 権限なし (role=user)
let salesUser: TestUser; // 運営だが support ではない (別ドメインのスタッフは 403)
let ownerUser: TestUser; // チケットの起票者 (お客さま)

const createdTicketIds: string[] = [];
let seq = 0;

interface TicketRow {
  id: string;
  user_id: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

interface MessageRow {
  id: string;
  ticket_id: string;
  sender_id: string;
  is_internal: boolean;
  body: string;
  attachments: unknown;
}

/** service_role でチケットを 1 件作る (後片付け対象に登録) */
async function seedTicket(
  overrides: { status?: string; priority?: string; assigneeId?: string | null } = {},
): Promise<string> {
  seq += 1;
  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .insert({
      user_id: ownerUser.userId,
      subject: `T849 integration ticket ${TS}-${seq}`,
      category: 'billing',
      priority: overrides.priority ?? 'medium',
      status: overrides.status ?? 'open',
      assignee_id: overrides.assigneeId ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seedTicket failed: ${error?.message}`);
  createdTicketIds.push(data.id as string);
  return data.id as string;
}

/** service_role でメッセージを 1 件作る。created_at を固定して並び順を決定的にする */
async function seedMessage(
  ticketId: string,
  params: { senderId: string; body: string; isInternal: boolean; createdAt: string },
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('support_ticket_messages')
    .insert({
      ticket_id: ticketId,
      sender_id: params.senderId,
      is_internal: params.isInternal,
      body: params.body,
      created_at: params.createdAt,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seedMessage failed: ${error?.message}`);
  return data.id as string;
}

async function readTicket(ticketId: string): Promise<TicketRow> {
  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .select('*')
    .eq('id', ticketId)
    .single();
  if (error || !data) throw new Error(`readTicket failed: ${error?.message}`);
  return data as TicketRow;
}

async function readMessages(ticketId: string): Promise<MessageRow[]> {
  const { data, error } = await supabaseAdmin
    .from('support_ticket_messages')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`readMessages failed: ${error.message}`);
  return (data ?? []) as MessageRow[];
}

beforeAll(async () => {
  ({ supportUser, adminUser, superAdminUser, generalUser, salesUser, ownerUser } =
    await pool.createMany({
      supportUser: ['support'],
      adminUser: ['admin'],
      superAdminUser: ['super_admin'],
      generalUser: ['user'],
      salesUser: ['sales'],
      ownerUser: ['user'],
    }));
}, 60000);

afterAll(async () => {
  // support_tickets.user_id / support_ticket_messages.sender_id は auth.users への外部キー (NO ACTION)。
  // ユーザーより先にチケット (メッセージは ON DELETE CASCADE) を消す。
  if (createdTicketIds.length > 0) {
    await supabaseAdmin.from('support_ticket_messages').delete().in('ticket_id', createdTicketIds);
    await supabaseAdmin.from('support_tickets').delete().in('id', createdTicketIds);
  }

  // #1183: RESEND_API_KEY がある環境で流すと、顧客向け返信の送信ログが顧客 (= チケットの user_id のテストユーザー) の
  // user_id で email_delivery_logs に残る。user_id の FK (NO ACTION) が下の deleteUser を失敗させるため、先に消す
  const userIds = [supportUser, adminUser, superAdminUser, generalUser, salesUser, ownerUser]
    .filter((u): u is TestUser => Boolean(u))
    .map((u) => u.userId);
  if (userIds.length > 0) {
    await supabaseAdmin.from('email_delivery_logs').delete().in('user_id', userIds);
  }

  await pool.cleanup();
}, 60000);

// ─── GET /api/admin/support/tickets/[id] ──────────────────────────────────────

describe('GET /api/admin/support/tickets/[id]', () => {
  it('200 for support role - returns the ticket with an empty messages array', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('GET', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt);
    const data = dataOf<Record<string, unknown>>(res);
    expect(data).toMatchObject({
      id: ticketId,
      user_id: ownerUser.userId,
      category: 'billing',
      priority: 'medium',
      status: 'open',
      assignee_id: null,
      first_response_at: null,
    });
    expect(data.messages).toEqual([]);
  });

  it('200 for admin role', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('GET', `/api/admin/support/tickets/${ticketId}`, adminUser.jwt);
    expect(dataOf<{ id: string }>(res).id).toBe(ticketId);
  });

  it('200 for super_admin role', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('GET', `/api/admin/support/tickets/${ticketId}`, superAdminUser.jwt);
    expect(dataOf<{ id: string }>(res).id).toBe(ticketId);
  });

  it('200 includes messages in chronological order, internal notes included', async () => {
    const ticketId = await seedTicket();
    await seedMessage(ticketId, {
      senderId: ownerUser.userId,
      body: 'first (customer)',
      isInternal: false,
      createdAt: '2026-01-01T00:00:00Z',
    });
    await seedMessage(ticketId, {
      senderId: supportUser.userId,
      body: 'second (internal note)',
      isInternal: true,
      createdAt: '2026-01-02T00:00:00Z',
    });
    await seedMessage(ticketId, {
      senderId: supportUser.userId,
      body: 'third (reply)',
      isInternal: false,
      createdAt: '2026-01-03T00:00:00Z',
    });

    const res = await apiCall('GET', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt);
    const data = dataOf<{ messages: Array<{ body: string; is_internal: boolean }> }>(res);
    expect(data.messages.map((m) => m.body)).toEqual([
      'first (customer)',
      'second (internal note)',
      'third (reply)',
    ]);
    expect(data.messages.map((m) => m.is_internal)).toEqual([false, true, false]);
  });

  it('404 for a ticket that does not exist', async () => {
    const res = await apiCall('GET', `/api/admin/support/tickets/${randomUuid()}`, supportUser.jwt);
    expectError(res, 404, 'NOT_FOUND');
  });

  it('404 for an id that is not a UUID', async () => {
    const res = await apiCall('GET', '/api/admin/support/tickets/not-a-uuid', supportUser.jwt);
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('GET', `/api/admin/support/tickets/${ticketId}`, generalUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for sales role (staff of another domain)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('GET', `/api/admin/support/tickets/${ticketId}`, salesUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const ticketId = await seedTicket();
    const res = await apiCallNoAuth('GET', `/api/admin/support/tickets/${ticketId}`);
    expectError(res, 401);
  });
});

// ─── PATCH /api/admin/support/tickets/[id] ────────────────────────────────────

describe('PATCH /api/admin/support/tickets/[id]', () => {
  it('200 for support role - updates status and writes an audit log', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt, {
      status: 'in_progress',
    });
    expect(dataOf<{ id: string; status: string }>(res)).toMatchObject({
      id: ticketId,
      status: 'in_progress',
    });
    expect((await readTicket(ticketId)).status).toBe('in_progress');

    const log = await latestAuditLog({
      actorId: supportUser.userId,
      actionType: 'admin.support.ticket.update',
      targetId: ticketId,
    });
    expect(log).not.toBeNull();
    expect(log!.target_type).toBe('support_ticket');
    expect(log!.details).toMatchObject({ status: 'in_progress' });
  });

  it('200 for admin role - updates priority', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, adminUser.jwt, {
      priority: 'high',
    });
    expect(dataOf<{ priority: string }>(res).priority).toBe('high');
    expect((await readTicket(ticketId)).priority).toBe('high');
  });

  it('200 for super_admin role', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, superAdminUser.jwt, {
      status: 'pending',
    });
    expect(dataOf<{ status: string }>(res).status).toBe('pending');
  });

  it('200 resolving a ticket sets resolved_at', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt, {
      status: 'resolved',
    });
    expect(dataOf<{ resolved_at: string | null }>(res).resolved_at).not.toBeNull();
    const row = await readTicket(ticketId);
    expect(row.resolved_at).not.toBeNull();
    expect(row.closed_at).toBeNull();
  });

  it('200 closing a ticket sets closed_at', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt, {
      status: 'closed',
    });
    expect(dataOf<{ closed_at: string | null }>(res).closed_at).not.toBeNull();
    const row = await readTicket(ticketId);
    expect(row.closed_at).not.toBeNull();
    expect(row.resolved_at).toBeNull();
  });

  it('200 the assignee can be cleared with null', async () => {
    const ticketId = await seedTicket({ assigneeId: supportUser.userId });
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, adminUser.jwt, {
      assignee_id: null,
    });
    expect(dataOf<{ assignee_id: string | null }>(res).assignee_id).toBeNull();
    expect((await readTicket(ticketId)).assignee_id).toBeNull();
  });

  it('400 for invalid status (validation error) and leaves the ticket untouched', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt, {
      status: 'INVALID_STATUS',
    });
    expectError(res, 400, 'VALIDATION_ERROR');
    expect((await readTicket(ticketId)).status).toBe('open');
  });

  it('400 for invalid priority', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt, {
      priority: 'critical',
    });
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('400 for assignee_id that is not a UUID', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt, {
      assignee_id: 'not-a-uuid',
    });
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('400 for an empty object (at least one field is required)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, supportUser.jwt, {});
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('404 for a ticket that does not exist', async () => {
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${randomUuid()}`, supportUser.jwt, {
      status: 'in_progress',
    });
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user and leaves the ticket untouched', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, generalUser.jwt, {
      status: 'resolved',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect((await readTicket(ticketId)).status).toBe('open');
  });

  it('403 for sales role (staff of another domain)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall('PATCH', `/api/admin/support/tickets/${ticketId}`, salesUser.jwt, {
      status: 'resolved',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const ticketId = await seedTicket();
    const res = await apiCallNoAuth('PATCH', `/api/admin/support/tickets/${ticketId}`, {
      status: 'resolved',
    });
    expectError(res, 401);
  });

  // 既知の不具合: request.json() の SyntaxError を握っておらず、汎用の catch で 500 になる。
  // (moderation の [type]/[id] や users/[id]/freeze は INVALID_JSON の 400 を返している)
  // 直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 400 for malformed JSON body (現状は 500 INTERNAL_ERROR)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCallRaw(
      'PATCH',
      `/api/admin/support/tickets/${ticketId}`,
      supportUser.jwt,
      '{"status": ',
    );
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/admin/support/tickets/[id]/assign ──────────────────────────────

describe('POST /api/admin/support/tickets/[id]/assign', () => {
  it('200 for support role - assigns the ticket and writes an audit log', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/assign`,
      supportUser.jwt,
      { assignee_id: supportUser.userId },
    );
    expect(dataOf<{ id: string; assignee_id: string }>(res)).toMatchObject({
      id: ticketId,
      assignee_id: supportUser.userId,
    });
    expect((await readTicket(ticketId)).assignee_id).toBe(supportUser.userId);

    const log = await latestAuditLog({
      actorId: supportUser.userId,
      actionType: 'admin.support.ticket.assign',
      targetId: ticketId,
    });
    expect(log).not.toBeNull();
    expect(log!.details).toMatchObject({ assignee_id: supportUser.userId });
  });

  it('200 for admin role - can assign to another staff member', async () => {
    const ticketId = await seedTicket({ assigneeId: supportUser.userId });
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/assign`,
      adminUser.jwt,
      { assignee_id: adminUser.userId },
    );
    expect(dataOf<{ assignee_id: string }>(res).assignee_id).toBe(adminUser.userId);
  });

  it('200 for super_admin role', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/assign`,
      superAdminUser.jwt,
      { assignee_id: superAdminUser.userId },
    );
    expect(dataOf<{ assignee_id: string }>(res).assignee_id).toBe(superAdminUser.userId);
  });

  it('400 for assignee_id that is not a UUID', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/assign`,
      supportUser.jwt,
      { assignee_id: 'not-a-uuid' },
    );
    expectError(res, 400, 'VALIDATION_ERROR');
    expect((await readTicket(ticketId)).assignee_id).toBeNull();
  });

  it('400 for missing assignee_id', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/assign`,
      supportUser.jwt,
      {},
    );
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('404 for a ticket that does not exist', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${randomUuid()}/assign`,
      supportUser.jwt,
      { assignee_id: supportUser.userId },
    );
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user and leaves the ticket unassigned', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/assign`,
      generalUser.jwt,
      { assignee_id: generalUser.userId },
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect((await readTicket(ticketId)).assignee_id).toBeNull();
  });

  it('403 for sales role (staff of another domain)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/assign`,
      salesUser.jwt,
      { assignee_id: salesUser.userId },
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const ticketId = await seedTicket();
    const res = await apiCallNoAuth('POST', `/api/admin/support/tickets/${ticketId}/assign`, {
      assignee_id: supportUser.userId,
    });
    expectError(res, 401);
  });

  // 既知の不具合: PATCH と同じ (request.json() の SyntaxError が 500 になる)。直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 400 for malformed JSON body (現状は 500 INTERNAL_ERROR)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCallRaw(
      'POST',
      `/api/admin/support/tickets/${ticketId}/assign`,
      supportUser.jwt,
      '{"assignee_id": ',
    );
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/admin/support/tickets/[id]/messages ─────────────────────────────

describe('GET /api/admin/support/tickets/[id]/messages', () => {
  it('200 for support role - returns messages in chronological order, internal notes included', async () => {
    const ticketId = await seedTicket();
    const customerMsg = await seedMessage(ticketId, {
      senderId: ownerUser.userId,
      body: 'customer question',
      isInternal: false,
      createdAt: '2026-02-01T00:00:00Z',
    });
    const internalMsg = await seedMessage(ticketId, {
      senderId: adminUser.userId,
      body: 'internal note',
      isInternal: true,
      createdAt: '2026-02-02T00:00:00Z',
    });

    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
    );
    const data = dataOf<MessageRow[]>(res);
    expect(data.map((m) => m.id)).toEqual([customerMsg, internalMsg]);
    expect(data[0]).toMatchObject({
      ticket_id: ticketId,
      sender_id: ownerUser.userId,
      is_internal: false,
      body: 'customer question',
    });
    expect(data[1]).toMatchObject({ sender_id: adminUser.userId, is_internal: true });
  });

  it('200 returns an empty array for a ticket without messages', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
    );
    expect(dataOf<unknown[]>(res)).toEqual([]);
  });

  it('200 for admin role', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${ticketId}/messages`,
      adminUser.jwt,
    );
    expect(Array.isArray(dataOf<unknown[]>(res))).toBe(true);
  });

  it('200 for super_admin role', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${ticketId}/messages`,
      superAdminUser.jwt,
    );
    expect(Array.isArray(dataOf<unknown[]>(res))).toBe(true);
  });

  it('403 for general user', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${ticketId}/messages`,
      generalUser.jwt,
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for sales role (staff of another domain)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${ticketId}/messages`,
      salesUser.jwt,
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const ticketId = await seedTicket();
    const res = await apiCallNoAuth('GET', `/api/admin/support/tickets/${ticketId}/messages`);
    expectError(res, 401);
  });
});

// ─── POST /api/admin/support/tickets/[id]/messages ────────────────────────────

describe('POST /api/admin/support/tickets/[id]/messages', () => {
  it('201 for support role - customer reply stores the message and starts the ticket', async () => {
    const ticketId = await seedTicket({ status: 'open' });
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
      { body: `Integration test reply ${TS}`, is_internal: false },
    );
    const data = dataOf<MessageRow>(res, 201);
    expect(data).toMatchObject({
      ticket_id: ticketId,
      sender_id: supportUser.userId,
      is_internal: false,
      body: `Integration test reply ${TS}`,
      attachments: [],
    });
    // #1183: 顧客向けの返信は、顧客へのメール通知の結果を email に載せる。
    // メールが送れなくても (RESEND_API_KEY が無い環境では skipped) メッセージは保存済みなので 201 のまま
    const email = (res.body as { email?: { status?: string } }).email;
    expect(['sent', 'skipped', 'failed']).toContain(email?.status);

    // お客さま向けの最初の返信: first_response_at が入り、open -> in_progress に進む
    const ticket = await readTicket(ticketId);
    expect(ticket.first_response_at).not.toBeNull();
    expect(ticket.status).toBe('in_progress');
    expect((await readMessages(ticketId)).map((m) => m.id)).toEqual([data.id]);
  });

  it('201 for admin role - internal note does not count as the first response', async () => {
    const ticketId = await seedTicket({ status: 'open' });
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      adminUser.jwt,
      { body: `Admin internal note ${TS}`, is_internal: true },
    );
    expect(dataOf<MessageRow>(res, 201)).toMatchObject({
      sender_id: adminUser.userId,
      is_internal: true,
    });
    // #1183: 内部メモは顧客に見せないので、メールにしない (email を返さない)
    expect(res.body).not.toHaveProperty('email');

    const ticket = await readTicket(ticketId);
    expect(ticket.first_response_at).toBeNull();
    expect(ticket.status).toBe('open');
  });

  it('201 for super_admin role', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      superAdminUser.jwt,
      { body: 'Super admin note', is_internal: true },
    );
    expect(dataOf<MessageRow>(res, 201).sender_id).toBe(superAdminUser.userId);
  });

  it('201 is_internal defaults to false when omitted', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
      { body: 'default visibility' },
    );
    expect(dataOf<MessageRow>(res, 201).is_internal).toBe(false);
  });

  it('201 stores attachments', async () => {
    const ticketId = await seedTicket();
    const attachments = [
      { url: 'https://example.com/screenshot.png', name: 'screenshot.png', content_type: 'image/png' },
    ];
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
      { body: 'with attachment', attachments },
    );
    expect(dataOf<MessageRow>(res, 201).attachments).toEqual(attachments);
    expect((await readMessages(ticketId))[0].attachments).toEqual(attachments);
  });

  it('400 for empty body (validation error) and stores nothing', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
      { body: '', is_internal: false },
    );
    expectError(res, 400, 'VALIDATION_ERROR');
    expect(await readMessages(ticketId)).toEqual([]);
  });

  it('400 for missing body', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
      { is_internal: true },
    );
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('400 for an attachment whose url is not a URL', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
      { body: 'bad attachment', attachments: [{ url: 'not-a-url', name: 'x' }] },
    );
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('400 for is_internal that is not a boolean', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
      { body: 'wrong type', is_internal: 'yes' },
    );
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('404 for a ticket that does not exist', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${randomUuid()}/messages`,
      supportUser.jwt,
      { body: 'orphan message' },
    );
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user and stores nothing', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      generalUser.jwt,
      { body: 'Should fail', is_internal: false },
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect(await readMessages(ticketId)).toEqual([]);
  });

  it('403 for sales role (staff of another domain)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      salesUser.jwt,
      { body: 'Should fail', is_internal: true },
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const ticketId = await seedTicket();
    const res = await apiCallNoAuth('POST', `/api/admin/support/tickets/${ticketId}/messages`, {
      body: 'No auth message',
      is_internal: false,
    });
    expectError(res, 401);
  });

  // 既知の不具合: PATCH と同じ (request.json() の SyntaxError が 500 になる)。直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 400 for malformed JSON body (現状は 500 INTERNAL_ERROR)', async () => {
    const ticketId = await seedTicket();
    const res = await apiCallRaw(
      'POST',
      `/api/admin/support/tickets/${ticketId}/messages`,
      supportUser.jwt,
      '{"body": ',
    );
    expect(res.status).toBe(400);
  });
});
