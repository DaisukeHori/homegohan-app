/**
 * routeAfterSignIn.test.ts
 * apps/mobile/src/lib/routeAfterSignIn.ts (docs/design/mobile/08-sign-in-with-apple.md §11.5・§14.1)
 *
 * login.tsx の中にあった振り分けを移した関数。メール・パスワード / Google / Apple の 3 つの入口で共通。
 * 画面からの呼び出しは auth/login.test.tsx (4-3・5) が見る。ここでは関数そのものの振り分けを見る。
 */

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: any[]) => mockReplace(...args) },
}));

const mockGetUser = jest.fn();
const mockFrom = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getUser: (...args: any[]) => mockGetUser(...args) },
    from: (...args: any[]) => mockFrom(...args),
  },
}));

import { routeAfterSignIn } from '../../src/lib/routeAfterSignIn';

const mockSelect = jest.fn();
const mockEq = jest.fn();
const mockSingle = jest.fn();

function setProfile(profile: Record<string, unknown> | null) {
  mockSingle.mockResolvedValue({ data: profile });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } } });
  mockSelect.mockReturnValue({ eq: mockEq });
  mockEq.mockReturnValue({ single: mockSingle });
  mockFrom.mockReturnValue({ select: mockSelect });
  setProfile({ onboarding_started_at: null, onboarding_completed_at: null });
});

describe('routeAfterSignIn', () => {
  it('user_profiles から初期設定の 2 列を、ログインした利用者の id で読む', async () => {
    await routeAfterSignIn(undefined);

    expect(mockFrom).toHaveBeenCalledWith('user_profiles');
    expect(mockSelect).toHaveBeenCalledWith('onboarding_started_at, onboarding_completed_at');
    expect(mockEq).toHaveBeenCalledWith('id', 'uid-1');
  });

  it('?next= が / 始まりならそこへ (初期設定の状態にかかわらず)', async () => {
    await routeAfterSignIn('/meals/new');

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/meals/new');
  });

  it.each([
    ['外部の URL', 'https://evil.example.com/'],
    ['// 始まりでない相対', 'meals/new'],
    ['空文字', ''],
    ['配列', ['/a', '/b']],
    ['undefined', undefined],
  ])('?next= が %s なら無視して通常の振り分けにする', async (_label, next) => {
    setProfile({ onboarding_started_at: '2026-01-01T00:00:00Z', onboarding_completed_at: '2026-01-02T00:00:00Z' });

    await routeAfterSignIn(next as string | string[] | undefined);

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
  });

  it('完了 → /(tabs)/home', async () => {
    setProfile({ onboarding_started_at: '2026-01-01T00:00:00Z', onboarding_completed_at: '2026-01-02T00:00:00Z' });
    await routeAfterSignIn(undefined);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
  });

  it('開始済み (未完了) → /onboarding/resume', async () => {
    setProfile({ onboarding_started_at: '2026-01-01T00:00:00Z', onboarding_completed_at: null });
    await routeAfterSignIn(undefined);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/resume');
  });

  it('未開始 → /onboarding/welcome', async () => {
    setProfile({ onboarding_started_at: null, onboarding_completed_at: null });
    await routeAfterSignIn(undefined);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/welcome');
  });

  it('プロフィールの行が無い (新しい利用者) → /onboarding/welcome', async () => {
    setProfile(null);
    await routeAfterSignIn(undefined);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/welcome');
  });

  it.each([
    ['admin', ['user', 'admin']],
    ['super_admin', ['user', 'super_admin']],
  ])('%s も同じ振り分け (#1122: /admin へは行かない)', async (_label, roles) => {
    setProfile({ roles, onboarding_started_at: '2026-01-01T00:00:00Z', onboarding_completed_at: '2026-01-02T00:00:00Z' });

    await routeAfterSignIn(undefined);

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
    expect(mockReplace).not.toHaveBeenCalledWith('/admin');
  });

  it('user が無ければ何もしない (プロフィールも読まない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await routeAfterSignIn('/meals/new');

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
