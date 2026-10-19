import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_API_CODE, MAINTENANCE_MESSAGE, SERVICE_UNAVAILABLE_STATUS } from '@homegohan/shared';
import { FAMILY_DISSOLVE_API_PATH, ORG_DISSOLVE_API_PATH } from '@/lib/auth/frozen';
import { LEGAL_FACTS } from '@/lib/legal/legal-text';
import { MEMBERSHIP_ERROR_FALLBACK_MESSAGE, MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';
import {
  BLOCKED_SCOPE_UNKNOWN_GUIDANCE,
  DISSOLVED_FAMILY_GROUP_RETENTION_DAYS,
  FROZEN_DISSOLVE_GUIDANCE,
  SELF_DISSOLVE_CONFIRM_KEYWORD,
  SELF_DISSOLVE_COPY,
  SELF_DISSOLVE_FAILED_MESSAGE,
  SELF_DISSOLVED_NEXT_STEP,
  dissolveOwnScope,
  selfDissolveApiPath,
} from '@/lib/membership/self-dissolve';

// #1917 利用者の解散の lib (docs/design/family/11-self-dissolve.md §13.4・§21.1)

/** 作りかけ・先送りを示す語 (R-12)。画面と本文に書かない */
const PENDING_WORDS = ['準備中', '予定'] as const;

const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const DISSOLVED_AT = '2026-10-19T05:00:00.123456+00:00';
/** HTTP の状態 (テストの入力) */
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL = 500;
/** メンテナンスの応答の retryAfter (秒。テストの値) */
const RETRY_AFTER_SECONDS = 300;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(response: Response | (() => Promise<Response>)) {
  const fn = vi.fn(async () => (typeof response === 'function' ? response() : response));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('selfDissolveApiPath (#1917)', () => {
  it('selfDissolveApiPath: family は /api/family/dissolve、organization は /api/org/dissolve (frozen.ts の定数と同じ値)', () => {
    expect(selfDissolveApiPath('family')).toBe('/api/family/dissolve');
    expect(selfDissolveApiPath('organization')).toBe('/api/org/dissolve');
    expect(selfDissolveApiPath('family')).toBe(FAMILY_DISSOLVE_API_PATH);
    expect(selfDissolveApiPath('organization')).toBe(ORG_DISSOLVE_API_PATH);
  });
});

describe('dissolveOwnScope (#1917)', () => {
  it('dissolveOwnScope: 200 なら dissolved と応答の dissolved_at、401 なら unauthorized、4xx と 500 は failed と本文の code から引いた文、通信の失敗は SELF_DISSOLVE_FAILED_MESSAGE', async () => {
    stubFetch(jsonResponse(HTTP_OK, { data: { family_id: FAMILY_ID, dissolved_at: DISSOLVED_AT } }));
    await expect(dissolveOwnScope('family', FAMILY_ID)).resolves.toEqual({ kind: 'dissolved', dissolvedAt: DISSOLVED_AT });

    stubFetch(jsonResponse(HTTP_UNAUTHORIZED, { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } }));
    await expect(dissolveOwnScope('family', FAMILY_ID)).resolves.toEqual({ kind: 'unauthorized' });

    const cases: Array<[number, string]> = [
      [HTTP_FORBIDDEN, MembershipErrorCode.NOT_FAMILY_REPRESENTATIVE],
      [HTTP_CONFLICT, MembershipErrorCode.FAMILY_ALREADY_DISSOLVED],
      [HTTP_CONFLICT, MembershipErrorCode.ORG_ALREADY_DISSOLVED],
      [HTTP_CONFLICT, MembershipErrorCode.CONFLICT_RETRY],
      [HTTP_BAD_REQUEST, MembershipErrorCode.VALIDATION_ERROR],
    ];
    for (const [status, code] of cases) {
      stubFetch(jsonResponse(status, { error: { code, message: '家族グループの解散に失敗しました' } }));
      await expect(dissolveOwnScope('family', FAMILY_ID)).resolves.toEqual({
        kind: 'failed',
        message: MEMBERSHIP_ERROR_MESSAGES[code as MembershipErrorCode],
      });
    }

    // 表に無い code (internalError の INTERNAL_ERROR・null 文字の INVALID_CHARACTER) と JSON でない本文は汎用の文
    stubFetch(jsonResponse(HTTP_INTERNAL, { error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } }));
    await expect(dissolveOwnScope('family', FAMILY_ID)).resolves.toEqual({ kind: 'failed', message: MEMBERSHIP_ERROR_FALLBACK_MESSAGE });
    stubFetch(jsonResponse(HTTP_BAD_REQUEST, { error: '使用できない文字', code: 'INVALID_CHARACTER' }));
    await expect(dissolveOwnScope('family', FAMILY_ID)).resolves.toEqual({ kind: 'failed', message: MEMBERSHIP_ERROR_FALLBACK_MESSAGE });
    stubFetch(new Response('<html>oops</html>', { status: HTTP_INTERNAL }));
    await expect(dissolveOwnScope('family', FAMILY_ID)).resolves.toEqual({ kind: 'failed', message: MEMBERSHIP_ERROR_FALLBACK_MESSAGE });

    // 通信の失敗 (fetch が例外)
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(dissolveOwnScope('organization', ORG_ID)).resolves.toEqual({ kind: 'failed', message: SELF_DISSOLVE_FAILED_MESSAGE });
  });

  it('dissolveOwnScope: メンテナンス中の 503 は failed と MAINTENANCE_MESSAGE (MEMBERSHIP_ERROR_FALLBACK_MESSAGE ではない)。503 でも code の無い本文・知らない code・JSON でない本文は MEMBERSHIP_ERROR_FALLBACK_MESSAGE', async () => {
    // middleware の maintenanceApiResponse() の本文と同じ形を共有の定数で作る
    stubFetch(jsonResponse(SERVICE_UNAVAILABLE_STATUS, { error: MAINTENANCE_MESSAGE, code: MAINTENANCE_API_CODE, retryAfter: RETRY_AFTER_SECONDS }));
    const maintenance = await dissolveOwnScope('family', FAMILY_ID);
    expect(maintenance).toEqual({ kind: 'failed', message: MAINTENANCE_MESSAGE });
    expect(maintenance).not.toEqual({ kind: 'failed', message: MEMBERSHIP_ERROR_FALLBACK_MESSAGE });

    stubFetch(jsonResponse(SERVICE_UNAVAILABLE_STATUS, { error: 'unavailable' }));
    await expect(dissolveOwnScope('organization', ORG_ID)).resolves.toEqual({ kind: 'failed', message: MEMBERSHIP_ERROR_FALLBACK_MESSAGE });
    stubFetch(jsonResponse(SERVICE_UNAVAILABLE_STATUS, { error: 'unavailable', code: 'SOMETHING_ELSE' }));
    await expect(dissolveOwnScope('organization', ORG_ID)).resolves.toEqual({ kind: 'failed', message: MEMBERSHIP_ERROR_FALLBACK_MESSAGE });
    stubFetch(new Response('Service Unavailable', { status: SERVICE_UNAVAILABLE_STATUS }));
    await expect(dissolveOwnScope('organization', ORG_ID)).resolves.toEqual({ kind: 'failed', message: MEMBERSHIP_ERROR_FALLBACK_MESSAGE });
  });

  it('dissolveOwnScope: 送る本文は { family_id, confirm: true } / { organization_id, confirm: true } で Content-Type は application/json', async () => {
    const fetchMock = stubFetch(jsonResponse(HTTP_OK, { data: { family_id: FAMILY_ID, dissolved_at: DISSOLVED_AT } }));
    await dissolveOwnScope('family', FAMILY_ID);
    stubFetch(jsonResponse(HTTP_OK, { data: { organization_id: ORG_ID, dissolved_at: DISSOLVED_AT } }));
    const orgFetch = vi.mocked(fetch);
    await dissolveOwnScope('organization', ORG_ID);

    const [familyUrl, familyInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(familyUrl).toBe('/api/family/dissolve');
    expect(familyInit.method).toBe('POST');
    expect(familyInit.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(familyInit.body))).toEqual({ family_id: FAMILY_ID, confirm: true });

    const [orgUrl, orgInit] = orgFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(orgUrl).toBe('/api/org/dissolve');
    expect(orgInit.method).toBe('POST');
    expect(orgInit.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(orgInit.body))).toEqual({ organization_id: ORG_ID, confirm: true });
  });
});

