/**
 * Integration tests: 運営の営業 CRM (リード) API (#849 / T07)
 *   POST      /api/admin/sales/leads
 *   GET/PATCH /api/admin/sales/leads/[id]
 *   GET/POST  /api/admin/sales/leads/[id]/activities
 *
 * 権限: sales / admin / super_admin。ほかのロール (support など) と一般ユーザーは 403、未認証は 401。
 * 入力エラーは 400 + code=VALIDATION_ERROR (AC の「422 相当」はこの 400)。
 *
 * テストデータは service_role で直接 seed する (別のエンドポイントの動作に依存しない)。
 * 各テストが自分用のリードを作るので、実行順や他テストの状態に左右されない。
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
const pool = new TestUserPool(TS, 'ldsal');

let salesUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser; // 権限なし (role=user)
let supportUser: TestUser; // 運営だが sales ではない (別ドメインのスタッフは 403)

const createdLeadIds: string[] = [];
let seq = 0;

interface LeadRow {
  id: string;
  company_name: string;
  industry: string | null;
  contact_email: string | null;
  source: string | null;
  stage: string;
  assigned_to: string | null;
  employee_count: number | null;
  estimated_acv: number | null;
  notes: string | null;
  updated_at: string;
}

interface ActivityRow {
  id: string;
  lead_id: string;
  actor_id: string;
  activity_type: string;
  details: Record<string, unknown>;
  created_at: string;
}

/** service_role でリードを 1 件作る (後片付け対象に登録) */
async function seedLead(overrides: { stage?: string; assignedTo?: string | null } = {}): Promise<string> {
  seq += 1;
  const { data, error } = await supabaseAdmin
    .from('sales_leads')
    .insert({
      company_name: `T849 Lead ${TS}-${seq}`,
      industry: 'tech',
      contact_name: 'Test Contact',
      source: 'other',
      stage: overrides.stage ?? 'approach',
      assigned_to: overrides.assignedTo === undefined ? salesUser.userId : overrides.assignedTo,
      notes: 'Integration test lead (T849)',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seedLead failed: ${error?.message}`);
  createdLeadIds.push(data.id as string);
  return data.id as string;
}

/** service_role で活動履歴を 1 件作る。created_at を固定して並び順を決定的にする */
async function seedActivity(
  leadId: string,
  params: { actorId: string; type: string; details: Record<string, unknown>; createdAt: string },
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('sales_lead_activities')
    .insert({
      lead_id: leadId,
      actor_id: params.actorId,
      activity_type: params.type,
      details: params.details,
      created_at: params.createdAt,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seedActivity failed: ${error?.message}`);
  return data.id as string;
}

async function readLead(leadId: string): Promise<LeadRow> {
  const { data, error } = await supabaseAdmin.from('sales_leads').select('*').eq('id', leadId).single();
  if (error || !data) throw new Error(`readLead failed: ${error?.message}`);
  return data as LeadRow;
}

async function readActivities(leadId: string): Promise<ActivityRow[]> {
  const { data, error } = await supabaseAdmin
    .from('sales_lead_activities')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`readActivities failed: ${error.message}`);
  return (data ?? []) as ActivityRow[];
}

async function countLeadsByCompany(companyName: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('sales_leads')
    .select('id', { count: 'exact', head: true })
    .eq('company_name', companyName);
  if (error) throw new Error(`countLeadsByCompany failed: ${error.message}`);
  return count ?? 0;
}

beforeAll(async () => {
  ({ salesUser, adminUser, superAdminUser, generalUser, supportUser } = await pool.createMany({
    salesUser: ['sales'],
    adminUser: ['admin'],
    superAdminUser: ['super_admin'],
    generalUser: ['user'],
    supportUser: ['support'],
  }));
}, 60000);

afterAll(async () => {
  // sales_lead_activities.actor_id / sales_leads.assigned_to は auth.users への外部キー (NO ACTION)。
  // ユーザーより先に活動履歴 → リードの順に消す。
  if (createdLeadIds.length > 0) {
    await supabaseAdmin.from('sales_lead_activities').delete().in('lead_id', createdLeadIds);
    await supabaseAdmin.from('sales_leads').delete().in('id', createdLeadIds);
  }
  // 「400 になるはずが作られてしまった」等で追跡できなかったリードも、会社名の TS で拾って消す
  // (活動履歴は sales_leads への ON DELETE CASCADE で一緒に消える)。
  await supabaseAdmin.from('sales_leads').delete().like('company_name', `%${TS}%`);
  await pool.cleanup();
}, 60000);

// ─── POST /api/admin/sales/leads ──────────────────────────────────────────────

