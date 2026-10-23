/**
 * #1917 POST /api/family/dissolve・POST /api/org/dissolve (代表者・オーナーが自分で解散する API) を、
 * lib/supabase/middleware.ts の /api の分岐がどう扱うかを確かめる (設計書 docs/design/family/11-self-dissolve.md §13.5・§21.1)。
 *
 * 2 本は凍結中も通す API (FROZEN_ALLOWED_API_PATHS) と同意の許可リスト (LEGAL_CONSENT_EXEMPT_API_PATHS) の両方にあるので、
 * 凍結中・未同意でも route へ通す。メンテナンスの例外 (isMaintenanceExemptPath) には無いので、運営でない人は 503 で止まる。
 * middleware の判定の順は 凍結 → メンテナンス → 同意。
 *
 * モックは middleware-family-menu.test.ts と同型。「止めない」は res.status === 200 かつ x-middleware-next === '1'。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LEGAL_DOCUMENTS, MAINTENANCE_API_CODE, MAINTENANCE_MESSAGE, isLegalConsentExemptApiPath } from '@homegohan/shared';
import { FAMILY_DISSOLVE_API_PATH, ORG_DISSOLVE_API_PATH, isFrozenAllowedApiPath } from '@/lib/auth/frozen';
import { isMaintenanceExemptPath } from '@/lib/maintenance-mode';

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

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
const FROZEN_AT = '2026-07-01T00:00:00.000Z';
/** 一時 BAN の解除予定を今から未来にずらす長さ */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** 同意ゲート (#1173) の「完了」に要る生年月日 (成人)。middleware-legal-consent-api.test.ts と同じ値 */
const ADULT_BIRTH_DATE = '1990-01-01';

const PATHS = [FAMILY_DISSOLVE_API_PATH, ORG_DISSOLVE_API_PATH] as const;

/** 止まらない値のプロフィール (凍結なし・運営でない・今の版に同意済み・成人の生年月日あり)。軸ごとに上書きする */
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
      birth_date: ADULT_BIRTH_DATE,
      ...overrides,
    },
    error: null,
  };
}

const NOT_ACCEPTED = { terms_version_accepted: null, privacy_version_accepted: null };
const frozenUntilTomorrow = () => ({ frozen_at: FROZEN_AT, unban_at: new Date(Date.now() + ONE_DAY_MS).toISOString() });

function dissolveRequest(path: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
}

function expectPassed(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get('x-middleware-next')).toBe('1');
}

async function expectMaintenance(res: Response) {
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error?: unknown; code?: unknown; retryAfter?: unknown };
  expect(body.code).toBe(MAINTENANCE_API_CODE);
  expect(body.error).toBe(MAINTENANCE_MESSAGE);
  expect(typeof body.retryAfter).toBe('number');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  stubSupabasePublicEnv();
  vi.stubEnv('LEGAL_CONSENT_ENFORCE', 'on');
  vi.stubEnv('LEGAL_CONSENT_NOTICE', undefined);
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'rep-1' } }, error: null });
  mockIsFeatureEnabled.mockReset();
  mockIsFeatureEnabled.mockResolvedValue(false);
  mockMaybeSingle.mockResolvedValue(profile());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('updateSession — POST /api/family/dissolve・POST /api/org/dissolve (#1917)', () => {
  it('2 本は凍結中も通す一覧と同意の許可リストにあり、メンテナンスの例外には無い', () => {
    for (const path of PATHS) {
      expect(isFrozenAllowedApiPath(path), path).toBe(true);
      expect(isLegalConsentExemptApiPath(path), path).toBe(true);
      expect(isMaintenanceExemptPath(path), path).toBe(false);
    }
  });

  it.each(PATHS)('凍結中 (frozen_at・unban_at 未来) でも %s は route へ通す (403 AUTH_ACCOUNT_FROZEN にならない)', async (path) => {
    mockMaybeSingle.mockResolvedValue(profile(frozenUntilTomorrow()));
    expectPassed(await updateSession(dissolveRequest(path)));

    mockMaybeSingle.mockResolvedValue(profile({ frozen_at: FROZEN_AT, unban_at: null }));
    expectPassed(await updateSession(dissolveRequest(path)));
  });

  it.each(PATHS)('未同意 × LEGAL_CONSENT_ENFORCE=on でも %s は通す (同意の許可リスト)', async (path) => {
    mockMaybeSingle.mockResolvedValue(profile(NOT_ACCEPTED));
    expectPassed(await updateSession(dissolveRequest(path)));

    // 凍結中かつ未同意も通す
    mockMaybeSingle.mockResolvedValue(profile({ ...NOT_ACCEPTED, ...frozenUntilTomorrow() }));
    expectPassed(await updateSession(dissolveRequest(path)));
  });

  it.each(PATHS)('メンテナンス中は %s を 503 MAINTENANCE_MODE で止める (運営ロールは通す)', async (path) => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    mockMaybeSingle.mockResolvedValue(profile({ roles: ['user'] }));
    await expectMaintenance(await updateSession(dissolveRequest(path)));

    for (const role of ['admin', 'super_admin']) {
      mockMaybeSingle.mockResolvedValue(profile({ roles: [role] }));
      expectPassed(await updateSession(dissolveRequest(path)));
    }
  });

  it.each(PATHS)('凍結中 (frozen_at・unban_at 未来) かつメンテナンス中は %s を 503 MAINTENANCE_MODE (凍結の例外で 403 AUTH_ACCOUNT_FROZEN にならず、メンテナンスで止まる)', async (path) => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockMaybeSingle.mockResolvedValue(profile({ roles: ['user'], ...frozenUntilTomorrow() }));
    await expectMaintenance(await updateSession(dissolveRequest(path)));

    // 未同意も重ねて同じ (メンテナンスが同意より先)
    mockMaybeSingle.mockResolvedValue(profile({ roles: ['user'], ...NOT_ACCEPTED, ...frozenUntilTomorrow() }));
    await expectMaintenance(await updateSession(dissolveRequest(path)));
  });
});
