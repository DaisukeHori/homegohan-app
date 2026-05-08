/**
 * Integration tests: GET/POST /api/admin/support/tickets
 * Roles: support, admin, super_admin
 * Auth boundary: 403 (general user), 401 (no auth)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let supportUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser;
let targetUser: TestUser;

// Track created ticket IDs for cleanup
const createdTicketIds: string[] = [];

beforeAll(async () => {
  [supportUser, adminUser, superAdminUser, generalUser, targetUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('sup-support', TS), roles: ['support'] }),
    createTestUserWithRoles({ email: testEmail('sup-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('sup-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('sup-gen', TS), roles: ['user'] }),
    createTestUserWithRoles({ email: testEmail('sup-target', TS), roles: ['user'] }),
  ]);
}, 60000);

afterAll(async () => {
  // Cleanup created tickets and their messages
  if (createdTicketIds.length > 0) {
    await supabaseAdmin
      .from('support_ticket_messages')
      .delete()
      .in('ticket_id', createdTicketIds);
    await supabaseAdmin
      .from('support_tickets')
      .delete()
      .in('id', createdTicketIds);
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

describe('GET /api/admin/support/tickets', () => {
  it('200 for support role', async () => {
    const res = await apiCall('GET', '/api/admin/support/tickets', supportUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', '/api/admin/support/tickets', adminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', '/api/admin/support/tickets', superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/support/tickets', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/support/tickets');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/support/tickets', () => {
  it('201 for support role and status is open by default', async () => {
    const res = await apiCall('POST', '/api/admin/support/tickets', supportUser.jwt, {
      user_id: targetUser.userId,
      subject: `Integration test ticket ${TS}`,
      category: 'billing',
      priority: 'medium',
      body: 'Integration test ticket body',
    });

    expect(res.status).toBe(201);
    const body = res.body as { data: { id: string; status: string } };
    expect(body.data).toHaveProperty('id');
    expect(body.data.status).toBe('open');

    if (body.data.id) {
      createdTicketIds.push(body.data.id);
    }
  });

  it('201 for admin role', async () => {
    const res = await apiCall('POST', '/api/admin/support/tickets', adminUser.jwt, {
      user_id: targetUser.userId,
      subject: `Admin integration test ticket ${TS}`,
      category: 'general',
      priority: 'low',
      body: 'Admin created ticket',
    });

    expect(res.status).toBe(201);
    const body = res.body as { data: { id: string; status: string } };
    expect(body.data.status).toBe('open');

    if (body.data.id) {
      createdTicketIds.push(body.data.id);
    }
  });

  it('403 for general user', async () => {
    const res = await apiCall('POST', '/api/admin/support/tickets', generalUser.jwt, {
      user_id: targetUser.userId,
      subject: 'Should fail',
      category: 'general',
      priority: 'low',
      body: 'Should not be created',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/admin/support/tickets', {
      user_id: targetUser.userId,
      subject: 'No auth ticket',
      category: 'general',
      priority: 'low',
      body: 'Should not be created',
    });
    expect(res.status).toBe(401);
  });
});