describe('POST /api/admin/sales/leads', () => {
  it('201 for sales role - creates a lead assigned to the creator, and writes an audit log', async () => {
    const companyName = `New Lead ${TS}`;
    const res = await apiCall('POST', '/api/admin/sales/leads', salesUser.jwt, {
      company_name: companyName,
      industry: 'finance',
      contact_name: 'New Contact',
      source: 'referral',
    });
    const data = dataOf<LeadRow>(res, 201);
    createdLeadIds.push(data.id);
    expect(data).toMatchObject({
      company_name: companyName,
      industry: 'finance',
      source: 'referral',
      stage: 'approach',
      assigned_to: salesUser.userId, // assigned_to 未指定なら作成者
    });
    expect((await readLead(data.id)).company_name).toBe(companyName);

    const log = await latestAuditLog({
      actorId: salesUser.userId,
      actionType: 'admin.sales.lead.create',
      targetId: data.id,
    });
    expect(log).not.toBeNull();
    expect(log!.target_type).toBe('sales_lead');
    expect(log!.details).toMatchObject({ company_name: companyName, stage: 'approach' });
  });

  it('201 for admin role - an explicit assigned_to is kept', async () => {
    const res = await apiCall('POST', '/api/admin/sales/leads', adminUser.jwt, {
      company_name: `Admin Lead ${TS}`,
      source: 'website',
      assigned_to: salesUser.userId,
    });
    const data = dataOf<LeadRow>(res, 201);
    createdLeadIds.push(data.id);
    expect(data.assigned_to).toBe(salesUser.userId);
  });

  it('201 for super_admin role - only company_name is required', async () => {
    const res = await apiCall('POST', '/api/admin/sales/leads', superAdminUser.jwt, {
      company_name: `Minimal Lead ${TS}`,
    });
    const data = dataOf<LeadRow>(res, 201);
    createdLeadIds.push(data.id);
    expect(data).toMatchObject({ stage: 'approach', source: null, assigned_to: superAdminUser.userId });
  });

  it('201 an empty contact_email is stored as null, a valid one is kept', async () => {
    const blank = dataOf<LeadRow>(
      await apiCall('POST', '/api/admin/sales/leads', salesUser.jwt, {
        company_name: `Blank Email Lead ${TS}`,
        contact_email: '',
      }),
      201,
    );
    createdLeadIds.push(blank.id);
    expect(blank.contact_email).toBeNull();

    const filled = dataOf<LeadRow>(
      await apiCall('POST', '/api/admin/sales/leads', salesUser.jwt, {
        company_name: `Email Lead ${TS}`,
        contact_email: 'lead-t849@example.com',
      }),
      201,
    );
    createdLeadIds.push(filled.id);
    expect(filled.contact_email).toBe('lead-t849@example.com');
  });

  describe('400 for invalid input (validation error) and creates nothing', () => {
    const cases: Array<{ name: string; body: Record<string, unknown>; companyName?: string }> = [
      { name: 'missing company_name', body: { source: 'website' } },
      { name: 'empty company_name', body: { company_name: '' } },
      {
        name: 'company_name over 200 characters',
        body: { company_name: 'x'.repeat(201) },
      },
      {
        name: 'invalid source',
        companyName: `Invalid Source ${TS}`,
        body: { company_name: `Invalid Source ${TS}`, source: 'INVALID_SOURCE' },
      },
      {
        name: 'invalid contact_email',
        companyName: `Invalid Email ${TS}`,
        body: { company_name: `Invalid Email ${TS}`, contact_email: 'not-an-email' },
      },
      {
        name: 'non-positive employee_count',
        companyName: `Invalid Employees ${TS}`,
        body: { company_name: `Invalid Employees ${TS}`, employee_count: 0 },
      },
      {
        name: 'assigned_to that is not a UUID',
        companyName: `Invalid Assignee ${TS}`,
        body: { company_name: `Invalid Assignee ${TS}`, assigned_to: 'not-a-uuid' },
      },
    ];

    it.each(cases)('$name', async ({ body, companyName }) => {
      const res = await apiCall('POST', '/api/admin/sales/leads', salesUser.jwt, body);
      expectError(res, 400, 'VALIDATION_ERROR');
      if (companyName) {
        expect(await countLeadsByCompany(companyName)).toBe(0);
      }
    });
  });

  it('403 for general user and creates nothing', async () => {
    const companyName = `General Lead ${TS}`;
    const res = await apiCall('POST', '/api/admin/sales/leads', generalUser.jwt, {
      company_name: companyName,
      source: 'website',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect(await countLeadsByCompany(companyName)).toBe(0);
  });

  it('403 for support role (staff of another domain)', async () => {
    const res = await apiCall('POST', '/api/admin/sales/leads', supportUser.jwt, {
      company_name: `Support Lead ${TS}`,
      source: 'website',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/admin/sales/leads', {
      company_name: 'No auth lead',
      source: 'website',
    });
    expectError(res, 401);
  });

  // 既知の不具合: request.json() の SyntaxError を握っておらず、汎用の catch で 500 になる。
  // (moderation の [type]/[id] や users/[id]/freeze は INVALID_JSON の 400 を返している)
  // 直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 400 for malformed JSON body (現状は 500 INTERNAL_ERROR)', async () => {
    const res = await apiCallRaw('POST', '/api/admin/sales/leads', salesUser.jwt, '{"company_name": ');
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/admin/sales/leads/[id] ──────────────────────────────────────────

describe('GET /api/admin/sales/leads/[id]', () => {
  it('200 for sales role - returns the lead with an empty activities array', async () => {
    const leadId = await seedLead();
    const res = await apiCall('GET', `/api/admin/sales/leads/${leadId}`, salesUser.jwt);
    const data = dataOf<LeadRow & { activities: unknown[] }>(res);
    expect(data).toMatchObject({
      id: leadId,
      industry: 'tech',
      source: 'other',
      stage: 'approach',
      assigned_to: salesUser.userId,
    });
    expect(data.company_name).toContain('T849 Lead');
    expect(data.activities).toEqual([]);
  });

  it('200 includes activities, newest first', async () => {
    const leadId = await seedLead();
    const older = await seedActivity(leadId, {
      actorId: salesUser.userId,
      type: 'call',
      details: { outcome: 'first call' },
      createdAt: '2026-03-01T00:00:00Z',
    });
    const newer = await seedActivity(leadId, {
      actorId: adminUser.userId,
      type: 'note',
      details: { content: 'follow-up note' },
      createdAt: '2026-03-02T00:00:00Z',
    });

    const res = await apiCall('GET', `/api/admin/sales/leads/${leadId}`, salesUser.jwt);
    const data = dataOf<{ activities: ActivityRow[] }>(res);
    expect(data.activities.map((a) => a.id)).toEqual([newer, older]);
  });

  it('200 for admin role', async () => {
    const leadId = await seedLead();
    const res = await apiCall('GET', `/api/admin/sales/leads/${leadId}`, adminUser.jwt);
    expect(dataOf<{ id: string }>(res).id).toBe(leadId);
  });

  it('200 for super_admin role', async () => {
    const leadId = await seedLead();
    const res = await apiCall('GET', `/api/admin/sales/leads/${leadId}`, superAdminUser.jwt);
    expect(dataOf<{ id: string }>(res).id).toBe(leadId);
  });

  it('404 for a lead that does not exist', async () => {
    const res = await apiCall('GET', `/api/admin/sales/leads/${randomUuid()}`, salesUser.jwt);
    expectError(res, 404, 'NOT_FOUND');
  });

  it('404 for an id that is not a UUID', async () => {
    const res = await apiCall('GET', '/api/admin/sales/leads/not-a-uuid', salesUser.jwt);
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user', async () => {
    const leadId = await seedLead();
    const res = await apiCall('GET', `/api/admin/sales/leads/${leadId}`, generalUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const leadId = await seedLead();
    const res = await apiCall('GET', `/api/admin/sales/leads/${leadId}`, supportUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const leadId = await seedLead();
    const res = await apiCallNoAuth('GET', `/api/admin/sales/leads/${leadId}`);
    expectError(res, 401);
  });
});

// ─── PATCH /api/admin/sales/leads/[id] ────────────────────────────────────────

describe('PATCH /api/admin/sales/leads/[id]', () => {
  it('200 for sales role - changing the stage records a stage_change activity and an audit log', async () => {
    const leadId = await seedLead({ stage: 'approach' });
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, salesUser.jwt, {
      stage: 'meeting',
    });
    expect(dataOf<LeadRow>(res)).toMatchObject({ id: leadId, stage: 'meeting' });
    expect((await readLead(leadId)).stage).toBe('meeting');

    const activities = await readActivities(leadId);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      lead_id: leadId,
      actor_id: salesUser.userId,
      activity_type: 'stage_change',
      details: { from_stage: 'approach', to_stage: 'meeting' },
    });

    const log = await latestAuditLog({
      actorId: salesUser.userId,
      actionType: 'admin.sales.lead.update',
      targetId: leadId,
    });
    expect(log).not.toBeNull();
    expect(log!.details).toMatchObject({ stage: 'meeting' });
  });

  it('200 for admin role - updates notes and bumps updated_at without a stage_change activity', async () => {
    const leadId = await seedLead();
    const before = (await readLead(leadId)).updated_at;
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, adminUser.jwt, {
      notes: `Updated by admin integration test ${TS}`,
    });
    expect(dataOf<LeadRow>(res).notes).toBe(`Updated by admin integration test ${TS}`);

    const after = await readLead(leadId);
    expect(after.notes).toBe(`Updated by admin integration test ${TS}`);
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(await readActivities(leadId)).toEqual([]);
  });

  it('200 for super_admin role - updates contact fields and the estimated ACV', async () => {
    const leadId = await seedLead();
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, superAdminUser.jwt, {
      contact_email: 'updated-t849@example.com',
      estimated_acv: 1200000,
      employee_count: 250,
    });
    expect(dataOf<LeadRow>(res)).toMatchObject({
      contact_email: 'updated-t849@example.com',
      estimated_acv: 1200000,
      employee_count: 250,
    });
  });

  it('200 sending the current stage again does not record a stage_change activity', async () => {
    const leadId = await seedLead({ stage: 'proposal' });
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, salesUser.jwt, {
      stage: 'proposal',
    });
    expect(dataOf<LeadRow>(res).stage).toBe('proposal');
    expect(await readActivities(leadId)).toEqual([]);
  });

  describe('400 for invalid input (validation error) and leaves the lead untouched', () => {
    const cases: Array<{ name: string; body: Record<string, unknown> }> = [
      { name: 'invalid stage value', body: { stage: 'INVALID_STAGE' } },
      { name: 'invalid source', body: { source: 'INVALID_SOURCE' } },
      { name: 'invalid contact_email', body: { contact_email: 'not-an-email' } },
      { name: 'negative estimated_acv', body: { estimated_acv: -1 } },
      { name: 'empty company_name', body: { company_name: '' } },
      { name: 'assigned_to that is not a UUID', body: { assigned_to: 'not-a-uuid' } },
      { name: 'empty object (at least one field is required)', body: {} },
    ];

    it.each(cases)('$name', async ({ body }) => {
      const leadId = await seedLead({ stage: 'approach' });
      const res = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, salesUser.jwt, body);
      expectError(res, 400, 'VALIDATION_ERROR');
      const row = await readLead(leadId);
      expect(row.stage).toBe('approach');
      expect(row.company_name).toContain('T849 Lead');
    });
  });

  it('404 for a lead that does not exist', async () => {
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${randomUuid()}`, salesUser.jwt, {
      stage: 'meeting',
    });
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user and leaves the lead untouched', async () => {
    const leadId = await seedLead({ stage: 'approach' });
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, generalUser.jwt, {
      stage: 'meeting',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect((await readLead(leadId)).stage).toBe('approach');
  });

  it('403 for support role (staff of another domain)', async () => {
    const leadId = await seedLead();
    const res = await apiCall('PATCH', `/api/admin/sales/leads/${leadId}`, supportUser.jwt, {
      stage: 'meeting',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const leadId = await seedLead();
    const res = await apiCallNoAuth('PATCH', `/api/admin/sales/leads/${leadId}`, {
      stage: 'meeting',
    });
    expectError(res, 401);
  });

  // 既知の不具合: POST /leads と同じ (request.json() の SyntaxError が 500 になる)。直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 400 for malformed JSON body (現状は 500 INTERNAL_ERROR)', async () => {
    const leadId = await seedLead();
    const res = await apiCallRaw(
      'PATCH',
      `/api/admin/sales/leads/${leadId}`,
      salesUser.jwt,
      '{"stage": ',
    );
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/admin/sales/leads/[id]/activities ───────────────────────────────

describe('GET /api/admin/sales/leads/[id]/activities', () => {
  it('200 for sales role - returns activities newest first', async () => {
    const leadId = await seedLead();
    const older = await seedActivity(leadId, {
      actorId: salesUser.userId,
      type: 'email',
      details: { subject: 'intro' },
      createdAt: '2026-04-01T00:00:00Z',
    });
    const newer = await seedActivity(leadId, {
      actorId: adminUser.userId,
      type: 'meeting',
      details: { minutes: 45 },
      createdAt: '2026-04-02T00:00:00Z',
    });

    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${leadId}/activities`,
      salesUser.jwt,
    );
    const data = dataOf<ActivityRow[]>(res);
    expect(data.map((a) => a.id)).toEqual([newer, older]);
    expect(data[0]).toMatchObject({
      lead_id: leadId,
      actor_id: adminUser.userId,
      activity_type: 'meeting',
      details: { minutes: 45 },
    });
  });

  it('200 returns an empty array for a lead without activities', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${leadId}/activities`,
      salesUser.jwt,
    );
    expect(dataOf<unknown[]>(res)).toEqual([]);
  });

  it('200 for admin role', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${leadId}/activities`,
      adminUser.jwt,
    );
    expect(Array.isArray(dataOf<unknown[]>(res))).toBe(true);
  });

  it('200 for super_admin role', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${leadId}/activities`,
      superAdminUser.jwt,
    );
    expect(Array.isArray(dataOf<unknown[]>(res))).toBe(true);
  });

  it('403 for general user', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${leadId}/activities`,
      generalUser.jwt,
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'GET',
      `/api/admin/sales/leads/${leadId}/activities`,
      supportUser.jwt,
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const leadId = await seedLead();
    const res = await apiCallNoAuth('GET', `/api/admin/sales/leads/${leadId}/activities`);
    expectError(res, 401);
  });
});

