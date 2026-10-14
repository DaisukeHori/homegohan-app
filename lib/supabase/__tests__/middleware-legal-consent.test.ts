/**
 * lib/supabase/middleware.ts の規約の再同意ゲート (#1174) のユニットテスト
 *
 * 同意済みの版 (user_profiles.terms_version_accepted / privacy_version_accepted) が packages/shared の
 * LEGAL_DOCUMENTS (いま有効な版) と食い違う利用者を、次のように扱う。
 *   - LEGAL_CONSENT_ENFORCE=on              : 同意画面 /legal-consent?next=<元のパス> へ回す (GET / HEAD の画面だけ)
 *   - LEGAL_CONSENT_NOTICE=on (強制なし)     : 通す。サーバー側の画面へ「同意のお願い」を出すヘッダーを渡すだけ
 *   - どちらも on でない (既定)              : 何もしない (ヘッダーも付けない)
 *
 * 2 つのフラグ × 同意の状態 × 画面 の組み合わせ表は middleware-legal-consent-matrix.test.ts。
 *
 * 判定の組み合わせ (版 × パス × フラグ) そのものは tests/legal-consent-gate.test.ts。
 * ここでは middleware を通した挙動を確かめる:
 *   リダイレクト先・ヘッダー・セッション Cookie の引き継ぎ・既存の差し戻し (凍結・オンボーディング) との順序・
 *   /api/* と /auth/native-bridge の素通り・画面の POST の素通り・列が無い DB (migration の反映前) での素通り
 *
 * 既存の差し戻しのテストは lib/supabase/__tests__/middleware.test.ts。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { LEGAL_DOCUMENTS } from '@homegohan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// @supabase/ssr の createServerClient モック
// ─────────────────────────────────────────────────────────────────────────────

const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockSelect = vi.fn();
const mockCreateServerClient = vi.fn();

mockCreateServerClient.mockImplementation(() => ({
  auth: {
    getSession: mockGetSession,
    getUser: mockGetUser,
  },
  from: (_table: string) => ({
    select: (columns?: string) => {
      mockSelect(columns);
      return {
        eq: () => ({
          maybeSingle: mockMaybeSingle,
        }),
      };
    },
  }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

import { updateSession } from '../middleware';
import { stubSupabasePublicEnv } from './supabase-public-env';

function apiRequest(path = '/api/pantry') {
  return new NextRequest(new URL(`http://localhost${path}`));
}

function pageRequest(path: string, headers?: Record<string, string>, method = 'GET') {
  return new NextRequest(new URL(`http://localhost${path}`), { headers, method });
}

const PENDING_HEADER = 'x-legal-consent-pending';
/** NextResponse.next({ request }) が、転送するリクエストヘッダーを載せるレスポンスヘッダー */
const forwardedPending = (res: Response) => res.headers.get(`x-middleware-request-${PENDING_HEADER}`);
const overriddenHeaders = (res: Response) => res.headers.get('x-middleware-override-headers') ?? '';

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;

function consentProfile(
  accepted: { terms: string | null; privacy: string | null } | 'columns-missing',
  overrides: Record<string, unknown> = {},
) {
  return {
    data: {
      roles: [],
      onboarding_started_at: '2026-03-01T00:00:00.000Z',
      onboarding_completed_at: '2026-03-01T01:00:00.000Z',
      frozen_at: null,
      unban_at: null,
      ...(accepted === 'columns-missing'
        ? {}
        : { terms_version_accepted: accepted.terms, privacy_version_accepted: accepted.privacy }),
      ...overrides,
    },
    error: null,
  };
}

const ACCEPTED_CURRENT = { terms: CURRENT_TERMS, privacy: CURRENT_PRIVACY };
const NOT_ACCEPTED = { terms: null, privacy: null };
const NOT_ONBOARDED = { onboarding_started_at: null, onboarding_completed_at: null };

