/**
 * profile-guest-name.test.tsx
 * apps/mobile/app/profile/index.tsx のプロフィールカードの名前 (#1635)
 *
 * 名前が無いときにアプリが入れる仮置きの 'Guest' を、プロフィールカードの名前・基本タブのニックネームとして出さない。
 * 判定は Web と同じ @homegohan/shared の normalizeProfileName (前後の空白を除いて 'Guest' と厳密一致・空・空白だけは名前なし)。
 * 名前が無いときの出し方は従来どおり: プロフィール (API) → ProfileProvider → メールアドレスの @ の前 → 'ゲスト'。
 * 基本タブのニックネームは従来どおり名前が無ければ「未設定」。
 * 編集中の入力欄は保存される値そのもの (仮置きも含む) を出す (入力欄を空にすると、そのまま保存できなくなるため変えない)。
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// ---- Mocks ----

const mockGet = jest.fn();
const mockPatch = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    patch: mockPatch,
  }),
}));

// supabase mock
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'uid-1' } } }),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { week_start_day: 'monday' } }),
      update: jest.fn().mockReturnThis(),
    }),
  },
}));

// user-storage mock
jest.mock('../../src/lib/user-storage', () => ({
  clearUserScopedAsyncStorage: jest.fn().mockResolvedValue(undefined),
}));

// ログアウトの共通処理 (push token の削除 → 端末データの削除 → サインアウト) は別テストで検証する
const mockSignOutOnDevice = jest.fn();
jest.mock('../../src/lib/signOut', () => ({
  signOutOnDevice: (...args: unknown[]) => mockSignOutOnDevice(...args),
}));

// AuthProvider mock
const mockClearSession = jest.fn();
let mockAuthEmail: string | null = 'test@example.com';
jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'uid-1', email: mockAuthEmail },
    clearSession: mockClearSession,
  }),
}));

// ProfileProvider mock
const mockRefreshProfile = jest.fn();
let mockCtxNickname: string | null = null;
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({
    profile: { nickname: mockCtxNickname },
    refresh: mockRefreshProfile,
  }),
}));

// expo-router mock
const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockRouterReplace(...args) },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

// Linking mock
jest.mock('react-native/Libraries/Linking/Linking', () => ({
  openURL: jest.fn(),
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff',
    card: '#fafafa',
    accent: '#4f46e5',
    accentLight: '#eef2ff',
    text: '#111',
    textLight: '#555',
    textMuted: '#999',
    purple: '#7c3aed',
    warning: '#d97706',
    warningLight: '#fffbeb',
    success: '#16a34a',
    successLight: '#f0fdf4',
    error: '#dc2626',
    errorLight: '#fef2f2',
    border: '#e5e7eb',
    blue: '#2563eb',
    blueLight: '#dbeafe',
    streak: '#f97316',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, '4xl': 64 },
  radius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
  shadows: { sm: {} },
}));

jest.mock('../../src/components/ui', () => {
  const React = require('react');
  const { Text, View, TouchableOpacity } = require('react-native');
  return {
    Card: ({ children }: any) => <View>{children}</View>,
    ListItem: ({ label, value }: any) => (
      <View>
        <Text>{label}</Text>
        <Text>{value}</Text>
      </View>
    ),
    LoadingState: ({ message }: any) => <Text testID="loading">{message ?? '読み込み中...'}</Text>,
    PageHeader: ({ title, right }: any) => (
      <View>
        <Text>{title}</Text>
        {right}
      </View>
    ),
  };
});

import ProfilePage from '../../app/profile/index';

function mockProfileResponse(nickname: string | null) {
  mockGet.mockReset();
  mockGet
    .mockResolvedValueOnce({ nickname, fitnessGoals: [], healthConditions: [], kitchenAppliances: [], hobbies: [] }) // /api/profile
    .mockResolvedValueOnce({ badges: [] }) // /api/badges
    .mockResolvedValueOnce({ settings: { notifications_enabled: true, auto_analyze_enabled: true } }); // /api/notification-preferences
}

async function renderLoaded() {
  render(<ProfilePage />);
  await waitFor(() => expect(screen.queryByTestId('loading')).toBeNull());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthEmail = 'test@example.com';
  mockCtxNickname = null;
});

describe('ProfilePage — プロフィールカードの名前 (#1635)', () => {
  it.each(['Guest', ' Guest ', 'Guest\t'])(
    "プロフィールの名前が仮置き '%s' なら名前として出さず、メールアドレスの @ の前を出す",
    async (nickname) => {
      mockProfileResponse(nickname);
      mockCtxNickname = nickname;
      await renderLoaded();

      expect(screen.getByText('test')).toBeTruthy();
      expect(screen.queryByText(/Guest/)).toBeNull();
    },
  );

  it("API の名前が 'Guest' で ProfileProvider に名前があれば、そちらを出す", async () => {
    mockProfileResponse('Guest');
    mockCtxNickname = '  はなこ ';
    await renderLoaded();

    expect(screen.getByText('はなこ')).toBeTruthy();
    expect(screen.queryByText('test')).toBeNull();
  });

  it("名前もメールアドレスも無ければ 'ゲスト' (従来の文言)", async () => {
    mockProfileResponse('Guest');
    mockCtxNickname = 'Guest';
    mockAuthEmail = null;
    await renderLoaded();

    expect(screen.getByText('ゲスト')).toBeTruthy();
    expect(screen.queryByText(/Guest/)).toBeNull();
  });

  it.each(['guest', 'ゲスト', '太郎'])("'%s' は本人が付けた名前としてそのまま出す", async (nickname) => {
    mockProfileResponse(nickname);
    await renderLoaded();

    // プロフィールカードの名前と、基本タブのニックネームの 2 か所
    expect(screen.getAllByText(nickname)).toHaveLength(2);
    expect(screen.queryByText('test')).toBeNull();
  });

  it('本人が付けた名前は前後の空白を除いて出す', async () => {
    mockProfileResponse('  太郎 ');
    await renderLoaded();

    expect(screen.getAllByText('太郎')).toHaveLength(2);
  });

  it("基本タブのニックネームも、仮置きの 'Guest' なら「未設定」と出す", async () => {
    mockProfileResponse('Guest');
    mockCtxNickname = 'Guest';
    await renderLoaded();

    expect(screen.getByText('ニックネーム')).toBeTruthy();
    expect(screen.getAllByText('未設定').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Guest/)).toBeNull();
  });

  it("編集中の入力欄は保存される値をそのまま出す (仮置きの 'Guest' を空に変えない)", async () => {
    mockProfileResponse('Guest');
    await renderLoaded();

    fireEvent.press(screen.getByText('編集'));

    await waitFor(() => expect(screen.getByTestId('profile-nickname-input').props.value).toBe('Guest'));
  });
});
