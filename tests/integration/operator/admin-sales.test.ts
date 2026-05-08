/**
 * Integration tests: GET /api/admin/sales/leads (with stage filter)
 * Roles: sales, admin, super_admin
 * Auth boundary: 403 (general user), 401 (no auth)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let salesUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser;

// Track created lead IDs for cleanup
const createdLeadIds: string[] = [];

beforeAll(async () => {
  [salesUser, adminUser, superAdminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('sales-sales', TS), roles: ['sales'] }),
    createTestUserWithRoles({ email: testEmail('sales-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('sales-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('sales-gen', TS), roles: ['user'] }),
  ]);

  // Create a test lead with known stage for filter testing
  const { data: lead } = await supabaseAdmin
    .from('sales_leads')
    .insert({
      company_name: `Test Company ${TS}`,
      industry: 'tech',
      contact_name: 'Test Contact',
      source: 'integration_test',
      stage: 'approach',
      assigned_to: salesUser.userId,
    })
    .select()
    .single();

  if (lead?.id) {
    createdLeadIds.push(lead.id);
  }
}, 60000);

afterAll(async () => {
  // Cleanup created leads
  if (createdLeadIds.length > 0) {
    await supabaseAdmin
      .from('sales_leads')
      .delete()
      .in('id', createdLeadIds);
  }

  await Promise.all([
    cleanupAuditLogs(salesUser.userId),
    cleanupAuditLogs(adminUser.userId),
    cleanupAuditLogs(superAdminUser.userId),
  ]);

  await Promise.all([
    cleanupTestUser(salesUser.userId),
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(generalUser.userId),
  ]);
}, 30000);

describe('GET /api/admin/sales/leads', () => {
  it('200 for sales role', async () => {
    const res = await apiCall('GET', '/api/admin/sales/leads', salesUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', '/api/admin/sales/leads', adminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', '/api/admin/sales/leads', superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('stage filter returns only matching leads', async () => {
    const res = await apiCall('GET', '/api/admin/sales/leads?stage=approach', salesUser.jwt);
    expect(res.status).toBe(200);

    const body = res.body as {
      data: Array<{ stage: string; company_name: string }>;
      meta: { total: number };
    };

    // All returned leads should have stage=approach
    for (const lead of body.data) {
      expect(lead.stage).toBe('approach');
    }

    // Our test lead should be present
    const testLead = body.data.find((l) => l.company_name === `Test Company ${TS}`);
    expect(testLead).toBeDefined();
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/sales/leads', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/sales/leads');
    expect(res.status).toBe(401);
  });
});
