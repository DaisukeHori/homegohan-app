/**
 * #1584 の 1: GET /api/family/menu (週間献立の家族の表示で、家族の献立を読む API) を、route より前に
 * lib/supabase/middleware.ts の /api の分岐が止めることを確かめる (設計書 docs/design/family/10-family-menu-view.md §15.2・§19.2)。
 *
 * route は凍結・メンテナンス・規約の同意を判定しない (二重に書かない)。止めるのは middleware だけで、その順は
 * 凍結 (403 AUTH_ACCOUNT_FROZEN) → メンテナンス (503 MAINTENANCE_MODE) → 同意 (403 LEGAL_CONSENT_REQUIRED)。
 * /api/family/menu は例外の一覧 (FROZEN_ALLOWED_API_PATHS・通知のトークンの claim・isMaintenanceExemptPath・
 * LEGAL_CONSENT_EXEMPT_API_PATHS) のどれにも当たらない。
 *
 * モックは middleware-legal-consent-api.test.ts と同型。各 it は見る軸の 1 つだけを変え、ほかは止まらない値
 * (凍結なし・メンテナンス OFF・今の版に同意済み・LEGAL_CONSENT_ENFORCE=on) にする。
 * 「止めない」は res.status === 200 かつ x-middleware-next === '1' (middleware-frozen-allowed-api.test.ts と同じ見方)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  LEGAL_DOCUMENTS,
  MAINTENANCE_API_CODE,
  MAINTENANCE_MESSAGE,
  isLegalConsentExemptApiPath,
} from '@homegohan/shared';
import { isFrozenAllowedApiPath } from '@/lib/auth/frozen';
import { isPushTokenClaimApiPath } from '@/lib/push-tokens';
import { isMaintenanceExemptPath } from '@/lib/maintenance-mode';
import { FAMILY_MENU_API_PATH } from '@/lib/membership/family-menu';

const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getSession: mockGetSession, getUser: mockGetUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
  }),
}));

// メンテナンスモードのフラグ。既定は OFF (it ごとに ON を差し込む)
const mockIsFeatureEnabled = vi.fn(async (_key: string, _userId?: string, _options?: unknown) => false);
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string, options?: unknown) => mockIsFeatureEnabled(key, userId, options),
}));

import { updateSession } from '../middleware';
import { stubSupabasePublicEnv } from './supabase-public-env';

const FAMILY_MENU_URL = `${FAMILY_MENU_API_PATH}?startDate=2026-10-12&endDate=2026-10-18`;

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
const FROZEN_AT = '2026-07-01T00:00:00.000Z';
/** 一時 BAN の解除予定を今から前後にずらす長さ */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 止まらない値のプロフィール (凍結なし・運営でない・今の版に同意済み)。軸ごとに上書きする */
function profile(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      roles: ['user'],
      onboarding_started_at: '2026-03-01T00:00:00.000Z',
      onboarding_completed_at: '2026-03-01T01:00:00.000Z',
      frozen_at: null,
      unban_at: null,
      terms_version_accepted: CURRENT_TERMS,
      privacy_version_accepted: CURRENT_PRIVACY,
      ...overrides,
    },
    error: null,
  };
}

const NOT_ACCEPTED = { terms_version_accepted: null, privacy_version_accepted: null };

function familyMenuRequest(): NextRequest {
  return new NextRequest(new URL(`http://localhost${FAMILY_MENU_URL}`), { method: 'GET' });
}

function expectPassed(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get('x-middleware-next')).toBe('1');
}

async function expectFrozen(res: Response) {
  expect(res.status).toBe(403);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await res.json()).toEqual({ error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' } });
}

async function expectMaintenance(res: Response) {
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error?: unknown; code?: unknown; retryAfter?: unknown };
  expect(body.code).toBe(MAINTENANCE_API_CODE);
  expect(body.error).toBe(MAINTENANCE_MESSAGE);
  expect(typeof body.retryAfter).toBe('number');
}

