/**
 * Integration tests:
 *   GET    /api/super-admin/experiments
 *   POST   /api/super-admin/experiments
 *   GET    /api/super-admin/experiments/[id]
 *   PATCH  /api/super-admin/experiments/[id]
 *   DELETE /api/super-admin/experiments/[id]
 *   GET    /api/super-admin/experiments/[id]/results
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth), 400/422 (validation)
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

let superAdminUser: TestUser;
let adminUser: TestUser;

/** Experiment created via POST — used in GET/PATCH/results tests */
let testExperimentId: string;
/** Experiment used for DELETE tests (separate to avoid state pollution) */
let deletableExperimentId: string;

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('exp-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('exp-admin', TS), roles: ['admin'] }),
  ]);

  // Create a draft experiment directly via admin client for GET/PATCH/results tests
  const { data } = await supabaseAdmin
    .from('experiments')
    .insert({
      key: `integration_exp_${TS}`,
      name: `Integration Test Experiment ${TS}`,
      hypothesis: 'Users in variant B will have higher retention',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'variant_b', weight: 50 },
      ],
      status: 'draft',
      created_by: null,
    })
    .select('id')
    .single();

  if (data) {
    testExperimentId = data.id;
  }

  // Create another experiment for DELETE tests
  const { data: del } = await supabaseAdmin
    .from('experiments')
    .insert({
      key: `integration_del_exp_${TS}`,
      name: `Delete Test Experiment ${TS}`,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'variant_b', weight: 50 },
      ],
      status: 'draft',
      created_by: null,
    })
    .select('id')
    .single();

  if (del) {
    deletableExperimentId = del.id;
  }
}, 60000);

afterAll(async () => {
  if (testExperimentId) {
    await supabaseAdmin.from('experiment_assignments').delete().eq('experiment_id', testExperimentId);
    await supabaseAdmin.from('experiments').delete().eq('id', testExperimentId);
  }
  if (deletableExperimentId) {
    await supabaseAdmin.from('experiment_assignments').delete().eq('experiment_id', deletableExperimentId);
    await supabaseAdmin.from('experiments').delete().eq('id', deletableExperimentId);
  }

  await Promise.all([
    cleanupAuditLogs(superAdminUser.userId),
    cleanupAuditLogs(adminUser.userId),
  ]);

  await Promise.all([
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(adminUser.userId),
  ]);
}, 30000);

// ─────────────────────────────────────────
// GET /api/super-admin/experiments
// ─────────────────────────────────────────

