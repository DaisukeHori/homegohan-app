/**
 * #1435 初回の作成は、必ず同意画面 (/legal-consent) を通す (#1174 の続き)
 *
 * ログイン画面の「Googleで続ける」は、初めての人には新しいアカウントを作るが、サインアップ画面の同意のチェックを通らない。
 * 同意の記録が残るのは同意画面だけなので、/auth/callback (src/app/(auth)/auth/callback/route.ts) で
 * 「初期設定をまだ始めていない (新しいアカウント) のに、いま有効な版に同意していない」人を、
 * LEGAL_CONSENT_ENFORCE の値に関わらず、同意画面へ回す (戻り先 = 本来の遷移先)。みなし同意はしない。
 *
 * 確かめること:
 *   - 新しいアカウント (プロフィールの行なし / 初期設定が未着手) で未同意 → /legal-consent?next=<本来の遷移先>
 *     (OAuth の code・メール確認の token_hash のどちらの経路でも。招待などの next もそのまま戻り先にする)
 *   - LEGAL_CONSENT_ENFORCE が off / 未設定でも回す (フラグに依らない)
 *   - 回さない: 同意済み / 初期設定を始めた・終えた人 / 管理者 / プロフィールを読めなかったとき / 遷移先がゲートの対象外 (/auth/*)
 *   - 判定の関数 resolveFirstSignInDestination の表
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_DOCUMENTS } from '@homegohan/shared';
import { resolveFirstSignInDestination } from '@/lib/legal-consent';

const CURRENT = {
  terms_version_accepted: LEGAL_DOCUMENTS.terms_of_service.version,
  privacy_version_accepted: LEGAL_DOCUMENTS.privacy_policy.version,
};
const OLD_VERSION = 'v0-old';
const STARTED_AT = '2026-10-01T00:00:00.000Z';

type Profile = Record<string, unknown> | null;

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  select: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: () => ({ getAll: () => [] }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      verifyOtp: mocks.verifyOtp,
      getUser: mocks.getUser,
    },
    from: () => ({
      select: (columns: string) => {
        mocks.select(columns);
        return { eq: () => ({ maybeSingle: mocks.maybeSingle }) };
      },
    }),
  }),
}));

const { GET } = await import('@/app/(auth)/auth/callback/route');

const ORIGIN = 'http://localhost:3000';

function setProfile(profile: Profile, error: { message: string } | null = null) {
  mocks.maybeSingle.mockResolvedValue({ data: profile, error });
}

async function callback(query: string): Promise<string> {
  const res = await GET(new Request(`${ORIGIN}/auth/callback${query}`));
  const location = res.headers.get('location');
  expect(location, 'リダイレクトする').not.toBeNull();
  const url = new URL(location!);
  return `${url.pathname}${url.search}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.exchangeCodeForSession.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mocks.verifyOtp.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@example.com' } }, error: null });
  setProfile(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('/auth/callback: 初回の作成は必ず同意画面を通す (#1435)', () => {
  it('★「Googleで続ける」(OAuth の code) で初めて入った人 (プロフィールの行なし) は、同意画面へ。戻り先は初期設定の入口', async () => {
    expect(await callback('?code=abc')).toBe('/legal-consent?next=%2Fonboarding%2Fwelcome');
  });

  it('メール確認 (token_hash) を経て初めて入った人も、同じく同意画面へ', async () => {
    expect(await callback('?token_hash=h&type=signup')).toBe('/legal-consent?next=%2Fonboarding%2Fwelcome');
  });

  it.each([[undefined], ['off'], ['']])(
    '★LEGAL_CONSENT_ENFORCE=%j (強制していない) でも、初回の作成は同意画面へ回す (フラグに依らない)',
    async (value) => {
      vi.stubEnv('LEGAL_CONSENT_ENFORCE', value);
      vi.stubEnv('LEGAL_CONSENT_NOTICE', undefined);
      expect(await callback('?code=abc')).toBe('/legal-consent?next=%2Fonboarding%2Fwelcome');
    },
  );

  it('招待などで next が付いていれば、同意したあとの戻り先はその next (クエリも残す)', async () => {
    const next = '/invite/token-1?ref=mail';
    expect(await callback(`?code=abc&next=${encodeURIComponent(next)}`)).toBe(
      `/legal-consent?next=${encodeURIComponent(next)}`,
    );
  });

  it('プロフィールの行はあるが初期設定が未着手で、未同意の人も同意画面へ', async () => {
    setProfile({ roles: [], onboarding_started_at: null, onboarding_completed_at: null, terms_version_accepted: null, privacy_version_accepted: null });
    expect(await callback('?code=abc')).toBe('/legal-consent?next=%2Fonboarding%2Fwelcome');
  });

  it('古い版にだけ同意している新しいアカウントも同意画面へ', async () => {
    setProfile({ roles: [], onboarding_started_at: null, onboarding_completed_at: null, terms_version_accepted: OLD_VERSION, privacy_version_accepted: CURRENT.privacy_version_accepted });
    expect(await callback('?code=abc')).toBe('/legal-consent?next=%2Fonboarding%2Fwelcome');
  });

  it('同意の判定に使う列 (同意済みの版) をプロフィールから読む', async () => {
    await callback('?code=abc');
    const columns = String(mocks.select.mock.calls[0][0]);
    expect(columns).toContain('terms_version_accepted');
    expect(columns).toContain('privacy_version_accepted');
  });

  describe('回さない', () => {
    it('いま有効な版に同意済みの新しいアカウントは、従来どおり初期設定へ', async () => {
      setProfile({ roles: [], onboarding_started_at: null, onboarding_completed_at: null, ...CURRENT });
      expect(await callback('?code=abc')).toBe('/onboarding/welcome');
    });

    it('初期設定を終えた既存の利用者は、未同意でも従来どおりホームへ (止めるかは LEGAL_CONSENT_ENFORCE と middleware が決める)', async () => {
      setProfile({ roles: [], onboarding_started_at: STARTED_AT, onboarding_completed_at: STARTED_AT, terms_version_accepted: null, privacy_version_accepted: null });
      expect(await callback('?code=abc')).toBe('/home');
    });

    it('初期設定の途中の利用者は、未同意でも従来どおり再開ページへ', async () => {
      setProfile({ roles: [], onboarding_started_at: STARTED_AT, onboarding_completed_at: null, terms_version_accepted: null, privacy_version_accepted: null });
      expect(await callback('?code=abc')).toBe('/onboarding/resume');
    });

    it('管理者は従来どおり管理画面へ', async () => {
      setProfile({ roles: ['admin'], onboarding_started_at: null, onboarding_completed_at: null, terms_version_accepted: null, privacy_version_accepted: null });
      expect(await callback('?code=abc')).toBe('/admin');
    });

    it('プロフィールを読めなかったときは判定できないので回さない (従来どおり初期設定へ)', async () => {
      setProfile(null, { message: 'db down' });
      expect(await callback('?code=abc')).toBe('/onboarding/welcome');
    });

    it('遷移先がゲートの対象外 (/auth/*。パスワードの再設定など) なら回さない', async () => {
      expect(await callback(`?code=abc&next=${encodeURIComponent('/auth/reset-password')}`)).toBe('/auth/reset-password');
    });

    it('サインインできなかったときは従来どおりログイン画面へ', async () => {
      mocks.exchangeCodeForSession.mockResolvedValue({ data: { user: null }, error: { message: 'bad code' } });
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
      expect(await callback('?code=abc')).toBe('/login');
    });
  });
});

describe('resolveFirstSignInDestination (#1435)', () => {
  const NEW_UNACCEPTED = { onboarding_started_at: null, onboarding_completed_at: null, terms_version_accepted: null, privacy_version_accepted: null };

  it.each([
    ['行なし (null)', null, '/onboarding/welcome', '/legal-consent?next=%2Fonboarding%2Fwelcome'],
    ['行なし (undefined)', undefined, '/onboarding/welcome', '/legal-consent?next=%2Fonboarding%2Fwelcome'],
    ['新しいアカウント・未同意', NEW_UNACCEPTED, '/menus/weekly?date=2026-10-08', '/legal-consent?next=%2Fmenus%2Fweekly%3Fdate%3D2026-10-08'],
    ['新しいアカウント・同意済み', { ...NEW_UNACCEPTED, ...CURRENT }, '/onboarding/welcome', '/onboarding/welcome'],
    ['新しいアカウント・片方だけ同意', { ...NEW_UNACCEPTED, terms_version_accepted: CURRENT.terms_version_accepted }, '/onboarding/welcome', '/legal-consent?next=%2Fonboarding%2Fwelcome'],
    ['初期設定を開始済み', { ...NEW_UNACCEPTED, onboarding_started_at: STARTED_AT }, '/onboarding/resume', '/onboarding/resume'],
    ['初期設定を完了済み', { ...NEW_UNACCEPTED, onboarding_completed_at: STARTED_AT }, '/home', '/home'],
    ['遷移先が同意画面そのもの', NEW_UNACCEPTED, '/legal-consent?next=%2Fhome', '/legal-consent?next=%2Fhome'],
    ['遷移先が /auth/*', NEW_UNACCEPTED, '/auth/reset-password', '/auth/reset-password'],
    ['遷移先が /terms', NEW_UNACCEPTED, '/terms', '/terms'],
  ] as const)('%s', (_label, profile, next, expected) => {
    expect(resolveFirstSignInDestination({ next, profile })).toBe(expected);
  });
});
