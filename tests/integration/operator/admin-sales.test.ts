/**
 * Integration tests: GET /api/admin/sales/leads (with stage filter) と PATCH /api/admin/sales/leads/[id] のステージの変更 (読んだ stage を条件にする)
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

  // Create a test lead with known stage for filter testing.
  // source は sales_leads_source_check (website / referral / event / cold_call / other) の許容値にする。
  // 以前は 'integration_test' を入れて CHECK 違反になり、seed が黙って失敗していた。
  const { data: lead, error: leadError } = await supabaseAdmin
    .from('sales_leads')
    .insert({
      company_name: `Test Company ${TS}`,
      industry: 'tech',
      contact_name: 'Test Contact',
      source: 'other',
      stage: 'approach',
      assigned_to: salesUser.userId,
    })
    .select()
    .single();

  if (leadError || !lead) {
    throw new Error(`seed sales_leads failed: ${leadError?.message}`);
  }
  createdLeadIds.push(lead.id);
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

describe('PATCH /api/admin/sales/leads/[id]: ステージの変更 (読んだ stage を条件にする)', () => {
  /** このブロック専用のリードを作る (一覧のテストの approach のリードを動かさない) */
  async function createLead(label: string): Promise<string> {
    const { data, error } = await supabaseAdmin
      .from('sales_leads')
      .insert({ company_name: `Stage Company ${label} ${TS}`, source: 'other', stage: 'approach' })
      .select('id')
      .single();
    if (error || !data) throw new Error(`seed sales_leads (${label}) failed: ${error?.message}`);
    createdLeadIds.push(data.id);
    return data.id as string;
  }

  async function stageHistory(leadId: string) {
    const { data, error } = await supabaseAdmin
      .from('sales_lead_activities')
      .select('details')
      .eq('lead_id', leadId)
      .eq('activity_type', 'stage_change');
    expect(error).toBeNull();
    return (data ?? []).map((row) => row.details as { from_stage: string; to_stage: string });
  }

  it('ステージを変えると、活動履歴に直前の stage → 新しい stage を残す', async () => {
    const leadId = await createLead('seq');
    const first = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, salesUser.jwt, { stage: 'meeting' });
    expect(first.status).toBe(200);
    const second = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, adminUser.jwt, { stage: 'proposal' });
    expect(second.status).toBe(200);
    expect(await stageHistory(leadId)).toEqual(
      expect.arrayContaining([
        { from_stage: 'approach', to_stage: 'meeting' },
        { from_stage: 'meeting', to_stage: 'proposal' },
      ]),
    );
  });

  it('同時にステージを変えても、応答は 200 か 409 CONFLICT_STALE_DATA だけで、履歴の from_stage は実際の直前の値とつながる', async () => {
    const leadId = await createLead('parallel');
    const users = [salesUser, adminUser, superAdminUser];
    const targets = ['meeting', 'proposal', 'negotiation', 'won', 'lost', 'meeting'];
    const responses = await Promise.all(
      targets.map((stage, i) => apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, users[i % users.length].jwt, { stage })),
    );
    for (const res of responses) {
      expect([200, 409]).toContain(res.status);
      if (res.status === 409) expect((res.body as { error: { code: string } }).error.code).toBe('CONFLICT_STALE_DATA');
    }
    expect(responses.some((r) => r.status === 200)).toBe(true);

    const { data: lead } = await supabaseAdmin.from('sales_leads').select('stage').eq('id', leadId).single();
    // 実際に変えた更新 (from ≠ to) の from → to は、approach から今の stage への 1 本の道になる。
    // 条件なしで古い stage を from にすると、同じ from から 2 本出るので出入りの数が合わない
    const edges = (await stageHistory(leadId)).filter((e) => e.from_stage !== e.to_stage);
    const balance = new Map<string, number>();
    for (const e of edges) {
      balance.set(e.from_stage, (balance.get(e.from_stage) ?? 0) + 1);
      balance.set(e.to_stage, (balance.get(e.to_stage) ?? 0) - 1);
    }
    const start = 'approach';
    const end = lead!.stage as string;
    if (start !== end) {
      expect(balance.get(start), JSON.stringify(edges)).toBe(1);
      expect(balance.get(end), JSON.stringify(edges)).toBe(-1);
    }
    for (const [stage, net] of balance) {
      const expected = start === end ? 0 : stage === start ? 1 : stage === end ? -1 : 0;
      expect(net, `${stage} の出入り (${JSON.stringify(edges)})`).toBe(expected);
    }
  });
});