// ─── POST /api/admin/sales/leads/[id]/activities ──────────────────────────────

describe('POST /api/admin/sales/leads/[id]/activities', () => {
  it('201 for sales role - records the activity and bumps the lead updated_at', async () => {
    const leadId = await seedLead();
    const before = (await readLead(leadId)).updated_at;
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${leadId}/activities`,
      salesUser.jwt,
      { activity_type: 'call', details: { duration_minutes: 30, outcome: 'positive' } },
    );
    const data = dataOf<ActivityRow>(res, 201);
    expect(data).toMatchObject({
      lead_id: leadId,
      actor_id: salesUser.userId,
      activity_type: 'call',
      details: { duration_minutes: 30, outcome: 'positive' },
    });
    expect((await readActivities(leadId)).map((a) => a.id)).toEqual([data.id]);
    expect(new Date((await readLead(leadId)).updated_at).getTime()).toBeGreaterThan(
      new Date(before).getTime(),
    );
  });

  it('201 for admin role - creates a note activity', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${leadId}/activities`,
      adminUser.jwt,
      { activity_type: 'note', details: { content: `Admin note ${TS}` } },
    );
    expect(dataOf<ActivityRow>(res, 201)).toMatchObject({
      actor_id: adminUser.userId,
      activity_type: 'note',
    });
  });

  it('201 for super_admin role', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${leadId}/activities`,
      superAdminUser.jwt,
      { activity_type: 'meeting', details: {} },
    );
    expect(dataOf<ActivityRow>(res, 201).actor_id).toBe(superAdminUser.userId);
  });

  describe('400 for invalid input (validation error) and records nothing', () => {
    const cases: Array<{ name: string; body: Record<string, unknown> }> = [
      { name: 'invalid activity_type', body: { activity_type: 'INVALID_TYPE', details: {} } },
      { name: 'missing activity_type', body: { details: {} } },
      { name: 'missing details', body: { activity_type: 'call' } },
      { name: 'details that is not an object', body: { activity_type: 'call', details: 'text' } },
    ];

    it.each(cases)('$name', async ({ body }) => {
      const leadId = await seedLead();
      const res = await apiCall(
        'POST',
        `/api/admin/sales/leads/${leadId}/activities`,
        salesUser.jwt,
        body,
      );
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(await readActivities(leadId)).toEqual([]);
    });
  });

  it('404 for a lead that does not exist', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${randomUuid()}/activities`,
      salesUser.jwt,
      { activity_type: 'call', details: {} },
    );
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user and records nothing', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${leadId}/activities`,
      generalUser.jwt,
      { activity_type: 'call', details: {} },
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect(await readActivities(leadId)).toEqual([]);
  });

  it('403 for support role (staff of another domain)', async () => {
    const leadId = await seedLead();
    const res = await apiCall(
      'POST',
      `/api/admin/sales/leads/${leadId}/activities`,
      supportUser.jwt,
      { activity_type: 'call', details: {} },
    );
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const leadId = await seedLead();
    const res = await apiCallNoAuth('POST', `/api/admin/sales/leads/${leadId}/activities`, {
      activity_type: 'call',
      details: {},
    });
    expectError(res, 401);
  });

  // 既知の不具合: POST /leads と同じ (request.json() の SyntaxError が 500 になる)。直ったら `.fails` を外すこと。
  it.fails('[既知の不具合] 400 for malformed JSON body (現状は 500 INTERNAL_ERROR)', async () => {
    const leadId = await seedLead();
    const res = await apiCallRaw(
      'POST',
      `/api/admin/sales/leads/${leadId}/activities`,
      salesUser.jwt,
      '{"activity_type": ',
    );
    expect(res.status).toBe(400);
  });
});