describe('GET /api/super-admin/experiments', () => {
  it('200 for super_admin with data and meta', async () => {
    const res = await apiCall('GET', '/api/super-admin/experiments', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: { total: number; page: number; per_page: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('total');
    expect(body.meta).toHaveProperty('page');
    expect(body.meta).toHaveProperty('per_page');
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/experiments', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/experiments');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// POST /api/super-admin/experiments
// ─────────────────────────────────────────

describe('POST /api/super-admin/experiments', () => {
  let createdExpId: string;

  afterAll(async () => {
    if (createdExpId) {
      await supabaseAdmin.from('experiment_assignments').delete().eq('experiment_id', createdExpId);
      await supabaseAdmin.from('experiments').delete().eq('id', createdExpId);
    }
  });

  it('201 for super_admin creating an experiment', async () => {
    const res = await apiCall('POST', '/api/super-admin/experiments', superAdminUser.jwt, {
      key: `post_exp_${TS}`,
      name: `POST Integration Test Experiment ${TS}`,
      hypothesis: 'Test hypothesis',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'variant_b', weight: 50 },
      ],
      primary_metric: 'retention_7d',
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: { id: string; status: string; key: string } };
    expect(body.data).toHaveProperty('id');
    expect(body.data.status).toBe('draft');
    expect(body.data.key).toBe(`post_exp_${TS}`);
    createdExpId = body.data.id;
  });

  it('400 for invalid variants (weight sum != 100)', async () => {
    const res = await apiCall('POST', '/api/super-admin/experiments', superAdminUser.jwt, {
      key: `bad_weight_exp_${TS}`,
      name: 'Bad Weight Experiment',
      variants: [
        { key: 'control', weight: 40 },
        { key: 'variant_b', weight: 40 },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('403 for admin', async () => {
    const res = await apiCall('POST', '/api/super-admin/experiments', adminUser.jwt, {
      key: `admin_exp_${TS}`,
      name: 'Admin should fail',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'variant_b', weight: 50 },
      ],
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/super-admin/experiments', {
      key: `noauth_exp_${TS}`,
      name: 'No auth experiment',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'variant_b', weight: 50 },
      ],
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// GET /api/super-admin/experiments/[id]
// ─────────────────────────────────────────

describe('GET /api/super-admin/experiments/[id]', () => {
  it('200 for super_admin fetching experiment detail', async () => {
    if (!testExperimentId) {
      console.warn('Skipping — experiment creation failed');
      return;
    }
    const res = await apiCall(
      'GET',
      `/api/super-admin/experiments/${testExperimentId}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; status: string; variants: unknown[] } };
    expect(body.data.id).toBe(testExperimentId);
    expect(Array.isArray(body.data.variants)).toBe(true);
  });

  it('403 for admin', async () => {
    const id = testExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('GET', `/api/super-admin/experiments/${id}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = testExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('GET', `/api/super-admin/experiments/${id}`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent experiment', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/experiments/00000000-0000-0000-0000-000000000000',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────
// PATCH /api/super-admin/experiments/[id]
// ─────────────────────────────────────────

describe('PATCH /api/super-admin/experiments/[id]', () => {
  it('200 for super_admin updating experiment status', async () => {
    if (!testExperimentId) {
      console.warn('Skipping — experiment creation failed');
      return;
    }
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/experiments/${testExperimentId}`,
      superAdminUser.jwt,
      { status: 'running', name: `Updated Experiment ${TS}` }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; status: string } };
    expect(body.data.status).toBe('running');
  });

  it('400 for invalid status value', async () => {
    const id = testExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/experiments/${id}`,
      superAdminUser.jwt,
      { status: 'invalid_status' }
    );
    expect(res.status).toBe(400);
  });

  it('403 for admin', async () => {
    const id = testExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/experiments/${id}`,
      adminUser.jwt,
      { status: 'running' }
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = testExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth(
      'PATCH',
      `/api/super-admin/experiments/${id}`,
      { status: 'running' }
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// DELETE /api/super-admin/experiments/[id]
// ─────────────────────────────────────────

describe('DELETE /api/super-admin/experiments/[id]', () => {
  it('403 for admin', async () => {
    const id = deletableExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('DELETE', `/api/super-admin/experiments/${id}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = deletableExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('DELETE', `/api/super-admin/experiments/${id}`);
    expect(res.status).toBe(401);
  });

  it('422 for deleting a running experiment', async () => {
    if (!testExperimentId) {
      console.warn('Skipping — experiment creation failed');
      return;
    }
    // testExperimentId was set to 'running' by PATCH test above
    const res = await apiCall(
      'DELETE',
      `/api/super-admin/experiments/${testExperimentId}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(422);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('200 for super_admin deleting a non-running experiment', async () => {
    if (!deletableExperimentId) {
      console.warn('Skipping — experiment creation failed');
      return;
    }
    const res = await apiCall(
      'DELETE',
      `/api/super-admin/experiments/${deletableExperimentId}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; deleted: boolean } };
    expect(body.data.deleted).toBe(true);
    deletableExperimentId = '';
  });
});

// ─────────────────────────────────────────
// GET /api/super-admin/experiments/[id]/results
// ─────────────────────────────────────────

describe('GET /api/super-admin/experiments/[id]/results', () => {
  it('200 for super_admin fetching experiment results', async () => {
    if (!testExperimentId) {
      console.warn('Skipping — experiment creation failed');
      return;
    }
    const res = await apiCall(
      'GET',
      `/api/super-admin/experiments/${testExperimentId}/results`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        experiment_id: string;
        total_assignments: number;
        by_variant: Array<{ variant_key: string; assignment_count: number }>;
      };
    };
    expect(body.data.experiment_id).toBe(testExperimentId);
    expect(typeof body.data.total_assignments).toBe('number');
    expect(Array.isArray(body.data.by_variant)).toBe(true);
  });

  it('403 for admin', async () => {
    const id = testExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'GET',
      `/api/super-admin/experiments/${id}/results`,
      adminUser.jwt
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = testExperimentId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('GET', `/api/super-admin/experiments/${id}/results`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent experiment', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/experiments/00000000-0000-0000-0000-000000000000/results',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });
});
