/**
 * #1917 運営の API (営業リード・問い合わせのチケット・会計の書き出し) の本文が JSON として読めないときの回帰テスト
 *
 * 以前は `const body = await request.json()` が route 全体の try の中にあり、壊れた本文の例外が catch の internalError に
 * 流れて 500 (処理中にエラー) になり、構造化ログにも内部エラーとして残った。
 *
 * 直したあとの不変条件: 壊れた JSON は 400 `{ error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } }`
 * (admin/organizations と同じ形)。DB に触れない。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_INVALID_JSON_CODE, API_INVALID_JSON_MESSAGE } from '@/lib/api/error-responses';

const ROW_ID = '20000000-0000-4000-8000-000000000001';
const fromCalls: string[] = [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      fromCalls.push(table);
      throw new Error('DB に触れてはいけない');
    },
  }),
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      fromCalls.push(table);
      throw new Error('DB に触れてはいけない');
    },
  }),
}));

vi.mock('@/lib/auth/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/helpers')>()),
  requireRole: vi.fn(async () => ({ id: '20000000-0000-4000-8000-000000000002', roles: ['super_admin', 'admin', 'support', 'sales', 'finance'] })),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

/** 壊れた JSON の本文 */
const BROKEN_JSON = '{"stage": "meeting"';

function broken(url: string, method: string): NextRequest {
  return new NextRequest(url, { method, headers: { 'Content-Type': 'application/json' }, body: BROKEN_JSON });
}

const ctx = { params: Promise.resolve({ id: ROW_ID }) };

const CASES: Array<{ name: string; call: () => Promise<Response> }> = [
  {
    name: 'POST /api/admin/sales/leads',
    call: async () => (await import('@/app/api/admin/sales/leads/route')).POST(broken('http://localhost/api/admin/sales/leads', 'POST')),
  },
  {
    name: 'PATCH /api/admin/sales/leads/[id]',
    call: async () => (await import('@/app/api/admin/sales/leads/[id]/route')).PATCH(broken(`http://localhost/api/admin/sales/leads/${ROW_ID}`, 'PATCH'), ctx),
  },
  {
    name: 'POST /api/admin/sales/leads/[id]/activities',
    call: async () =>
      (await import('@/app/api/admin/sales/leads/[id]/activities/route')).POST(broken(`http://localhost/api/admin/sales/leads/${ROW_ID}/activities`, 'POST'), ctx),
  },
  {
    name: 'POST /api/admin/support/tickets',
    call: async () => (await import('@/app/api/admin/support/tickets/route')).POST(broken('http://localhost/api/admin/support/tickets', 'POST')),
  },
  {
    name: 'PATCH /api/admin/support/tickets/[id]',
    call: async () => (await import('@/app/api/admin/support/tickets/[id]/route')).PATCH(broken(`http://localhost/api/admin/support/tickets/${ROW_ID}`, 'PATCH'), ctx),
  },
  {
    name: 'POST /api/admin/support/tickets/[id]/assign',
    call: async () =>
      (await import('@/app/api/admin/support/tickets/[id]/assign/route')).POST(broken(`http://localhost/api/admin/support/tickets/${ROW_ID}/assign`, 'POST'), ctx),
  },
  {
    name: 'POST /api/admin/support/tickets/[id]/messages',
    call: async () =>
      (await import('@/app/api/admin/support/tickets/[id]/messages/route')).POST(broken(`http://localhost/api/admin/support/tickets/${ROW_ID}/messages`, 'POST'), ctx),
  },
  {
    name: 'POST /api/admin/finance/exports',
    call: async () => (await import('@/app/api/admin/finance/exports/route')).POST(broken('http://localhost/api/admin/finance/exports', 'POST')),
  },
];

beforeEach(() => {
  fromCalls.length = 0;
});

describe.each(CASES)('$name', ({ call }) => {
  it('壊れた JSON は 400 INVALID_JSON (500 にしない)。DB に触れない', async () => {
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: API_INVALID_JSON_CODE, message: API_INVALID_JSON_MESSAGE } });
    expect(fromCalls).toEqual([]);
  });
});