/** getUser() がトークンを更新したとき (createServerClient の cookies.set が呼ばれる) を再現する */
function mockGetUserRefreshingToken() {
  mockGetUser.mockImplementation(async () => {
    const options = mockCreateServerClient.mock.calls.at(-1)?.[2];
    options.cookies.set('sb-test-auth-token', 'refreshed-token', { path: '/' });
    return { data: { user: { id: 'user-1' } }, error: null };
  });
}

function setUp(enforce: string | undefined, notice: string | undefined = undefined) {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // updateSession は Supabase の URL・anon キーが無いと汎用の 500 で止まる (#1182)。unstubAllEnvs で消えるので入れ直す
  stubSupabasePublicEnv();
  // 未設定 (undefined) も vi.stubEnv で作る (#1435。delete process.env.X は vi.unstubAllEnvs で元に戻らない)
  vi.stubEnv('LEGAL_CONSENT_ENFORCE', enforce);
  vi.stubEnv('LEGAL_CONSENT_NOTICE', notice);
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
}

describe('updateSession — 規約の再同意ゲート (#1174): 既定 (どちらのフラグも on でない) は何もしない', () => {
  beforeEach(() => setUp(undefined, undefined));
  afterEach(() => vi.unstubAllEnvs());

  it('★未同意でも、止めず、「同意のお願い」のヘッダーも付けない (既定ではお知らせを出さない)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBeNull();
    expect(overriddenHeaders(res)).not.toContain(PENDING_HEADER);
  });

  it.each([
    ['未設定', undefined, undefined],
    ['NOTICE=off', undefined, 'off'],
    ['NOTICE が空', undefined, ''],
    ['NOTICE=true (on 以外の値)', undefined, 'true'],
    ['NOTICE=1 (on 以外の値)', 'off', '1'],
    ['ENFORCE=off・NOTICE=off', 'off', 'off'],
  ])('%s なら、未同意でもお知らせも同意画面もない', async (_name, enforce, notice) => {
    setUp(enforce, notice);
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/menus/weekly'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBeNull();
  });

  it('プロフィールの行がまだ無い (新規登録したばかり) 人にも、何も出さない。従来どおり初期設定へ回る', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/onboarding/welcome');
    expect(forwardedPending(res)).toBeNull();
  });

  it('クライアントが送ってきた同名のヘッダーは、既定でも転送しない (お知らせを出させない)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/home', { [PENDING_HEADER]: '1' }));

    expect(res.status).toBe(200);
    expect(forwardedPending(res)).toBeNull();
    expect(overriddenHeaders(res)).not.toContain(PENDING_HEADER);
  });
});

