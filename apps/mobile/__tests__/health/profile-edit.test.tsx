/**
 * profile-edit.test.tsx
 * RNTL tests for apps/mobile/app/profile/index.tsx
 *
 * Covers:
 *  1. プロフィール読み込み後に「編集」ボタンが表示される
 *  2. 「編集」を押すとニックネームフィールドが TextInput に切り替わる
 *  3. ニックネームを変更して「保存」を押すと /api/profile に PATCH が呼ばれる
 *  4. 保存成功後に isEditing が false に戻り、更新後の値が表示される
 *  5. 保存失敗時に Alert(更新失敗) が表示される
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

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

// AuthProvider mock
jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'uid-1', email: 'test@example.com' },
  }),
}));

// ProfileProvider mock
const mockRefreshProfile = jest.fn();
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({
    profile: { nickname: 'テストユーザー' },
    refresh: mockRefreshProfile,
  }),
}));

// expo-router mock
jest.mock('expo-router', () => ({
  router: { replace: jest.fn() },
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

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const MOCK_PROFILE = {
  nickname: 'テストユーザー',
  age: 30,
  gender: 'male',
  height: 175,
  weight: 70,
  occupation: 'エンジニア',
  fitnessGoals: ['lose_weight'],
  healthConditions: [],
  dietStyle: null,
  kitchenAppliances: [],
  mealPrepOk: true,
  weekendCookingMinutes: null,
  weeklyFoodBudget: null,
  hobbies: [],
  performanceProfile: null,
  primarySport: null,
  exerciseFrequency: null,
  exerciseIntensity: null,
  goalText: null,
  targetDate: null,
  targetWeight: null,
  sleepQuality: null,
  stressLevel: null,
  coldSensitivity: false,
  swellingProne: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  alertSpy.mockClear();
  mockRefreshProfile.mockResolvedValue(undefined);

  // デフォルト: プロフィール取得成功
  mockGet
    .mockResolvedValueOnce(MOCK_PROFILE)                        // /api/profile
    .mockResolvedValueOnce({ badges: [] })                      // /api/badges
    .mockResolvedValueOnce({                                     // /api/notification-preferences
      settings: { notifications_enabled: true, auto_analyze_enabled: true },
    });
});

describe('ProfilePage — 編集', () => {
  it('1. プロフィール読み込み後に「編集」ボタンが表示される', async () => {
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.queryByTestId('loading')).toBeNull();
    });

    expect(screen.getByText('編集')).toBeTruthy();
  });

  it('2. 「編集」を押すとニックネームフィールドが入力可能になる', async () => {
    render(<ProfilePage />);
    await waitFor(() => expect(screen.queryByTestId('loading')).toBeNull());

    fireEvent.press(screen.getByText('編集'));

    // ニックネームの TextInput が表示される
    await waitFor(() => {
      // 編集モードでは TextInput の value がニックネーム値になる
      const inputs = screen.getAllByDisplayValue('テストユーザー');
      expect(inputs.length).toBeGreaterThan(0);
    });
  });

  it('3. ニックネームを変更して「保存」を押すと /api/profile に PATCH が呼ばれる', async () => {
    const updatedProfile = { ...MOCK_PROFILE, nickname: '新しい名前' };
    mockPatch.mockResolvedValueOnce(updatedProfile);

    render(<ProfilePage />);
    await waitFor(() => expect(screen.queryByTestId('loading')).toBeNull());

    // 編集モードへ
    fireEvent.press(screen.getByText('編集'));

    await waitFor(() => {
      const inputs = screen.getAllByDisplayValue('テストユーザー');
      expect(inputs.length).toBeGreaterThan(0);
    });

    // ニックネームを変更
    const nicknameInput = screen.getAllByDisplayValue('テストユーザー')[0];
    fireEvent.changeText(nicknameInput, '新しい名前');

    // 保存
    await act(async () => {
      fireEvent.press(screen.getByText('保存'));
    });

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        '/api/profile',
        expect.objectContaining({ nickname: '新しい名前' }),
      );
    });
  });

  it('4. 保存成功後に refreshProfile が呼ばれ、編集モードが終了する', async () => {
    const updatedProfile = { ...MOCK_PROFILE, nickname: '更新後の名前' };
    mockPatch.mockResolvedValueOnce(updatedProfile);

    render(<ProfilePage />);
    await waitFor(() => expect(screen.queryByTestId('loading')).toBeNull());

    fireEvent.press(screen.getByText('編集'));
    await waitFor(() => expect(screen.getAllByDisplayValue('テストユーザー').length).toBeGreaterThan(0));

    await act(async () => {
      fireEvent.press(screen.getByText('保存'));
    });

    await waitFor(() => {
      expect(mockRefreshProfile).toHaveBeenCalled();
      // 編集モード終了後は「編集」ボタンが戻る
      expect(screen.getByText('編集')).toBeTruthy();
    });
  });

  it('5. PATCH が失敗した場合に Alert(更新失敗) が表示される', async () => {
    mockPatch.mockRejectedValueOnce(new Error('通信エラー'));

    render(<ProfilePage />);
    await waitFor(() => expect(screen.queryByTestId('loading')).toBeNull());

    fireEvent.press(screen.getByText('編集'));

    await act(async () => {
      fireEvent.press(screen.getByText('保存'));
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('更新失敗', expect.stringContaining('通信エラー'));
    });
  });
});
