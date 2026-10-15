/**
 * tests/api/legal-status-route.test.ts
 *
 * #1442: GET /api/legal/status (本人の同意の状況と、いま強制中か) のテスト
 * (設計書 docs/design/cross/13a-legal-consent-api-server.md §6.14 D・§6.9)。
 * モックは tests/api/onboarding-status-route.test.ts と同型。LEGAL_CONSENT_ENFORCE は vi.stubEnv で入れる。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_DOCUMENTS } from '@homegohan/shared';
import { LegalConsentStatusSchema } from '@/lib/legal-consent-api';

interface LegalRow {
  terms_version_accepted: string | null;
  privacy_version_accepted: string | null;
}

const state: { profile: LegalRow | null; error: { code: string; message: string } | null } = {
  profile: null,
  error: null,
};
const mockGetUser = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockFrom = vi.fn((table: string) => {
  if (table !== 'user_profiles') throw new Error(`unexpected table ${table}`);
  const builder = {
    select: (columns: string) => {
      mockSelect(columns);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      mockEq(column, value);
      return builder;
    },
    maybeSingle: async () => ({ data: state.profile, error: state.error }),
  };
  return builder;
});
const mockGetSupabaseAdmin = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockFrom }),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLoggerError };
    return { ...logger, withUser: () => logger };
  },
  generateRequestId: () => 'req_legal_status_test',
}));

import { GET } from '../../src/app/api/legal/status/route';

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
const OLD_VERSION = 'v0-old';

async function getStatusBody() {
  const res = await GET();
  expect(res.status).toBe(200);
  return LegalConsentStatusSchema.parse(await res.json());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('LEGAL_CONSENT_ENFORCE', 'on');
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  state.profile = { terms_version_accepted: null, privacy_version_accepted: null };
  state.error = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/legal/status (#1442)', () => {
  it('未ログインは 401 { error, code: AUTH_UNAUTHENTICATED }', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: '認証が必要です', code: 'AUTH_UNAUTHENTICATED' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(mockFrom).not.toHaveBeenCalled();

    // getUser のエラーも同じ 401
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'jwt expired' } });
    const res2 = await GET();
    expect(res2.status).toBe(401);
  });

  it('未同意 × ENFORCE=on → required: true、outdated は 2 件、accepted_versions は null', async () => {
    const body = await getStatusBody();

    expect(body.enforced).toBe(true);
    expect(body.accepted).toBe(false);
    expect(body.required).toBe(true);
    expect(body.outdated).toEqual(['terms_of_service', 'privacy_policy']);
    expect(body.accepted_versions).toEqual({ terms_version: null, privacy_version: null });
  });

  it('旧版に同意 × on → required: true、outdated は旧版の文書だけ', async () => {
    state.profile = { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: OLD_VERSION };

    const body = await getStatusBody();

    expect(body.required).toBe(true);
    expect(body.accepted).toBe(false);
    expect(body.outdated).toEqual(['privacy_policy']);
    expect(body.accepted_versions).toEqual({ terms_version: CURRENT_TERMS, privacy_version: OLD_VERSION });
  });

  it('同意済み → required: false、accepted: true、outdated は空', async () => {
    state.profile = { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY };

    const body = await getStatusBody();

    expect(body.required).toBe(false);
    expect(body.accepted).toBe(true);
    expect(body.outdated).toEqual([]);
  });

  it.each([
    ['off', 'off'],
    ['未設定', undefined],
    ['on 以外の値 (true)', 'true'],
  ])('ENFORCE が off → enforced: false、required: false (未同意でも) — %s', async (_name, value) => {
    vi.stubEnv('LEGAL_CONSENT_ENFORCE', value);

    const body = await getStatusBody();

    expect(body.enforced).toBe(false);
    expect(body.accepted).toBe(false);
    expect(body.required).toBe(false);
  });

  it('行が無い新規登録者 → accepted: false', async () => {
    state.profile = null;

    const body = await getStatusBody();

    expect(body.accepted).toBe(false);
    expect(body.required).toBe(true);
    expect(body.outdated).toEqual(['terms_of_service', 'privacy_policy']);
    expect(body.accepted_versions).toEqual({ terms_version: null, privacy_version: null });
  });

  it.each([
    ['DB の一般のエラー', { code: 'PGRST301', message: 'relation user_profiles permission denied for terms_version_accepted' }],
    ['列が無い DB (42703)', { code: '42703', message: 'column user_profiles.terms_version_accepted does not exist' }],
  ])('user_profiles の読み取りが失敗したら 500 (internalError の固定の文。DB の文は本文に出ない) — %s', async (_name, error) => {
    state.profile = null;
    state.error = error;

    const res = await GET();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(text).not.toContain('user_profiles');
    expect(text).not.toContain('terms_version_accepted');
    expect(text).not.toContain(error.code);
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('応答は LegalConsentStatusSchema を通り、Cache-Control は no-store。版と施行日は LEGAL_DOCUMENTS の値', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = LegalConsentStatusSchema.parse(await res.json());
    expect(body.current).toEqual({
      terms_of_service: {
        version: LEGAL_DOCUMENTS.terms_of_service.version,
        effective_date: LEGAL_DOCUMENTS.terms_of_service.effectiveDate,
      },
      privacy_policy: {
        version: LEGAL_DOCUMENTS.privacy_policy.version,
        effective_date: LEGAL_DOCUMENTS.privacy_policy.effectiveDate,
      },
    });
  });

  it('本人のセッションのクライアントで本人の行だけを読む (service role を使わない。select の列は 2 列)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-42' } }, error: null });

    await getStatusBody();

    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith('user_profiles');
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledWith('terms_version_accepted, privacy_version_accepted');
    expect(mockEq).toHaveBeenCalledTimes(1);
    expect(mockEq).toHaveBeenCalledWith('id', 'user-42');
  });
});
