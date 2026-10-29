/**
 * #1917 運営の凍結の route (POST・DELETE /api/admin/users/{id}/freeze) の route テスト
 *
 * 以前は次のようになっていた:
 *  - 凍結の解除 (DELETE) が、対象が凍結中かを確かめずに frozen_* を NULL にして 200 と admin.user.unban の監査を残した。
 *    別の運営が先に解除していても、古い画面から送ると 200 になり、解除の監査が二重に残った (POST 側の 409 と非対称)
 *  - ゲート (requireRole) が二段階認証の未完了 (MfaRequiredError) で止めても、本文は「権限がありません」だった
 *
 * 直したあとの不変条件:
 *  - 解除の UPDATE は「凍結中 (frozen_at が NULL でない)」の条件つき。0 行なら読み直し、対象があれば 409 CONFLICT_STALE_DATA、
 *    無ければ 404。どちらも監査を残さない。読み直しの DB の失敗は 500 (監査なし)
 *  - 凍結中の対象なら従来どおり 200 と admin.user.unban の監査
 *  - POST・DELETE とも、MfaRequiredError は 403 OP_PERMISSION_DENIED・二段階認証の日本語の固定の文。
 *    ほかの ForbiddenError は従来どおり「権限がありません」。どちらも DB に触れない
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import { API_MFA_ENROLLMENT_REQUIRED_MESSAGE, API_MFA_REQUIRED_MESSAGE, API_OP_PERMISSION_DENIED_MESSAGE } from '@/lib/api/error-responses';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// テストの中で route を丸ごと読み込むので、負荷の高い機械で既定の時間切れを超えうる (#1605 の同じ型)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const TARGET_ID = '20000000-0000-4000-8000-000000000002';
const BASE = 'http://localhost';
const RAW_DB_MESSAGE = 'connection reset by peer';
const DB_FAILURE = { code: '08006', message: RAW_DB_MESSAGE, details: null, hint: null };

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

const h = vi.hoisted(() => ({
  /** service_role の client の読み書きの結果 (呼んだ順に 1 つずつ取り出す) */
  results: [] as QueryResult[],
  /** service_role の client で作った query (呼んだ順) */
  queries: [] as RecordedQuery[],
  requireRole: vi.fn(),
  recordAdminAudit: vi.fn(async (_input: unknown) => undefined),
  getSupabaseAdmin: vi.fn(),
  createClient: vi.fn(),
}));

function makeQuery(table: string): unknown {
  const recorded: RecordedQuery = { table, calls: [] };
  h.queries.push(recorded);
  const settle = (): Promise<QueryResult> => {
    const next = h.results.shift();
    if (!next) throw new Error(`想定より多く DB を呼んだ (${table})`);
    return Promise.resolve(next);
  };
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return (...args: unknown[]) => {
            recorded.calls.push({ method: String(prop), args });
            return settle();
          };
        }
        return (...args: unknown[]) => {
          recorded.calls.push({ method: String(prop), args });
          return builder;
        };
      },
    },
  );
  return builder;
}

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: h.getSupabaseAdmin,
  createClient: h.createClient,
}));

vi.mock('@/lib/auth/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/helpers')>()),
  requireRole: h.requireRole,
}));

vi.mock('@/lib/admin/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/audit')>()),
  recordAdminAudit: h.recordAdminAudit,
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

