/**
 * Integration tests: GET/PATCH /api/admin/support/tickets/[id]
 *                   POST /api/admin/support/tickets/[id]/assign
 *                   GET/POST /api/admin/support/tickets/[id]/messages
 *
 * Roles: support, admin, super_admin
 * Auth boundary: 403 (general user), 401 (no auth)
 * Validation: 422 equivalent (400) for invalid bodies
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUserWithRoles,
  cleanupTestUser,
  cleanupAuditLogs,
  testEmail,
  type TestUser,
} from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let supportUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser;
let targetUser: TestUser;

let testTicketId: string;
const createdTicketIds: string[] = [];

beforeAll(async () => {
  [supportUser, adminUser, superAdminUser, generalUser, targetUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('td-support', TS), roles: ['support'] }),
    createTestUserWithRoles({ email: testEmail('td-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('td-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('td-gen', TS), roles: ['user'] }),
    createTestUserWithRoles({ email: testEmail('td-target', TS), roles: ['user'] }),
  ]);

  // テスト用チケットを API 経由で作成 (RLS バイパスのため)
  // support ロールが自分の user_id でチケットを作成する
  const ticketRes = await apiCall('POST', '/api/admin/support/tickets', supportUser.jwt, {
    user_id: supportUser.userId,
    subject: `T07 Integration Test Ticket ${TS}`,
    category: 'billing',
    priority: 'medium',
    body: 'Integration test ticket body for T07',
  });

  if (ticketRes.status !== 201) {
    throw new Error(`Failed to create test ticket via API: status=${ticketRes.status}, body=${JSON.stringify(ticketRes.body)}`);
  }

  const ticketData = (ticketRes.body as { data: { id: string } }).data;
  if (ticketData?.id) {
    testTicketId = ticketData.id;
    createdTicketIds.push(ticketData.id);
  }
}, 60000);

afterAll(async () => {
  if (createdTicketIds.length > 0) {
    await supabaseAdmin
      .from('support_ticket_messages')
      .delete()
      .in('ticket_id', createdTicketIds);
    await supabaseAdmin.from('support_tickets').delete().in('id', createdTicketIds);
  }

  await Promise.all([
    cleanupAuditLogs(supportUser.userId),
    cleanupAuditLogs(adminUser.userId),
    cleanupAuditLogs(superAdminUser.userId),
  ]);

  await Promise.all([
    cleanupTestUser(supportUser.userId),
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(generalUser.userId),
    cleanupTestUser(targetUser.userId),
  ]);
}, 30000);

// ─── GET /api/admin/support/tickets/[id] ──────────────────────────────────────

describe('GET /api/admin/support/tickets/[id]', () => {
  it('200 for support role - returns ticket with messages', async () => {
    const res = await apiCall('GET', `/api/admin/support/tickets/${testTicketId}`, supportUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('id', testTicketId);
    expect(data).toHaveProperty('subject');
    expect(data).toHaveProperty('messages');
    expect(Array.isArray((data as { messages: unknown[] }).messages)).toBe(true);
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', `/api/admin/support/tickets/${testTicketId}`, adminUser.jwt);
    expect(res.status).toBe(200);
    expect((res.body as { data: { id: string } }).data.id).toBe(testTicketId);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${testTicketId}`,
      superAdminUser.jwt,
    );
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${testTicketId}`,
      generalUser.jwt,
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', `/api/admin/support/tickets/${testTicketId}`);
    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/admin/support/tickets/[id] ────────────────────────────────────

describe('PATCH /api/admin/support/tickets/[id]', () => {
  it('200 for support role - updates status', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/admin/support/tickets/${testTicketId}`,
      supportUser.jwt,
      { status: 'in_progress' },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('200 for admin role - updates priority', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/admin/support/tickets/${testTicketId}`,
      adminUser.jwt,
      { priority: 'high' },
    );
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/admin/support/tickets/${testTicketId}`,
      generalUser.jwt,
      { status: 'resolved' },
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'PATCH',
      `/api/admin/support/tickets/${testTicketId}`,
      { status: 'resolved' },
    );
    expect(res.status).toBe(401);
  });

  it('400 for invalid body (validation error)', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/admin/support/tickets/${testTicketId}`,
      supportUser.jwt,
      { status: 'INVALID_STATUS' },
    );
    // 400 (validation) or returns error
    expect([400, 422]).toContain(res.status);
  });
});

// ─── POST /api/admin/support/tickets/[id]/assign ──────────────────────────────

describe('POST /api/admin/support/tickets/[id]/assign', () => {
  it('200 for support role - assigns ticket', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/assign`,
      supportUser.jwt,
      { assignee_id: supportUser.userId },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('200 for admin role', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/assign`,
      adminUser.jwt,
      { assignee_id: adminUser.userId },
    );
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/assign`,
      generalUser.jwt,
      { assignee_id: generalUser.userId },
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/assign`,
      { assignee_id: supportUser.userId },
    );
    expect(res.status).toBe(401);
  });

  it('400 for invalid assignee_id (not UUID)', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/assign`,
      supportUser.jwt,
      { assignee_id: 'not-a-uuid' },
    );
    expect([400, 422]).toContain(res.status);
  });
});

// ─── GET /api/admin/support/tickets/[id]/messages ─────────────────────────────

describe('GET /api/admin/support/tickets/[id]/messages', () => {
  it('200 for support role - returns messages array', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      supportUser.jwt,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });

  it('200 for admin role', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      superAdminUser.jwt,
    );
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      generalUser.jwt,
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'GET',
      `/api/admin/support/tickets/${testTicketId}/messages`,
    );
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/admin/support/tickets/[id]/messages ────────────────────────────

describe('POST /api/admin/support/tickets/[id]/messages', () => {
  it('201 for support role - creates message', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      supportUser.jwt,
      {
        body: `Integration test message ${TS}`,
        is_internal: false,
      },
    );
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('data');
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('ticket_id', testTicketId);
  });

  it('201 for admin role - creates internal note', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      adminUser.jwt,
      {
        body: `Admin internal note ${TS}`,
        is_internal: true,
      },
    );
    expect(res.status).toBe(201);
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      generalUser.jwt,
      { body: 'Should fail', is_internal: false },
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      { body: 'No auth message', is_internal: false },
    );
    expect(res.status).toBe(401);
  });

  it('400 for empty body (validation error)', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/support/tickets/${testTicketId}/messages`,
      supportUser.jwt,
      { body: '', is_internal: false },
    );
    expect([400, 422]).toContain(res.status);
  });
});
