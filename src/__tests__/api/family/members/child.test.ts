/**
 * POST /api/family/members/child (#1173 / 設計書 docs/design/cross/14-parental-consent.md §6.5.6 の 1・§6.8・§6.13 D) のユニットテスト
 *
 * 確認すること (T-CR1〜T-CR11):
 *   - 生年月日は必須 (形は YYYY-MM-DD)。暦に無い日・未来・120 年超は 400 CHILD_BIRTH_DATE_INVALID (RPC を呼ばない)
 *   - 18 歳未満は保護者の同意が必須 (無ければ 403 PARENTAL_CONSENT_REQUIRED)。同意書の版が現行と違えば 409 (RPC を呼ばない)
 *   - RPC に生年月日・同意・IP (ヘッダー)・user_agent (512 文字) を渡す。RPC の RAISE は mapPgErrorToHttp で同じ code
 *   - 同意を記録したら、署名した本人のメールアドレスへ控えを送る (best-effort。失敗しても 201)
 *   - 検査の順 (§6.8): Zod → 暦 → 18 歳未満なら 同意の有無 → 版 → RPC
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARENTAL_CONSENT_DOCUMENT, PARENTAL_CONSENT_DOCUMENT_PATH } from '@homegohan/shared';
import { EmailSendError } from '@/lib/emails/send-result';
import { MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';
import { getSiteUrl } from '@/lib/site-config';
import { buildFamilyMembersUrl } from '@/lib/membership/urls';

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const consentRead = vi.fn();
const familyRead = vi.fn();
const fromCalls: Array<{ table: string; select: string; filters: Array<[string, string, unknown]> }> = [];

function builder(table: string) {
  const call = { table, select: '', filters: [] as Array<[string, string, unknown]> };
  fromCalls.push(call);
  const chain = {
    select: (columns: string) => {
      call.select = columns;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      call.filters.push(['eq', column, value]);
      return chain;
    },
    is: (column: string, value: unknown) => {
      call.filters.push(['is', column, value]);
      return chain;
    },
    maybeSingle: async () => (table === 'parental_consents' ? consentRead() : familyRead()),
  };
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: (table: string) => builder(table),
  })),
}));

const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLogWarn, error: mockLogError }),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const mockSendEmail = vi.fn();
vi.mock('@/lib/emails/send', () => ({ sendEmail: mockSendEmail }));

vi.mock('@/lib/emails/membership/family-parental-consent-recorded', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/membership/family-parental-consent-recorded')>();
  return { ...actual, renderFamilyParentalConsentRecordedEmail: vi.fn(actual.renderFamilyParentalConsentRecordedEmail) };
});

const { POST } = await import('@/app/api/family/members/child/route');
const { renderFamilyParentalConsentRecordedEmail } = await import(
  '@/lib/emails/membership/family-parental-consent-recorded'
);

/** JST 2026-10-16 12:00 に固定する (年齢の境を固定するため) */
const FIXED_NOW = new Date('2026-10-16T03:00:00.000Z');
const BIRTH_17 = '2008-10-17';
const BIRTH_8 = '2018-04-01';
const BIRTH_70 = '1956-01-01';
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const MEMBER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'mom@example.com' };
const CONSENT = { version: PARENTAL_CONSENT_DOCUMENT.version, signed_name: '山田 花子', guardian_attested: true };
const MEMBER_ROW = {
  id: MEMBER_ID,
  family_id: FAMILY_ID,
  role: 'child',
  user_id: null,
  display_name: 'たろう',
  birth_date: BIRTH_17,
  child_profile: {},
};
const CONSENT_ROW = { id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', consent_version: PARENTAL_CONSENT_DOCUMENT.version, signed_at: '2026-10-16T03:00:00.000Z' };

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/family/members/child', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function body(extra: Record<string, unknown> = {}) {
  return { family_id: FAMILY_ID, display_name: 'たろう', child_profile: { gender: 'male' }, birth_date: BIRTH_17, consent: CONSENT, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  fromCalls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
  mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
  mockRpc.mockResolvedValue({ data: MEMBER_ROW, error: null });
  consentRead.mockResolvedValue({ data: CONSENT_ROW, error: null });
  familyRead.mockResolvedValue({ data: { name: '山田家' }, error: null });
  mockSendEmail.mockResolvedValue({ ok: true, id: 'email-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/family/members/child の入力の検査', () => {
  it.each([
    ['birth_date が無い', { birth_date: undefined }],
    ['形が 2000/01/01', { birth_date: '2000/01/01' }],
    ['形が abc', { birth_date: 'abc' }],
  ])('T-CR1: %s → 400 VALIDATION_ERROR、RPC を呼ばない', async (_name, extra) => {
    const res = await POST(request(body(extra)));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['暦に無い日', '2001-02-30'],
    ['未来の日付', '2026-10-17'],
    ['121 年前', '1905-10-16'],
  ])('T-CR2: %s → 400 CHILD_BIRTH_DATE_INVALID、RPC を呼ばない', async (_name, birthDate) => {
    const res = await POST(request(body({ birth_date: birthDate })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: MembershipErrorCode.CHILD_BIRTH_DATE_INVALID,
        message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.CHILD_BIRTH_DATE_INVALID],
      },
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T-CR5: 17 歳で consent なし → 403 PARENTAL_CONSENT_REQUIRED、RPC を呼ばない', async () => {
    const res = await POST(request(body({ consent: undefined })));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe(MembershipErrorCode.PARENTAL_CONSENT_REQUIRED);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T-CR7: consent.version が現行と違う → 409 PARENTAL_CONSENT_VERSION_MISMATCH と current、RPC を呼ばない (S10)', async () => {
    const res = await POST(request(body({ consent: { ...CONSENT, version: 'v0-old' } })));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: MembershipErrorCode.PARENTAL_CONSENT_VERSION_MISMATCH,
        message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.PARENTAL_CONSENT_VERSION_MISMATCH],
      },
      current: { version: PARENTAL_CONSENT_DOCUMENT.version, effective_date: PARENTAL_CONSENT_DOCUMENT.effectiveDate },
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/family/members/child の RPC と応答', () => {
  it('T-CR3: RPC には p_birth_date・p_ip (ヘッダー)・p_user_agent (512 文字) が渡る。child_profile に birth_date を入れていない', async () => {
    const res = await POST(
      request(body({ birth_date: BIRTH_70, consent: undefined }), {
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'user-agent': 'u'.repeat(5000),
      }),
    );
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [name, args] = mockRpc.mock.calls[0];
    expect(name).toBe('add_family_child');
    expect(args).toEqual({
      p_family_id: FAMILY_ID,
      p_display_name: 'たろう',
      p_child_profile: { gender: 'male' },
      p_birth_date: BIRTH_70,
      p_consent_version: null,
      p_signed_name: null,
      p_guardian_attested: false,
      p_ip: '203.0.113.7',
      p_user_agent: 'u'.repeat(512),
    });
    expect(args.p_child_profile).not.toHaveProperty('birth_date');
  });

  it('T-CR4: 17 歳 + 有効な consent → RPC に version / signed_name / guardian_attested が渡り、201 { member, consent_recorded: true }', async () => {
    const res = await POST(request(body({ consent: { ...CONSENT, signed_name: '  山田 花子  ' } })));
    expect(res.status).toBe(201);
    const args = mockRpc.mock.calls[0][1];
    expect(args.p_consent_version).toBe(PARENTAL_CONSENT_DOCUMENT.version);
    expect(args.p_signed_name).toBe('山田 花子');
    expect(args.p_guardian_attested).toBe(true);
    expect(args.p_birth_date).toBe(BIRTH_17);
    expect(await res.json()).toEqual({ data: { member: MEMBER_ROW, consent_recorded: true } });
    // 控えの材料は、作った子供の行の有効な同意と家族名
    const consentCall = fromCalls.find((call) => call.table === 'parental_consents')!;
    expect(consentCall.select).toBe('id, consent_version, signed_at');
    expect(consentCall.filters).toEqual([
      ['eq', 'family_member_id', MEMBER_ID],
      ['is', 'revoked_at', null],
    ]);
    const familyCall = fromCalls.find((call) => call.table === 'family_groups')!;
    expect(familyCall.select).toBe('name');
    expect(familyCall.filters).toEqual([['eq', 'id', FAMILY_ID]]);
  });

  it.each([
    [MembershipErrorCode.PARENTAL_CONSENT_REQUIRED, 403],
    [MembershipErrorCode.PARENTAL_CONSENT_SIGNER_NOT_ADULT, 403],
    [MembershipErrorCode.CHILD_BIRTH_DATE_INVALID, 400],
  ])('T-CR6: RPC が %s を RAISE したら %s の同じ code', async (code, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: code } });
    const res = await POST(request(body()));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code, message: '子供メンバーの追加に失敗しました' } });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('既存の MEMBER_LIMIT_EXCEEDED は 409 のまま', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'MEMBER_LIMIT_EXCEEDED' } });
    const res = await POST(request(body()));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('MEMBER_LIMIT_EXCEEDED');
  });
});