function jsonRequest(method: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE}/api/admin/users/${TARGET_ID}/freeze`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: TARGET_ID }) };
const FREEZE_BODY = { ban_type: 'temporary', duration_days: 7, reason_category: 'spam', reason_detail: '迷惑な投稿' };
const UNFREEZE_BODY = { reason: '誤って凍結したため' };

async function callDelete() {
  const { DELETE } = await import('@/app/api/admin/users/[id]/freeze/route');
  return DELETE(jsonRequest('DELETE', UNFREEZE_BODY), ctx);
}

async function callPost() {
  const { POST } = await import('@/app/api/admin/users/[id]/freeze/route');
  return POST(jsonRequest('POST', FREEZE_BODY), ctx);
}

/** 解除の UPDATE の query (update を呼んだもの) */
function unfreezeUpdate(): RecordedQuery {
  const found = h.queries.find((q) => q.calls.some((c) => c.method === 'update'));
  if (!found) throw new Error('解除の UPDATE を呼んでいない');
  return found;
}

beforeEach(() => {
  h.results = [];
  h.queries = [];
  h.requireRole.mockReset();
  h.requireRole.mockResolvedValue({ id: ACTOR_ID, roles: ['admin'] });
  h.recordAdminAudit.mockClear();
  h.getSupabaseAdmin.mockReset();
  h.getSupabaseAdmin.mockImplementation(() => ({ from: (table: string) => makeQuery(table) }));
  h.createClient.mockReset();
  // 監査はモックの recordAdminAudit が受けるので、本人のセッションの client は形だけ
  h.createClient.mockImplementation(async () => ({ from: () => { throw new Error('本人のセッションの client で DB を読まない'); } }));
});

describe('DELETE /api/admin/users/{id}/freeze: 凍結中のときだけ解除する (#1917 P3)', () => {
  it('凍結中の対象: 条件つき (frozen_at が NULL でない) の UPDATE で解除し、200 と admin.user.unban の監査を 1 回残す', async () => {
    h.results = [
      { data: { id: TARGET_ID }, error: null }, // 存在の確認
      { data: { id: TARGET_ID }, error: null }, // 条件つきの UPDATE (1 行)
    ];
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });

    const update = unfreezeUpdate();
    expect(update.table).toBe('user_profiles');
    expect(update.calls).toContainEqual({
      method: 'update',
      args: [{ frozen_at: null, frozen_reason: null, frozen_by: null, unban_at: null }],
    });
    expect(update.calls).toContainEqual({ method: 'eq', args: ['id', TARGET_ID] });
    expect(update.calls).toContainEqual({ method: 'not', args: ['frozen_at', 'is', null] });
    expect(h.results).toHaveLength(0);

    expect(h.recordAdminAudit).toHaveBeenCalledTimes(1);
    expect(h.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'admin.user.unban', targetId: TARGET_ID, actorId: ACTOR_ID, details: UNFREEZE_BODY }),
    );
  });

  it('別の運営が先に解除していた (UPDATE が 0 行・読み直すと対象はある): 409 CONFLICT_STALE_DATA で、監査を残さない', async () => {
    h.results = [
      { data: { id: TARGET_ID }, error: null }, // 存在の確認
      { data: null, error: null }, // 条件つきの UPDATE (0 行)
      { data: { id: TARGET_ID }, error: null }, // 読み直し
    ];
    const res = await callDelete();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'CONFLICT_STALE_DATA',
        message: '対象のユーザーは凍結されていないため、凍結を解除しませんでした。画面を読み込み直して、もう一度確認してください',
      },
    });
    expect(h.results).toHaveLength(0);
    expect(h.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('読んでから書くまでに対象が消えた (UPDATE が 0 行・読み直すと無い): 404 で、監査を残さない', async () => {
    h.results = [
      { data: { id: TARGET_ID }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ];
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } });
    expect(h.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('読み直しの DB の失敗は 500 (409 / 404 にしない)。DB の文面は本文に出さず、監査を残さない', async () => {
    h.results = [
      { data: { id: TARGET_ID }, error: null },
      { data: null, error: null },
      { data: null, error: DB_FAILURE },
    ];
    const res = await callDelete();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: '凍結解除に失敗しました' } });
    expect(text).not.toContain(RAW_DB_MESSAGE);
    expect(h.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('UPDATE の DB の失敗は 500 で、読み直さず、監査を残さない', async () => {
    h.results = [
      { data: { id: TARGET_ID }, error: null },
      { data: null, error: DB_FAILURE },
    ];
    const res = await callDelete();
    expect(res.status).toBe(500);
    expect(h.queries).toHaveLength(2);
    expect(h.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe.each([
  ['POST', callPost],
  ['DELETE', callDelete],
] as const)('%s /api/admin/users/{id}/freeze: 二段階認証の未完了は二段階認証の文 (#1917 P4)', (_method, call) => {
  it.each([
    ['確認 (AUTH_2FA_REQUIRED)', new MfaRequiredError('AUTH_2FA_REQUIRED', 'MFA required'), API_MFA_REQUIRED_MESSAGE],
    ['登録 (AUTH_2FA_ENROLLMENT_REQUIRED)', new MfaRequiredError('AUTH_2FA_ENROLLMENT_REQUIRED'), API_MFA_ENROLLMENT_REQUIRED_MESSAGE],
    ['ロールが足りない (PERM_DENIED)', new ForbiddenError('PERM_DENIED', 'Requires one of: admin, super_admin'), API_OP_PERMISSION_DENIED_MESSAGE],
  ])('%s: 403 OP_PERMISSION_DENIED・その理由の日本語の文で、DB に触れず監査を残さない', async (_label, err, message) => {
    h.requireRole.mockRejectedValue(err);
    const res = await call();
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message } });
    expect(text).not.toContain('Requires');
    expect(text).not.toContain('MFA required');
    expect(h.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(h.recordAdminAudit).not.toHaveBeenCalled();
  });
});