describe('画面の文 (#1917)', () => {
  it('SELF_DISSOLVE_COPY・FROZEN_DISSOLVE_GUIDANCE・SELF_DISSOLVED_NEXT_STEP・BLOCKED_SCOPE_UNKNOWN_GUIDANCE の文に R-12 の 2 語が無く、家族の effects に保存の日数が入る', () => {
    const texts = [
      ...Object.values(SELF_DISSOLVE_COPY).flatMap((copy) => [
        copy.title,
        ...copy.effects,
        copy.keywordPrompt,
        copy.button,
        copy.submitting,
        copy.done,
      ]),
      FROZEN_DISSOLVE_GUIDANCE,
      SELF_DISSOLVED_NEXT_STEP,
      BLOCKED_SCOPE_UNKNOWN_GUIDANCE,
      SELF_DISSOLVE_FAILED_MESSAGE,
    ];
    for (const text of texts) {
      for (const word of PENDING_WORDS) expect(text, text).not.toContain(word);
    }
    expect(DISSOLVED_FAMILY_GROUP_RETENTION_DAYS).toBe(LEGAL_FACTS.dissolvedFamilyGroupRetentionDays);
    expect(SELF_DISSOLVE_COPY.family.effects.some((line) => line.includes(`${DISSOLVED_FAMILY_GROUP_RETENTION_DAYS} 日`))).toBe(true);
    expect(SELF_DISSOLVE_COPY.family.effects).toHaveLength(5);
  });

  it('組織の effects は 4 行で、「招待」の語を含まない (解散のあとも組織の招待は承諾できる。§0.4・Q-4)', () => {
    expect(SELF_DISSOLVE_COPY.organization.effects).toHaveLength(4);
    for (const line of SELF_DISSOLVE_COPY.organization.effects) expect(line).not.toContain('招待');
  });

  it('SELF_DISSOLVE_CONFIRM_KEYWORD は 解散します', () => {
    expect(SELF_DISSOLVE_CONFIRM_KEYWORD).toBe('解散します');
    expect(SELF_DISSOLVE_COPY.family.keywordPrompt).toContain('「解散します」');
    expect(SELF_DISSOLVE_COPY.organization.keywordPrompt).toContain('「解散します」');
  });
});
