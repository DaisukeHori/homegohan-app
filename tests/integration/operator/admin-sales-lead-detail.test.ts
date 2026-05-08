/**
 * Integration tests:
 *   GET/PATCH /api/admin/sales/leads/[id]
 *   GET/POST  /api/admin/sales/leads/[id]/activities
 *   POST      /api/admin/sales/leads (lead 作成)
 *
 * Roles: sales, admin, super_admin
 * Auth boundary: 403 (general user), 401 (no auth)
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

let salesUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser;

let testLeadId: string;
const createdLeadIds: string[] = [];

beforeAll(async () => {
  [salesUser, adminUser, superAdminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('ld-sales', TS), roles: ['sales'] }),
    createTestUserWithRoles({ email: testEmail('ld-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('ld-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('ld-gen', TS), roles: ['user'] }),
  ]);

  // テスト用リードを API 経由で作成 (RLS バイパスのため)
  const leadRes = await apiCall('POST', '/api/admin/sales/leads', salesUser.jwt, {
    company_name: `T07 Test Company ${TS}`,
    industry: 'tech',
    contact_name: 'Test Contact',
    source: 'other',
    notes: 'Integration test lead for T07',
  });

  if (leadRes.status !== 201) {
    throw new Error(`Failed to create test lead via API: status=${leadRes.status}, body=${JSON.stringify(leadRes.body)}`);
  }

  const leadData = (leadRes.body as { data: { id: string } }).data;
  if (leadData?.id) {
    testLeadId = leadData.id;
    createdLeadIds.push(leadData.id);
  }
}, 60000);

afterAll(async () => {
  if (createdLeadIds.length > 0) {
    await supabaseAdmin
      .from('sales_lead_activities')
      .delete()
      .in('lead_id', createdLeadIds);
    await supabaseAdmin.from('sales_leads').delete().in('id', createdLeadIds);
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

// ─── POST /api/admin/sales/leads ──────────────────────────────────────────────

describe('POST /api/admin/sales/leads', () => {
  it('201 for sales role - creates lead', async () => {
    const res = await apiCall('POST', '/api/admin/sales/leads', salesUser.jwt, {
      company_name: `New Lead ${TS}`,
      industry: 'finance',
      contact_name: 'New Contact',
      source: 'referral',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('data');
    const data = (res.body as { data: { id: string; company_name: string } }).data;
    expect(data).toHaveProperty('id');
    expect(data.company_name).toBe(`New Lead ${TS}`);
    if (data.id) createdLeadIds.push(data.id);
  });

  it('201 for admin role', async () => {
    const res = await apiCall('POST', '/api/admin/sales/leads', adminUser.jwt, {
      company_name: `Admin Lead ${TS}`,
      source: 'website',
    });
    expect(res.status).toBe(201);
    const data = (res.body as { data: { id: string } }).data;
    if (data?.id) createdLeadIds.push(data.id);
  });

  it('403 for general user', async () => {
    const res = await apiCall('POST', '/api/admin/sales/leads', generalUser.jwt, {
      company_name: 'Should fail',
      source: 'website',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/admin/sales/leads', {
      company_name: 'No auth lead',
      source: 'website',
    });
    expect(res.status).toBe(401);
  });

  it('400 for missing required company_name (validation error)', async () => {
    const res = await apiCall('POST', '/api/admin/sales/leads', salesUser.jwt, {
      source: 'website',
      // company_name is missing
    });
    expect([400, 422]).toContain(res.status);
  });
});

// ─── GET /api/admin/sales/leads/[id] ──────────────────────────────────────────

describe('GET /api/admin/sales/leads/[id]', () => {
  it('200 for sales role - returns lead with activities', async () => {
    const res = await apiCall('GET', `/api/admin/sales/leads/${testLeadId}`, salesUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('id', testLeadId);
    expect(data).toHaveProperty('company_name');
    expect(data).toHaveProperty('activities');
    expect(Array.isArray((data as { activities: unknown[] }).activities)).toBe(true);
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', `/api/admin/sales/leads/${testLeadId}`, adminUser.jwt);
    expect(res.status).toBe(200);
    expect((res.body as { data: { id: string } }).data.id).toBe(testLeadId);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', `/api/admin/sales/leads/${testLeadId}`, superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', `/api/admin/sales/leads/${testLeadId}`, generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', `/api/admin/sales/leads/${testLeadId}`);
    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/admin/sales/leads/[id] ────────────────────────────────────────

describe('PATCH /api/admin/sales/leads/[id]', () => {
  it('200 for sales role - updates stage', async () => {
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${testLeadId}`, salesUser.jwt, {
      stage: 'meeting',
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('200 for admin role - updates notes', async () => {
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${testLeadId}`, adminUser.jwt, {
      notes: `Updated by admin integration test ${TS}`,
    });
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${testLeadId}`, generalUser.jwt, {
      stage: 'meeting',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('PATCH', `/api/admin/sales/leads/${testLeadId}`, {
      stage: 'meeting',
    });
    expect(res.status).toBe(401);
  });

  it('400 for invalid stage value (validation error)', async () => {
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${testLeadId}`, salesUser.jwt, {
      stage: 'INVALID_STAGE',
    });
    expect([400, 422]).toContain(res.status);
  });
});

// ─── GET /api/admin/sales/leads/[id]/activities ───────────────────────────────

describe('GET /api/admin/sales/leads/[id]/activities', () => {
  it('200 for sales role - returns activities array', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      salesUser.jwt,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });

  it('200 for admin role', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      superAdminUser.jwt,
    );
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      generalUser.jwt,
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'GET',
      `/api/admin/sales/leads/${testLeadId}/activities`,
    );
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/admin/sales/leads/[id]/activities ──────────────────────────────

describe('POST /api/admin/sales/leads/[id]/activities', () => {
  it('201 for sales role - creates activity', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      salesUser.jwt,
      {
        activity_type: 'call',
        details: { duration_minutes: 30, outcome: 'positive' },
      },
    );
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('data');
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('lead_id', testLeadId);
    expect(data).toHaveProperty('activity_type', 'call');
  });

  it('201 for admin role - creates note activity', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      adminUser.jwt,
      {
        activity_type: 'note',
        details: { content: `Admin note ${TS}` },
      },
    );
    expect(res.status).toBe(201);
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      generalUser.jwt,
      { activity_type: 'call', details: {} },
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'POST',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      { activity_type: 'call', details: {} },
    );
    expect(res.status).toBe(401);
  });

  it('400 for invalid activity_type (validation error)', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${testLeadId}/activities`,
      salesUser.jwt,
      {
        activity_type: 'INVALID_TYPE',
        details: {},
      },
    );
    expect([400, 422]).toContain(res.status);
  });
});
