// @vitest-environment node
//
// #2093 W1: A/B テストの作成で、同じキーの実験がすでにあるとき (experiments_key_key の一意の違反 23505) は
// 409 と「同じキーの実験がすでにあります」を返す (機能フラグの作成の route と同じ形)。
// 以前は 500「処理中にエラーが発生しました」で、作成の応答が切れたあとに押し直すと、作成は済んでいるのに
// 画面に「実験の作成に失敗しました」と出た。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPERIMENT_KEY_DUPLICATE_ERROR_CODE,
  EXPERIMENT_KEY_DUPLICATE_MESSAGE,
} from '@/lib/super-admin/experiments-schemas';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/admin/audit', () => ({
  recordAdminAudit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { error: () => undefined, warn: () => undefined, info: () => undefined, withUser: () => logger };
  return { createLogger: () => logger, generateRequestId: () => 'req-2093' };
});

/** insert().select().single() が返す結果 */
let insertResult: { data: unknown; error: { code: string; message: string } | null } = { data: null, error: null };
const inserts: string[] = [];

function insertChain(table: string) {
  return {
    insert: () => {
      inserts.push(table);
      return { select: () => ({ single: () => Promise.resolve(insertResult) }) };
    },
  };
}

const fakeClient = { from: (table: string) => insertChain(table) };

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeClient),
  getSupabaseAdmin: () => fakeClient,
}));

const experiments = await import('@/app/api/super-admin/experiments/route');

const actor = { id: 'sa-2093', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };
const VALID_BODY = {
  key: 'dup_key_2093',
  name: '重複するキー',
  variants: [
    { key: 'control', weight: 50 },
    { key: 'variant_a', weight: 50 },
  ],
};

function postRequest(body: unknown): never {
  return new Request('http://localhost/api/super-admin/experiments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  mockRequireRole.mockResolvedValue(actor);
});

describe('POST /api/super-admin/experiments: 同じキーの実験 (#2093 W1)', () => {
  it('experiments_key_key の一意の違反 (23505) は 409 と「同じキーの実験がすでにあります」(500 にしない)', async () => {
    insertResult = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "experiments_key_key"' },
    };
    const res = await experiments.POST(postRequest(VALID_BODY));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(EXPERIMENT_KEY_DUPLICATE_ERROR_CODE);
    expect(body.error.message).toBe(EXPERIMENT_KEY_DUPLICATE_MESSAGE);
    expect(EXPERIMENT_KEY_DUPLICATE_MESSAGE).toBe('同じキーの実験がすでにあります');
    expect(inserts).toEqual(['experiments']);
  });

  it('ほかの DB の失敗はこれまでどおり 500', async () => {
    insertResult = { data: null, error: { code: '08006', message: 'connection failure' } };
    const res = await experiments.POST(postRequest(VALID_BODY));

    expect(res.status).toBe(500);
  });

  it('作成できたら 201', async () => {
    insertResult = { data: { id: '20932093-2093-4093-8093-209320932093', key: VALID_BODY.key }, error: null };
    const res = await experiments.POST(postRequest(VALID_BODY));

    expect(res.status).toBe(201);
  });
});