describe('updateSession — 規約の再同意ゲート (#1174): お知らせ (LEGAL_CONSENT_NOTICE=on・強制なし)', () => {
  beforeEach(() => setUp(undefined, 'on'));
  afterEach(() => vi.unstubAllEnvs());

  it('未同意でも誰も止めない: リダイレクトせず、「同意のお願い」を出すヘッダーを画面へ渡す', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBe('1');
    expect(overriddenHeaders(res)).toContain(PENDING_HEADER);
  });

  it.each([
    ['環境変数が未設定', undefined],
    ['空', ''],
    ['off', 'off'],
    ['true (on 以外の値)', 'true'],
  ])('LEGAL_CONSENT_ENFORCE が %s でも、止めない', async (_name, value) => {
    setUp(value, 'on');
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/menus/weekly'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBe('1');
  });

  it('現行の版に同意済みなら、ヘッダーを付けない', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(ACCEPTED_CURRENT));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(forwardedPending(res)).toBeNull();
    expect(overriddenHeaders(res)).not.toContain(PENDING_HEADER);
  });

  it.each([
    ['利用規約だけ古い版', { terms: 'v0-old', privacy: CURRENT_PRIVACY }],
    ['プライバシーポリシーだけ古い版', { terms: CURRENT_TERMS, privacy: 'v0-old' }],
    ['片方が未同意', { terms: CURRENT_TERMS, privacy: null }],
  ])('%s なら、お知らせを出す', async (_name, accepted) => {
    mockMaybeSingle.mockResolvedValue(consentProfile(accepted));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(forwardedPending(res)).toBe('1');
  });

  it('プロフィールの行がまだ無い (新規登録したばかり) 人にも、お知らせを出す。止めない', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await updateSession(pageRequest('/onboarding/welcome'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBe('1');
  });

  it.each(['/terms', '/privacy', '/legal', '/legal-consent', '/auth/callback', '/contact', '/frozen', '/handson-tour/photo'])(
    'ゲートの対象外の %s では、未同意でもお知らせを出さない',
    async (path) => {
      mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

      const res = await updateSession(pageRequest(path));

      expect(res.status).toBe(200);
      expect(forwardedPending(res)).toBeNull();
    },
  );

  it('クライアントが送ってきた同名のヘッダーは、転送しない (同意済みの人の画面にお知らせを出させない)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(ACCEPTED_CURRENT));

    const res = await updateSession(pageRequest('/home', { [PENDING_HEADER]: '1' }));

    expect(res.status).toBe(200);
    expect(forwardedPending(res)).toBeNull();
    expect(overriddenHeaders(res)).not.toContain(PENDING_HEADER);
  });

  it('未ログインの人には、お知らせも同意画面もない (従来どおり /login)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/login?next=%2Fhome');
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it('お知らせを出すときも、トークン更新で溜まったセッション Cookie を失わない', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));
    mockGetUserRefreshingToken();

    const res = await updateSession(pageRequest('/home'));

    expect(forwardedPending(res)).toBe('1');
    expect(res.headers.get('set-cookie') ?? '').toContain('sb-test-auth-token=refreshed-token');
  });

  it('保護ページのレスポンスは、お知らせを出すときも CDN にキャッシュさせない', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/home'));

    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0, must-revalidate');
  });

  it('オンボーディングの差し戻しは、お知らせを出す人にも従来どおり効く', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, NOT_ONBOARDED));

    const res = await updateSession(pageRequest('/meal-plans'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/onboarding/welcome');
  });
});

