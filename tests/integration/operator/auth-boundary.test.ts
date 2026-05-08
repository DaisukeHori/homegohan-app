/**
 * Auth boundary tests: parameterized cross-endpoint tests
 * Validates 401 (no auth) and 403 (general user) for all operator endpoints
 * 15 specs covering all major endpoints
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, testEmail, type TestUser } from '../helpers/users';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let generalUser: TestUser;

beforeAll(async () => {
  generalUser = await createTestUserWithRoles({
    email: testEmail('boundary-gen', TS),
    roles: ['user'],
  });
}, 30000);

afterAll(async () => {
  await cleanupTestUser(generalUser.userId);
}, 15000);

/**
 * Endpoints to test for auth boundary
 * Format: [method, path, body?]
 */
const endpoints: Array<{
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  body?: unknown;
}> = [
  // admin/users
  { method: 'GET', path: '/api/admin/users', description: 'GET /api/admin/users' },
  {
    method: 'GET',
    path: '/api/admin/users/00000000-0000-0000-0000-000000000000',
    description: 'GET /api/admin/users/[id]',
  },
  {
    method: 'PATCH',
    path: '/api/admin/users/00000000-0000-0000-0000-000000000000',
    description: 'PATCH /api/admin/users/[id]',
    body: { admin_note: 'test' },
  },
  {
    method: 'POST',
    path: '/api/admin/users/00000000-0000-0000-0000-000000000000/freeze',
    description: 'POST /api/admin/users/[id]/freeze',
    body: {
      ban_type: 'temporary',
      reason_category: 'spam',
      reason_detail: 'test',
      duration_days: 1,
      notify_user: false,
    },
  },
  {
    method: 'POST',
    path: '/api/admin/users/00000000-0000-0000-0000-000000000000/impersonate',
    description: 'POST /api/admin/users/[id]/impersonate',
    body: { reason: 'test' },
  },
  // admin/finance
  { method: 'GET', path: '/api/admin/finance/dashboard', description: 'GET /api/admin/finance/dashboard' },
  { method: 'GET', path: '/api/admin/finance/revenue', description: 'GET /api/admin/finance/revenue' },
  // admin/support
  { method: 'GET', path: '/api/admin/support/tickets', description: 'GET /api/admin/support/tickets' },
  // admin/sales
  { method: 'GET', path: '/api/admin/sales/leads', description: 'GET /api/admin/sales/leads' },
  // super-admin/plans
  { method: 'GET', path: '/api/super-admin/plans', description: 'GET /api/super-admin/plans' },
  // super-admin/coupons
  { method: 'GET', path: '/api/super-admin/coupons', description: 'GET /api/super-admin/coupons' },
  // super-admin/audit-logs
  { method: 'GET', path: '/api/super-admin/audit-logs', description: 'GET /api/super-admin/audit-logs' },
  // super-admin/feature-packages
  { method: 'GET', path: '/api/super-admin/feature-packages', description: 'GET /api/super-admin/feature-packages' },
  // super-admin/coupons redemptions (dummy id)
  {
    method: 'GET',
    path: '/api/super-admin/coupons/00000000-0000-0000-0000-000000000000/redemptions',
    description: 'GET /api/super-admin/coupons/[id]/redemptions',
  },
  // super-admin/plans PATCH (dummy id)
  {
    method: 'PATCH',
    path: '/api/super-admin/plans/00000000-0000-0000-0000-000000000000',
    description: 'PATCH /api/super-admin/plans/[id]',
    body: { display_name: 'Test' },
  },
];

describe('Auth boundary: 401 for no auth (all endpoints)', () => {
  for (const endpoint of endpoints) {
    it(`401 for no auth: ${endpoint.description}`, async () => {
      const res = await apiCallNoAuth(endpoint.method, endpoint.path, endpoint.body);
      expect(res.status).toBe(401);
    });
  }
});

describe('Auth boundary: 403 for general user (all endpoints)', () => {
  for (const endpoint of endpoints) {
    it(`403 for general user: ${endpoint.description}`, async () => {
      const res = await apiCall(endpoint.method, endpoint.path, generalUser.jwt, endpoint.body);
      // General user should always get 403 — auth check runs before resource lookup
      expect(res.status).toBe(403);
    });
  }
});
