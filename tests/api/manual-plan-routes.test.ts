/**
 * GET / POST / DELETE /api/super-admin/users/[id]/manual-plan (billing/02 §8.5・§9) の route のテスト (#1797 段 B)。
 * 設計書 §13.1 のテスト 15〜24。service と repository の生成・requireRole・Supabase・監査は偽物に差し替え、
 * 判定の順 (§9.0) と応答の形を見る。形の先例: tests/coupons-apply-route.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import { ManualGrantError, MANUAL_GRANT_ERROR_MESSAGES, MANUAL_GRANT_EXPIRES_ON_MESSAGE } from '@/lib/billing/manual-grant';
import { jstToday } from '@/lib/jst-day-ranges';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createClient: vi.fn(),
  recordAdminAudit: vi.fn(),
  createManualGrantRepository: vi.fn(),
  getManualPlanView: vi.fn(),
  grantManualPlan: vi.fn(),
  revokeManualPlan: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: vi.fn() },
}));
// internalError は logger.withUser(userId) の戻り値でログを書く
mocks.logger.withUser.mockReturnValue(mocks.logger);

vi.mock('@/lib/auth/helpers', () => ({ requireRole: (...args: unknown[]) => mocks.requireRole(...args) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: (...args: unknown[]) => mocks.createClient(...args) }));
vi.mock('@/lib/admin/audit', () => ({ recordAdminAudit: (...args: unknown[]) => mocks.recordAdminAudit(...args) }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => mocks.logger,
  generateRequestId: () => 'req-1797',
}));
vi.mock('@/lib/billing/manual-grant-repository', () => ({
  createManualGrantRepository: (...args: unknown[]) => mocks.createManualGrantRepository(...args),
}));
vi.mock('@/lib/billing/manual-grant-service', () => ({
  getManualPlanView: (...args: unknown[]) => mocks.getManualPlanView(...args),
  grantManualPlan: (...args: unknown[]) => mocks.grantManualPlan(...args),
  revokeManualPlan: (...args: unknown[]) => mocks.revokeManualPlan(...args),
}));

const { GET, POST, DELETE } = await import('@/app/api/super-admin/users/[id]/manual-plan/route');

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBSCRIPTION_ID = '33333333-3333-4333-8333-333333333333';
const NO_STORE = 'no-store';
const FUTURE_DATE = '2099-12-31';
const REASON = '検証用の付与';

const actor = { id: ACTOR_ID, email: 'sa@example.com', roles: ['super_admin'], organization_id: null };
const GRANT_RESULT = { subscription_id: SUBSCRIPTION_ID, user_id: TARGET_ID, plan_key: 'pro', status: 'active', expires_at: null };
const REVOKE_RESULT = { subscription_id: SUBSCRIPTION_ID, user_id: TARGET_ID, plan_key: 'pro', status_from: 'active', status_to: 'cancelled' };
const VIEW = { current: null, plans: [], history: [] };
const userScopedClient = { marker: 'user-scoped-client' };
const repositoryMarker = { marker: 'repository' };

function pathOf(id: string): string {
  return `http://localhost/api/super-admin/users/${id}/manual-plan`;
}
function jsonRequest(method: 'POST' | 'DELETE', id: string, body: unknown): Request {
  return new Request(pathOf(id), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function rawRequest(method: 'POST' | 'DELETE', id: string, rawBody: string): Request {
  return new Request(pathOf(id), { method, headers: { 'Content-Type': 'application/json' }, body: rawBody });
}
function getRequest(id: string): Request {
  return new Request(pathOf(id), { method: 'GET' });
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

type Handler = (request: Request, props: { params: Promise<{ id: string }> }) => Promise<Response>;
const HANDLERS: ReadonlyArray<readonly ['GET' | 'POST' | 'DELETE', Handler]> = [
  ['GET', GET as Handler],
  ['POST', POST as Handler],
  ['DELETE', DELETE as Handler],
];

function requestFor(method: 'GET' | 'POST' | 'DELETE', id: string, body?: unknown): Request {
  return method === 'GET' ? getRequest(id) : jsonRequest(method, id, body ?? (method === 'POST' ? { plan_key: 'pro', reason: REASON } : { reason: REASON }));
}

function expectNoServiceCalls() {
  expect(mocks.createManualGrantRepository).not.toHaveBeenCalled();
  expect(mocks.getManualPlanView).not.toHaveBeenCalled();
  expect(mocks.grantManualPlan).not.toHaveBeenCalled();
  expect(mocks.revokeManualPlan).not.toHaveBeenCalled();
  expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue(actor);
  mocks.createClient.mockResolvedValue(userScopedClient);
  mocks.createManualGrantRepository.mockReturnValue(repositoryMarker);
  mocks.getManualPlanView.mockResolvedValue(VIEW);
  mocks.grantManualPlan.mockResolvedValue(GRANT_RESULT);
  mocks.revokeManualPlan.mockResolvedValue(REVOKE_RESULT);
  mocks.recordAdminAudit.mockResolvedValue(undefined);
});

describe('認証・認可 (§9.0 の 2)', () => {
  it('POST/DELETE/GET: 401 AUTH_UNAUTHENTICATED on AuthError and 403 OP_PERMISSION_DENIED on ForbiddenError (incl. MfaRequiredError), without creating the service_role client', async () => {
    const cases = [
      { error: new AuthError('AUTH_UNAUTHENTICATED'), status: 401, code: 'AUTH_UNAUTHENTICATED' },
      { error: new ForbiddenError('PERM_DENIED'), status: 403, code: 'OP_PERMISSION_DENIED' },
      { error: new MfaRequiredError('AUTH_2FA_REQUIRED'), status: 403, code: 'OP_PERMISSION_DENIED' },
    ];
    for (const { error, status, code } of cases) {
      for (const [method, handler] of HANDLERS) {
        mocks.requireRole.mockRejectedValueOnce(error);
        const response = await handler(requestFor(method, TARGET_ID), params(TARGET_ID));
        expect(response.status, `${method} ${code}`).toBe(status);
        const json = (await response.json()) as { error: { code: string } };
        expect(json.error.code).toBe(code);
        expectNoServiceCalls();
      }
    }
    // requireRole は super_admin だけ (既定の assurance = AAL2 のまま)
    expect(mocks.requireRole).toHaveBeenCalledWith(['super_admin']);
    // 想定外の例外 (UserProfileReadError など) は握りつぶさず投げ直す (Next の既定の 500)
    const boom = new Error('profile read failed');
    for (const [method, handler] of HANDLERS) {
      mocks.requireRole.mockRejectedValueOnce(boom);
      await expect(handler(requestFor(method, TARGET_ID), params(TARGET_ID))).rejects.toBe(boom);
    }
  });
});

describe('自分自身 (§9.0 の 4)', () => {
  it('POST/DELETE: the route itself answers 403 OP_SELF_MODIFY with the fixed message when the path id equals the actor id in any letter case (normalizeUuid), before reading the body (a non-JSON body and a Zod-failing body still get 403), without calling createManualGrantRepository, grantManualPlan / revokeManualPlan or recordAdminAudit; GET for the actor id is not refused', async () => {
    const upperCaseActorId = ACTOR_ID.toUpperCase();
    // requireRole が返す id が大文字でも同じ判定になる
    const upperCaseActor = { ...actor, id: upperCaseActorId };
    const selfIds = [ACTOR_ID, upperCaseActorId];
    for (const method of ['POST', 'DELETE'] as const) {
      for (const selfId of selfIds) {
        for (const body of ['not json', '{}', JSON.stringify({ plan_key: 'pro', expires_on: '2000-01-01', reason: '' })]) {
          const response = await (method === 'POST' ? POST : DELETE)(rawRequest(method, selfId, body), params(selfId));
          expect(response.status, `${method} ${selfId} ${body}`).toBe(403);
          const json = (await response.json()) as { error: { code: string; message: string } };
          expect(json.error).toEqual({ code: 'OP_SELF_MODIFY', message: MANUAL_GRANT_ERROR_MESSAGES.OP_SELF_MODIFY });
          expectNoServiceCalls();
        }
      }
      // 実行者の id の側が大文字でも (パスは小文字)
      mocks.requireRole.mockResolvedValueOnce(upperCaseActor);
      const response = await (method === 'POST' ? POST : DELETE)(rawRequest(method, ACTOR_ID, 'not json'), params(ACTOR_ID));
      expect(response.status).toBe(403);
      expectNoServiceCalls();
    }
    // 他人の id は 403 にならない (判定が広すぎない)
    const other = await POST(jsonRequest('POST', TARGET_ID, { plan_key: 'pro', reason: REASON }), params(TARGET_ID));
    expect(other.status).toBe(200);

    // GET は自分の id でも拒まない (読むだけ)
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(actor);
    mocks.createManualGrantRepository.mockReturnValue(repositoryMarker);
    mocks.getManualPlanView.mockResolvedValue(VIEW);
    const get = await GET(getRequest(ACTOR_ID), params(ACTOR_ID));
    expect(get.status).toBe(200);
    expect(mocks.getManualPlanView).toHaveBeenCalledTimes(1);
  });
});

describe('パスの id (§9.0 の 3)', () => {
  it('POST/DELETE/GET: 404 NOT_FOUND for a non-UUID id before calling the service', async () => {
    for (const badId of ['not-a-uuid', '123', '12345678-1234-1234-1234-12345678901']) {
      for (const [method, handler] of HANDLERS) {
        const response = await handler(requestFor(method, badId), params(badId));
        expect(response.status, `${method} ${badId}`).toBe(404);
        const json = (await response.json()) as { error: { code: string; message: string } };
        expect(json.error).toEqual({ code: 'NOT_FOUND', message: MANUAL_GRANT_ERROR_MESSAGES.NOT_FOUND });
        expectNoServiceCalls();
      }
    }
  });
});

describe('POST: 本文の検証 (§9.0 の 5・6)', () => {
  it('POST: 400 OP_INVALID_INPUT for invalid JSON and for Zod failures (expires_on today → message 有効期限は今日より後の日付を指定してください; details has the issues)', async () => {
    // JSON でない
    const notJson = await POST(rawRequest('POST', TARGET_ID, 'not json'), params(TARGET_ID));
    expect(notJson.status).toBe(400);
    const notJsonBody = (await notJson.json()) as { error: { code: string; details: unknown[] } };
    expect(notJsonBody.error.code).toBe('OP_INVALID_INPUT');
    expect(notJsonBody.error.details).toEqual([]);

    // 有効期限が今日 (JST): 固定の文と、issue の入った details
    const today = await POST(jsonRequest('POST', TARGET_ID, { plan_key: 'pro', expires_on: jstToday(), reason: REASON }), params(TARGET_ID));
    expect(today.status).toBe(400);
    const todayBody = (await today.json()) as { error: { code: string; message: string; details: Array<{ path: unknown[] }> } };
    expect(todayBody.error.code).toBe('OP_INVALID_INPUT');
    expect(todayBody.error.message).toBe(MANUAL_GRANT_EXPIRES_ON_MESSAGE);
    expect(todayBody.error.details.length).toBeGreaterThan(0);
    expect(todayBody.error.details.some((issue) => issue.path[0] === 'expires_on')).toBe(true);

    // 存在しない日・理由が空・plan_key が無い
    for (const body of [
      { plan_key: 'pro', expires_on: '2099-02-30', reason: REASON },
      { plan_key: 'pro', reason: '' },
      { reason: REASON },
    ]) {
      const response = await POST(jsonRequest('POST', TARGET_ID, body), params(TARGET_ID));
      expect(response.status, JSON.stringify(body)).toBe(400);
      const json = (await response.json()) as { error: { code: string } };
      expect(json.error.code).toBe('OP_INVALID_INPUT');
    }
    // どれも service・監査に届かない
    expectNoServiceCalls();
  });

  it('DELETE: 400 OP_INVALID_INPUT for invalid JSON and a blank reason, without reaching the service', async () => {
    for (const raw of ['not json', JSON.stringify({ reason: '   ' }), JSON.stringify({})]) {
      const response = await DELETE(rawRequest('DELETE', TARGET_ID, raw), params(TARGET_ID));
      expect(response.status, raw).toBe(400);
      const json = (await response.json()) as { error: { code: string } };
      expect(json.error.code).toBe('OP_INVALID_INPUT');
    }
    expectNoServiceCalls();
  });

  it('POST/DELETE: 400 INVALID_CHARACTER for a NULL character before requireRole (nested body like the other errors of the route. #1917)', async () => {
    for (const method of ['POST', 'DELETE'] as const) {
      const response = await (method === 'POST' ? POST : DELETE)(
        rawRequest(method, TARGET_ID, JSON.stringify({ plan_key: 'pro', reason: 'a\u0000b' })),
        params(TARGET_ID),
      );
      expect(response.status).toBe(400);
      const json = (await response.json()) as { error: { code: string } };
      expect(json.error.code).toBe('INVALID_CHARACTER');
    }
    expect(mocks.requireRole).not.toHaveBeenCalled();
    expectNoServiceCalls();
  });
});

describe('POST: 成功', () => {
  it('POST: 200 { data } on success, calls grantManualPlan with the lower-cased id and expires_on null when omitted, and records admin.billing.manual_grant (warn, target user, details subscription_id/plan_key/expires_at/reason, request passed)', async () => {
    const upperCaseTargetId = TARGET_ID.toUpperCase();
    const request = jsonRequest('POST', upperCaseTargetId, { plan_key: 'pro', reason: `  ${REASON}  ` });
    const response = await POST(request, params(upperCaseTargetId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: GRANT_RESULT });

    expect(mocks.grantManualPlan).toHaveBeenCalledTimes(1);
    expect(mocks.grantManualPlan).toHaveBeenCalledWith(
      { repository: repositoryMarker },
      { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'pro', expiresOn: null },
    );

    expect(mocks.recordAdminAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith({
      supabase: userScopedClient,
      actorId: ACTOR_ID,
      actionType: 'admin.billing.manual_grant',
      targetId: TARGET_ID,
      targetType: 'user',
      details: { subscription_id: SUBSCRIPTION_ID, plan_key: 'pro', expires_at: null, reason: REASON },
      severity: 'warn',
      request,
      routeName: 'POST /api/super-admin/users/[id]/manual-plan',
    });

    // 期限つき: expires_on がそのまま service へ渡る (変換は service の仕事)
    mocks.grantManualPlan.mockClear();
    const withExpiry = await POST(jsonRequest('POST', TARGET_ID, { plan_key: 'family_pro', expires_on: FUTURE_DATE, reason: REASON }), params(TARGET_ID));
    expect(withExpiry.status).toBe(200);
    expect(mocks.grantManualPlan).toHaveBeenCalledWith(
      { repository: repositoryMarker },
      { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'family_pro', expiresOn: FUTURE_DATE },
    );
    // expires_on: null も期限なし
    mocks.grantManualPlan.mockClear();
    await POST(jsonRequest('POST', TARGET_ID, { plan_key: 'pro', expires_on: null, reason: REASON }), params(TARGET_ID));
    expect(mocks.grantManualPlan).toHaveBeenCalledWith(
      { repository: repositoryMarker },
      { userId: TARGET_ID, actorId: ACTOR_ID, planKey: 'pro', expiresOn: null },
    );
  });

  it('POST: maps ManualGrantError to 409 OP_SUBSCRIPTION_ALREADY_ACTIVE / 422 OP_PLAN_NOT_GRANTABLE / 400 OP_INVALID_INPUT with the fixed messages and no audit row', async () => {
    const cases = [
      { code: 'OP_SUBSCRIPTION_ALREADY_ACTIVE', status: 409, message: 'すでに有効な契約があります' },
      { code: 'OP_PLAN_NOT_GRANTABLE', status: 422, message: 'このプランは手動で付与できません' },
      { code: 'OP_INVALID_INPUT', status: 400, message: MANUAL_GRANT_ERROR_MESSAGES.OP_INVALID_INPUT },
      { code: 'NOT_FOUND', status: 404, message: 'ユーザーが見つかりません' },
    ] as const;
    for (const { code, status, message } of cases) {
      mocks.grantManualPlan.mockRejectedValueOnce(new ManualGrantError(code));
      const response = await POST(jsonRequest('POST', TARGET_ID, { plan_key: 'pro', reason: REASON }), params(TARGET_ID));
      expect(response.status, code).toBe(status);
      expect(await response.json()).toEqual({ error: { code, message } });
    }
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe('DELETE', () => {
  it('DELETE: 200 { data } on success and records admin.billing.manual_revoke; 409 OP_NO_MANUAL_SUBSCRIPTION without audit', async () => {
    const request = jsonRequest('DELETE', TARGET_ID, { reason: ` ${REASON} ` });
    const response = await DELETE(request, params(TARGET_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: REVOKE_RESULT });
    expect(mocks.revokeManualPlan).toHaveBeenCalledWith({ repository: repositoryMarker }, { userId: TARGET_ID, actorId: ACTOR_ID });
    expect(mocks.recordAdminAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith({
      supabase: userScopedClient,
      actorId: ACTOR_ID,
      actionType: 'admin.billing.manual_revoke',
      targetId: TARGET_ID,
      targetType: 'user',
      details: { subscription_id: SUBSCRIPTION_ID, plan_key: 'pro', reason: REASON },
      severity: 'warn',
      request,
      routeName: 'DELETE /api/super-admin/users/[id]/manual-plan',
    });

    mocks.recordAdminAudit.mockClear();
    mocks.revokeManualPlan.mockRejectedValueOnce(new ManualGrantError('OP_NO_MANUAL_SUBSCRIPTION'));
    const conflict = await DELETE(jsonRequest('DELETE', TARGET_ID, { reason: REASON }), params(TARGET_ID));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: 'OP_NO_MANUAL_SUBSCRIPTION', message: '手動で付与した有効な契約がありません' },
    });
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('GET: 200 { data: view } with Cache-Control: no-store and no audit row', async () => {
    const response = await GET(getRequest(TARGET_ID), params(TARGET_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(NO_STORE);
    expect(await response.json()).toEqual({ data: VIEW });
    expect(mocks.getManualPlanView).toHaveBeenCalledWith({ repository: repositoryMarker }, TARGET_ID);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('GET: maps ManualGrantError NOT_FOUND to 404', async () => {
    mocks.getManualPlanView.mockRejectedValueOnce(new ManualGrantError('NOT_FOUND'));
    const response = await GET(getRequest(TARGET_ID), params(TARGET_ID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } });
  });
});

describe('Cache-Control: no-store', () => {
  it('responses built by the route carry Cache-Control: no-store: 200 of GET/POST/DELETE, 401/403 from authFailure, 404 for a non-UUID id, 403 OP_SELF_MODIFY from the route self check, 409 / 422 / 400 from ManualGrantError', async () => {
    const responses: Array<{ label: string; response: Response }> = [];
    const body = (method: 'POST' | 'DELETE') => (method === 'POST' ? { plan_key: 'pro', reason: REASON } : { reason: REASON });

    // 200
    responses.push({ label: 'GET 200', response: await GET(getRequest(TARGET_ID), params(TARGET_ID)) });
    responses.push({ label: 'POST 200', response: await POST(jsonRequest('POST', TARGET_ID, body('POST')), params(TARGET_ID)) });
    responses.push({ label: 'DELETE 200', response: await DELETE(jsonRequest('DELETE', TARGET_ID, body('DELETE')), params(TARGET_ID)) });

    // 401 / 403 (authFailure)
    for (const [method, handler] of HANDLERS) {
      mocks.requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
      responses.push({ label: `${method} 401`, response: await handler(requestFor(method, TARGET_ID), params(TARGET_ID)) });
      mocks.requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED'));
      responses.push({ label: `${method} 403`, response: await handler(requestFor(method, TARGET_ID), params(TARGET_ID)) });
      responses.push({ label: `${method} 404`, response: await handler(requestFor(method, 'not-a-uuid'), params('not-a-uuid')) });
    }

    // 自分自身の 403
    for (const method of ['POST', 'DELETE'] as const) {
      const handler = method === 'POST' ? POST : DELETE;
      responses.push({ label: `${method} self 403`, response: await handler(jsonRequest(method, ACTOR_ID, body(method)), params(ACTOR_ID)) });
    }

    // ManualGrantError の 409 / 422 / 400
    for (const code of ['OP_SUBSCRIPTION_ALREADY_ACTIVE', 'OP_PLAN_NOT_GRANTABLE', 'OP_INVALID_INPUT'] as const) {
      mocks.grantManualPlan.mockRejectedValueOnce(new ManualGrantError(code));
      responses.push({ label: `POST ${code}`, response: await POST(jsonRequest('POST', TARGET_ID, body('POST')), params(TARGET_ID)) });
    }
    mocks.revokeManualPlan.mockRejectedValueOnce(new ManualGrantError('OP_NO_MANUAL_SUBSCRIPTION'));
    responses.push({ label: 'DELETE 409', response: await DELETE(jsonRequest('DELETE', TARGET_ID, body('DELETE')), params(TARGET_ID)) });

    for (const { label, response } of responses) {
      expect(response.headers.get('Cache-Control'), label).toBe(NO_STORE);
    }
  });
});

describe('500', () => {
  it('500: internalError (nested) with the fixed message when the service throws a non-ManualGrantError', async () => {
    const secret = 'duplicate key value violates unique constraint "secret-constraint-1797"';
    const boom = Object.assign(new Error(secret), { code: '23505' });
    mocks.getManualPlanView.mockRejectedValueOnce(boom);
    mocks.grantManualPlan.mockRejectedValueOnce(boom);
    mocks.revokeManualPlan.mockRejectedValueOnce(boom);
    for (const [method, handler] of HANDLERS) {
      const response = await handler(requestFor(method, TARGET_ID), params(TARGET_ID));
      expect(response.status, method).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
      // 例外の文面を本文に入れない
      expect(text).not.toContain('secret-constraint-1797');
    }
    // 失敗したときは監査を書かない
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });
});