describe('updateSession — 規約の再同意ゲート (#1174): 強制 (LEGAL_CONSENT_ENFORCE=on)', () => {
  beforeEach(() => setUp('on'));
  afterEach(() => vi.unstubAllEnvs());

  it('未同意の人が保護ページを開くと、同意画面 /legal-consent?next=<元のパス> へ回す', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/legal-consent?next=%2Fhome');
    expect(forwardedPending(res)).toBeNull();
  });

  it('元のクエリは戻り先に残し、RSC の取得 (_rsc) は残さない', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/menus/weekly?date=2026-10-08&mode=app&_rsc=1abc2'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      `http://localhost/legal-consent?next=${encodeURIComponent('/menus/weekly?date=2026-10-08&mode=app')}`,
    );
  });

  it.each([
    ['利用規約だけ古い版', { terms: 'v0-old', privacy: CURRENT_PRIVACY }],
    ['プライバシーポリシーだけ古い版', { terms: CURRENT_TERMS, privacy: 'v0-old' }],
    ['片方が未同意', { terms: CURRENT_TERMS, privacy: null }],
    ['両方古い版', { terms: 'v0-old', privacy: 'v0-old' }],
  ])('%s の人は、再同意のために同意画面へ回す', async (_name, accepted) => {
    mockMaybeSingle.mockResolvedValue(consentProfile(accepted));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/legal-consent?next=%2Fhome');
  });

  it('プロフィールの行がまだ無い新規登録者も、初期設定の前に同意画面へ回す', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await updateSession(pageRequest('/onboarding/welcome'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/legal-consent?next=%2Fonboarding%2Fwelcome');
  });

  it('現行の版に同意済みなら、止めない', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(ACCEPTED_CURRENT));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBeNull();
  });

  it.each([
    '/terms',
    '/privacy',
    '/legal',
    '/legal-consent',
    '/auth/callback',
    '/auth/native-bridge',
    '/auth/verify',
    '/contact',
    '/frozen',
    '/handson-tour',
    '/handson-tour/photo',
  ])('ゲートの対象外の %s は、未同意でも回さない', async (path) => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest(path));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it.each(['/termsx', '/legalx', '/contactx', '/authx', '/frozenx', '/legal-consentx'])(
    '対象外のパスに似ているだけの %s は、未同意なら回す (前方一致の取りこぼし防止)',
    async (path) => {
      mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

      const res = await updateSession(pageRequest(path));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(`http://localhost/legal-consent?next=${encodeURIComponent(path)}`);
    },
  );

  it('★ネイティブ認証ブリッジ (/auth/native-bridge) は、未同意・未オンボーディングのセッションが残っていても横取りしない', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, NOT_ONBOARDED));

    const res = await updateSession(pageRequest('/auth/native-bridge?code=abc'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it.each(['/api/pantry', '/api/legal/accept', '/api/account/export'])(
    '★API (%s) は、未同意でも回さない。API の分岐は user_profiles の凍結の列とロール (メンテナンスモードの判定 #1148) だけを読み、同意済みの版の列は読まない',
    async (path) => {
      mockMaybeSingle.mockResolvedValue({ data: { frozen_at: null, unban_at: null }, error: null });

      const res = await updateSession(apiRequest(path));

      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(mockSelect).toHaveBeenCalledWith('roles, frozen_at, unban_at');
    },
  );

  it('画面の POST (フォーム送信など) は 307 で同意画面へ回さない (受け取れず失敗するため)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/home', undefined, 'POST'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('HEAD は GET と同じように回す', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const res = await updateSession(pageRequest('/home', undefined, 'HEAD'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/legal-consent?next=%2Fhome');
  });

  it('同意画面へ回すときも、トークン更新で溜まったセッション Cookie を失わない', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));
    mockGetUserRefreshingToken();

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(307);
    expect(res.headers.get('set-cookie') ?? '').toContain('sb-test-auth-token=refreshed-token');
  });

  it('★凍結中の人は、未同意でも従来どおり /frozen へ回す (凍結が先)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, { frozen_at: '2026-07-01T00:00:00.000Z' }));

    const res = await updateSession(pageRequest('/meal-plans'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/frozen');
  });

  it('★オンボーディングの差し戻しは従来どおり: 同意済みで初期設定が未着手の人は /onboarding/welcome へ', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(ACCEPTED_CURRENT, NOT_ONBOARDED));

    const res = await updateSession(pageRequest('/meal-plans'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/onboarding/welcome');
  });

  it('同意の確認は、オンボーディングの差し戻しより先: 未同意で初期設定が未着手の人は、まず同意画面へ (戻り先は元のパス)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, NOT_ONBOARDED));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/legal-consent?next=%2Fhome');
  });

  it.each([
    ['初期設定が未着手', NOT_ONBOARDED],
    ['初期設定が途中', { onboarding_started_at: '2026-03-01T00:00:00.000Z', onboarding_completed_at: null }],
  ])(
    '★%s の人が同意画面 /legal-consent を開いても、/onboarding/* へ差し戻さない (差し戻すと同意画面との間で無限にリダイレクトする)',
    async (_name, onboarding) => {
      mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, onboarding));

      const res = await updateSession(pageRequest('/legal-consent?next=%2Fhome'));

      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    },
  );

  it.each([
    ['プロフィールの行がまだ無い', { data: null, error: null }],
    ['行はあるが初期設定が未着手', consentProfile(NOT_ACCEPTED, NOT_ONBOARDED)],
    ['行はあるが初期設定が途中', consentProfile(NOT_ACCEPTED, { onboarding_completed_at: null })],
  ])(
    '★新規登録した人 (%s) が、リダイレクトを最後まで辿ると、同意画面で止まる (ループしない)',
    async (_name, profile) => {
      mockMaybeSingle.mockResolvedValue(profile);

      for (const start of ['/home', '/onboarding/welcome', '/menus/weekly?date=2026-10-08']) {
        const visited: string[] = [];
        let target = start;
        let res = await updateSession(pageRequest(target));
        // ブラウザは 20 回ほどでリダイレクトを諦める。3 回以内に着かなければ、ループしている
        for (let hop = 0; hop < 3 && res.status === 307; hop += 1) {
          const location = new URL(res.headers.get('location')!);
          target = `${location.pathname}${location.search}`;
          visited.push(target);
          res = await updateSession(pageRequest(target));
        }

        expect(res.status, `${start} -> ${visited.join(' -> ')}`).toBe(200);
        expect(new URL(`http://localhost${target}`).pathname).toBe('/legal-consent');
        expect(visited).toHaveLength(1);
      }
    },
  );

  it('同意した後は、同じ人が戻り先 (/home) を開くと、オンボーディングの差し戻しへ進む', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(ACCEPTED_CURRENT, NOT_ONBOARDED));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/onboarding/welcome');
  });

  it('未ログインの人は従来どおり /login へ。同意画面は公開ページではない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest('/legal-consent?next=%2Fhome'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      `http://localhost/login?next=${encodeURIComponent('/legal-consent?next=%2Fhome')}`,
    );
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it('管理者ロールの人も、未同意なら同意画面へ回す (規約はスタッフにも適用される)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, { roles: ['admin'] }));

    const res = await updateSession(pageRequest('/admin'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/legal-consent?next=%2Fadmin');
  });
});