async function expectLegalConsentRequired(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  stubSupabasePublicEnv();
  vi.stubEnv('LEGAL_CONSENT_ENFORCE', 'on');
  vi.stubEnv('LEGAL_CONSENT_NOTICE', undefined);
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'viewer-1' } }, error: null });
  mockIsFeatureEnabled.mockReset();
  mockIsFeatureEnabled.mockResolvedValue(false);
  mockMaybeSingle.mockResolvedValue(profile());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('updateSession — GET /api/family/menu (#1584 の 1): route より前に止める', () => {
  it('止まらない値なら route へ通す (各 it の基準)', async () => {
    expectPassed(await updateSession(familyMenuRequest()));
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('凍結中 (frozen_at があり unban_at が NULL・未来) の見る人の GET /api/family/menu は 403 AUTH_ACCOUNT_FROZEN の本文と Cache-Control: private, no-store。unban_at が過去なら止めない', async () => {
    mockMaybeSingle.mockResolvedValue(profile({ frozen_at: FROZEN_AT, unban_at: null }));
    await expectFrozen(await updateSession(familyMenuRequest()));

    mockMaybeSingle.mockResolvedValue(profile({ frozen_at: FROZEN_AT, unban_at: new Date(Date.now() + ONE_DAY_MS).toISOString() }));
    await expectFrozen(await updateSession(familyMenuRequest()));

    mockMaybeSingle.mockResolvedValue(profile({ frozen_at: FROZEN_AT, unban_at: new Date(Date.now() - ONE_DAY_MS).toISOString() }));
    expectPassed(await updateSession(familyMenuRequest()));
  });

  it('メンテナンス中は、運営でない見る人を 503 MAINTENANCE_MODE で止め、admin / super_admin は止めない', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    mockMaybeSingle.mockResolvedValue(profile({ roles: ['user'] }));
    await expectMaintenance(await updateSession(familyMenuRequest()));

    for (const role of ['admin', 'super_admin']) {
      mockMaybeSingle.mockResolvedValue(profile({ roles: [role] }));
      expectPassed(await updateSession(familyMenuRequest()));
    }
  });

  it('LEGAL_CONSENT_ENFORCE=on で今の版に未同意の見る人は 403 LEGAL_CONSENT_REQUIRED。同意済み・ENFORCE が on でないときは止めない', async () => {
    mockMaybeSingle.mockResolvedValue(profile(NOT_ACCEPTED));
    await expectLegalConsentRequired(await updateSession(familyMenuRequest()));

    mockMaybeSingle.mockResolvedValue(profile());
    expectPassed(await updateSession(familyMenuRequest()));

    for (const value of ['off', undefined]) {
      vi.stubEnv('LEGAL_CONSENT_ENFORCE', value);
      mockMaybeSingle.mockResolvedValue(profile(NOT_ACCEPTED));
      expectPassed(await updateSession(familyMenuRequest()));
    }
  });

  it('凍結中かつ未同意は 403 AUTH_ACCOUNT_FROZEN (凍結が先)。メンテナンス中かつ未同意の運営でない人は 503 (メンテナンスが先)', async () => {
    mockMaybeSingle.mockResolvedValue(profile({ ...NOT_ACCEPTED, frozen_at: FROZEN_AT }));
    await expectFrozen(await updateSession(familyMenuRequest()));

    mockIsFeatureEnabled.mockResolvedValue(true);
    mockMaybeSingle.mockResolvedValue(profile({ ...NOT_ACCEPTED, roles: ['user'] }));
    await expectMaintenance(await updateSession(familyMenuRequest()));
  });

  it('/api/family/menu は isFrozenAllowedApiPath・isPushTokenClaimApiPath・isMaintenanceExemptPath・isLegalConsentExemptApiPath のどれにも当たらない', () => {
    expect(FAMILY_MENU_API_PATH).toBe('/api/family/menu');
    expect(isFrozenAllowedApiPath(FAMILY_MENU_API_PATH)).toBe(false);
    expect(isPushTokenClaimApiPath(FAMILY_MENU_API_PATH)).toBe(false);
    expect(isMaintenanceExemptPath(FAMILY_MENU_API_PATH)).toBe(false);
    expect(isLegalConsentExemptApiPath(FAMILY_MENU_API_PATH)).toBe(false);
  });
});
