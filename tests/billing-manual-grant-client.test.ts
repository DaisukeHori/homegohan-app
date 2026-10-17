/**
 * 手動のプラン付与 (billing/02 §8.4) の画面の通信の facade のテスト (#1797 段 B)。fetch は vi.stubGlobal で偽物にする。
 * 設計書 §13.1 のテスト 58。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualPlanGrantResponseSchema, manualPlanPath } from '@/lib/billing/manual-grant';
import {
  MANUAL_GRANT_CLIENT_NO_STATUS,
  MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
  fetchManualPlanView,
  grantManualPlanRequest,
  requestManualPlanApi,
  revokeManualPlanRequest,
} from '@/lib/billing/manual-grant-client';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SUBSCRIPTION_ID = '33333333-3333-4333-8333-333333333333';
const PATH = manualPlanPath(USER_ID);

const GRANT_DATA = { subscription_id: SUBSCRIPTION_ID, user_id: USER_ID, plan_key: 'pro', status: 'active', expires_at: null };
const REVOKE_DATA = { subscription_id: SUBSCRIPTION_ID, user_id: USER_ID, plan_key: 'pro', status_from: 'active', status_to: 'cancelled' };
const VIEW_DATA = { current: null, plans: [{ plan_key: 'pro', display_name: 'プロ', plan_type: 'personal', max_members: null }], history: [] };

function stubFetch(response: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn(typeof response === 'function' ? response : async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestManualPlanApi', () => {
  it('requestManualPlanApi returns { ok: true, data } for a 2xx body matching the schema; for non-2xx it returns { ok: false, status, code } with the code from the nested body { error: { code, message } } and from the flat body { error, code } and never exposes the body message (the failure object has exactly the keys ok/status/code); UNKNOWN code for an unreadable body; NO_STATUS + UNKNOWN when fetch throws or a 2xx body does not match', async () => {
    // 2xx で形が合う: data を返す
    stubFetch(jsonResponse({ data: GRANT_DATA }, 200));
    const success = await requestManualPlanApi(PATH, { method: 'POST' }, ManualPlanGrantResponseSchema);
    expect(success).toEqual({ ok: true, data: { data: GRANT_DATA } });

    // nested の失敗の本文: code だけを読む。本文の message は結果に出さない
    stubFetch(jsonResponse({ error: { code: 'OP_SUBSCRIPTION_ALREADY_ACTIVE', message: 'すでに有効な契約があります (secret-detail-1797)' } }, 409));
    const nested = await requestManualPlanApi(PATH, { method: 'POST' }, ManualPlanGrantResponseSchema);
    expect(nested).toEqual({ ok: false, status: 409, code: 'OP_SUBSCRIPTION_ALREADY_ACTIVE' });
    expect(Object.keys(nested).sort()).toEqual(['code', 'ok', 'status']);
    expect(JSON.stringify(nested)).not.toContain('secret-detail-1797');

    // flat の失敗の本文 (rejectNullCharacterBody): code だけを読む
    stubFetch(jsonResponse({ error: '本文に使えない文字が含まれています (secret-flat-1797)', code: 'INVALID_CHARACTER' }, 400));
    const flat = await requestManualPlanApi(PATH, { method: 'POST' }, ManualPlanGrantResponseSchema);
    expect(flat).toEqual({ ok: false, status: 400, code: 'INVALID_CHARACTER' });
    expect(Object.keys(flat).sort()).toEqual(['code', 'ok', 'status']);
    expect(JSON.stringify(flat)).not.toContain('secret-flat-1797');

    // 本文が読めない (JSON でない / 空 / code が無い) 失敗: status は保ち、code は UNKNOWN
    stubFetch(new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(await requestManualPlanApi(PATH, { method: 'GET' }, ManualPlanGrantResponseSchema)).toEqual({
      ok: false,
      status: 502,
      code: MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
    });
    stubFetch(jsonResponse({ error: { message: 'code が無い' } }, 500));
    expect(await requestManualPlanApi(PATH, { method: 'GET' }, ManualPlanGrantResponseSchema)).toEqual({
      ok: false,
      status: 500,
      code: MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
    });
    stubFetch(jsonResponse({ error: { code: '' } }, 500));
    expect(await requestManualPlanApi(PATH, { method: 'GET' }, ManualPlanGrantResponseSchema)).toEqual({
      ok: false,
      status: 500,
      code: MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
    });

    // fetch が例外を投げた: NO_STATUS + UNKNOWN
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await requestManualPlanApi(PATH, { method: 'GET' }, ManualPlanGrantResponseSchema)).toEqual({
      ok: false,
      status: MANUAL_GRANT_CLIENT_NO_STATUS,
      code: MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
    });

    // 2xx なのに本文が形に合わない / JSON でない: NO_STATUS + UNKNOWN
    stubFetch(jsonResponse({ data: { plan_key: 'pro' } }, 200));
    expect(await requestManualPlanApi(PATH, { method: 'POST' }, ManualPlanGrantResponseSchema)).toEqual({
      ok: false,
      status: MANUAL_GRANT_CLIENT_NO_STATUS,
      code: MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
    });
    stubFetch(new Response('not json', { status: 200 }));
    expect(await requestManualPlanApi(PATH, { method: 'POST' }, ManualPlanGrantResponseSchema)).toEqual({
      ok: false,
      status: MANUAL_GRANT_CLIENT_NO_STATUS,
      code: MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
    });
  });

  it('calls fetch once with same-origin credentials, no-store and the given method/headers/body', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: GRANT_DATA }, 200));
    await requestManualPlanApi(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }, ManualPlanGrantResponseSchema);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });
});

describe('manual-plan の 3 つの呼び出し', () => {
  it('fetchManualPlanView sends GET and unwraps { data }', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: VIEW_DATA }, 200));
    const result = await fetchManualPlanView(USER_ID);
    expect(result).toEqual({ ok: true, data: VIEW_DATA });
    expect(fetchMock).toHaveBeenCalledWith(PATH, expect.objectContaining({ method: 'GET' }));
  });

  it('grantManualPlanRequest sends POST with a JSON body and unwraps { data }', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: GRANT_DATA }, 200));
    const body = { plan_key: 'pro', expires_on: null, reason: '検証用の付与' };
    const result = await grantManualPlanRequest(USER_ID, body);
    expect(result).toEqual({ ok: true, data: GRANT_DATA });
    expect(fetchMock).toHaveBeenCalledWith(
      PATH,
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    );
  });

  it('revokeManualPlanRequest sends DELETE with a JSON body, unwraps { data } and passes a failure through', async () => {
    const fetchMock = stubFetch(jsonResponse({ data: REVOKE_DATA }, 200));
    const body = { reason: '検証の終了' };
    expect(await revokeManualPlanRequest(USER_ID, body)).toEqual({ ok: true, data: REVOKE_DATA });
    expect(fetchMock).toHaveBeenCalledWith(
      PATH,
      expect.objectContaining({ method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    );

    stubFetch(jsonResponse({ error: { code: 'OP_NO_MANUAL_SUBSCRIPTION', message: '手動で付与した有効な契約がありません' } }, 409));
    expect(await revokeManualPlanRequest(USER_ID, body)).toEqual({ ok: false, status: 409, code: 'OP_NO_MANUAL_SUBSCRIPTION' });
  });
});