describe('updateSession — 規約の再同意ゲート (#1174): 同意済みの版の列が無い DB (migration の反映前)', () => {
  const columnMissing = {
    data: null,
    error: { code: '42703', message: 'column user_profiles.terms_version_accepted does not exist' },
  };

  beforeEach(() => setUp('on'));
  afterEach(() => vi.unstubAllEnvs());

  it('列が無い間は、お知らせ (LEGAL_CONSENT_NOTICE=on) も出さない', async () => {
    setUp(undefined, 'on');
    mockMaybeSingle
      .mockResolvedValueOnce(columnMissing)
      .mockResolvedValueOnce(consentProfile('columns-missing'));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBeNull();
  });

  it('★列が無くて select が 42703 で失敗しても、列を除いた select でやり直し、強制 on でも同意ゲートだけを素通りさせる', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce(columnMissing)
      .mockResolvedValueOnce(consentProfile('columns-missing'));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBeNull();
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
    expect(mockSelect.mock.calls[0][0]).toContain('terms_version_accepted');
    expect(mockSelect.mock.calls[1][0]).toBe(
      'roles, onboarding_started_at, onboarding_completed_at, frozen_at, unban_at',
    );
  });

  it('★列が無い間も、凍結の差し戻しは止まらない (全員の fail-open にしない)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce(columnMissing)
      .mockResolvedValueOnce(consentProfile('columns-missing', { frozen_at: '2026-07-01T00:00:00.000Z' }));

    const res = await updateSession(pageRequest('/meal-plans'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/frozen');
  });

  it('★列が無い間も、オンボーディングの差し戻しは止まらない', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce(columnMissing)
      .mockResolvedValueOnce(consentProfile('columns-missing', NOT_ONBOARDED));

    const res = await updateSession(pageRequest('/meal-plans'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/onboarding/welcome');
  });

  it('42703 以外のエラーは、やり直さず、従来どおり差し戻しの判定を丸ごと飛ばす (#348)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'jwt expired' } });

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(forwardedPending(res)).toBeNull();
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('やり直した select も失敗したら、差し戻しの判定を丸ごと飛ばす', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce(columnMissing)
      .mockResolvedValueOnce({
        data: null,
        error: { code: '42703', message: 'column user_profiles.frozen_at does not exist' },
      });

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it('列があるときの select は、同意済みの版の 2 列を含む 1 回だけ (追加のクエリを増やさない)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(ACCEPTED_CURRENT));

    await updateSession(pageRequest('/home'));

    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledWith(
      'roles, onboarding_started_at, onboarding_completed_at, frozen_at, unban_at, terms_version_accepted, privacy_version_accepted',
    );
  });
});