describe('POST /api/family/members/child の控えのメール', () => {
  it('T-CR8: 同意を記録したら user.email 宛に family_parental_consent_recorded を 1 通送る。70 歳 (consent_recorded false) には送らない', async () => {
    const res = await POST(request(body({ display_name: 'じろう' })));
    expect(res.status).toBe(201);
    expect(renderFamilyParentalConsentRecordedEmail).toHaveBeenCalledWith({
      email_address: USER.email,
      family_name: '山田家',
      child_display_name: 'じろう',
      consent_version: CONSENT_ROW.consent_version,
      signed_at: CONSENT_ROW.signed_at,
      document_url: `${getSiteUrl()}${PARENTAL_CONSENT_DOCUMENT_PATH}`,
      members_url: buildFamilyMembersUrl(),
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({ template: 'family_parental_consent_recorded', to: USER.email });

    mockSendEmail.mockClear();
    consentRead.mockResolvedValue({ data: null, error: null });
    const adult = await POST(request(body({ birth_date: BIRTH_70, consent: undefined })));
    expect(adult.status).toBe(201);
    expect((await adult.json()).data.consent_recorded).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('T-CR9: メールの失敗 (isEmailFailure) でも 201 で、ログに残す', async () => {
    mockSendEmail.mockResolvedValue({ ok: false, error: new EmailSendError('application_error', 'EMAIL_SEND_FAILED: Service Unavailable', 503, 4, true) });
    const res = await POST(request(body()));
    expect(res.status).toBe(201);
    expect((await res.json()).data.consent_recorded).toBe(true);
    expect(mockLogError).toHaveBeenCalledWith(
      'parental consent email send failed',
      expect.anything(),
      expect.objectContaining({ member_id: MEMBER_ID, consent_id: CONSENT_ROW.id }),
    );
  });

  it('T-CR10: family_groups の select が失敗 / null なら family_name は 家族グループ で送り、warn を残す', async () => {
    familyRead.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'denied' } });
    const res = await POST(request(body()));
    expect(res.status).toBe(201);
    expect(vi.mocked(renderFamilyParentalConsentRecordedEmail).mock.calls[0][0].family_name).toBe('家族グループ');
    expect(mockLogWarn).toHaveBeenCalledWith(
      'parental consent email inputs read failed',
      expect.objectContaining({ family_pg_code: 'PGRST301', consent_pg_code: null }),
    );

    vi.mocked(renderFamilyParentalConsentRecordedEmail).mockClear();
    familyRead.mockResolvedValue({ data: null, error: null });
    await POST(request(body()));
    expect(vi.mocked(renderFamilyParentalConsentRecordedEmail).mock.calls[0][0].family_name).toBe('家族グループ');
  });

  it('T-CR10: parental_consents の select が失敗 / null なら送らず 201 { consent_recorded: false }', async () => {
    for (const read of [{ data: null, error: { code: 'PGRST301', message: 'denied' } }, { data: null, error: null }]) {
      mockSendEmail.mockClear();
      consentRead.mockResolvedValue(read);
      const res = await POST(request(body()));
      expect(res.status).toBe(201);
      expect((await res.json()).data.consent_recorded).toBe(false);
      expect(mockSendEmail).not.toHaveBeenCalled();
    }
  });

  it('T-CR10: user.email が無ければ送らず 201 { consent_recorded: true }', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: USER.id, email: undefined } }, error: null });
    const res = await POST(request(body()));
    expect(res.status).toBe(201);
    expect((await res.json()).data.consent_recorded).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith('parental consent email skipped: no email address', { member_id: MEMBER_ID });
  });
});

describe('POST /api/family/members/child の検査の順 (T-CR11・P15〜P15f)', () => {
  it.each([
    ['形に合わない birth_date + consent なし', { birth_date: '2000/01/01', consent: undefined }, 400, 'VALIDATION_ERROR'],
    ['形に合わない birth_date + 版違いの consent', { birth_date: '2000/01/01', consent: { ...CONSENT, version: 'v0-old' } }, 400, 'VALIDATION_ERROR'],
    ['暦に無い日 + 版違いの consent', { birth_date: '2001-02-30', consent: { ...CONSENT, version: 'v0-old' } }, 400, 'CHILD_BIRTH_DATE_INVALID'],
    ['17 歳 + consent なし', { consent: undefined }, 403, 'PARENTAL_CONSENT_REQUIRED'],
    ['17 歳 + 版違いの consent', { consent: { ...CONSENT, version: 'v0-old' } }, 409, 'PARENTAL_CONSENT_VERSION_MISMATCH'],
    ['17 歳 + 空白だけの signed_name', { consent: { ...CONSENT, signed_name: '   ' } }, 400, 'VALIDATION_ERROR'],
    ['17 歳 + guardian_attested false', { consent: { ...CONSENT, guardian_attested: false } }, 400, 'VALIDATION_ERROR'],
    ['70 歳 + guardian_attested false', { birth_date: BIRTH_70, consent: { ...CONSENT, guardian_attested: false } }, 400, 'VALIDATION_ERROR'],
  ])('%s → %s %s。RPC を呼ばない', async (_name, extra, status, code) => {
    const res = await POST(request(body(extra)));
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('70 歳 + 形の合う版違いの consent は RPC を呼んで 201 { consent_recorded: false } (同意は無視する)', async () => {
    consentRead.mockResolvedValue({ data: null, error: null });
    const res = await POST(request(body({ birth_date: BIRTH_70, consent: { ...CONSENT, version: 'v0-old' } })));
    expect(res.status).toBe(201);
    expect((await res.json()).data.consent_recorded).toBe(false);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('8 歳 + 有効な consent は RPC を呼ぶ (13 歳未満も同じ同意の流れ)', async () => {
    const res = await POST(request(body({ birth_date: BIRTH_8 })));
    expect(res.status).toBe(201);
    expect(mockRpc.mock.calls[0][1].p_birth_date).toBe(BIRTH_8);
  });

  it('未ログインは 401 (入力を見ない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(request({}));
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
