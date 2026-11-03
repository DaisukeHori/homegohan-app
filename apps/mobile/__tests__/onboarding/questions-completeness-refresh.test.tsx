/**
 * #2206 G4 モバイルのオンボーディングの途中保存のあとに、プロフィールの完成度をサーバーで計算し直す
 *
 * 問題 (直す前):
 *   モバイルの途中保存 (app/onboarding/questions.tsx の saveProgress) は答えを user_profiles に直接 upsert するだけで、
 *   完成度 (profile_completeness) を計算し直さなかった。Web の途中保存 (POST /api/onboarding/progress) は計算し直すので、
 *   途中でやめた利用者の完成度がモバイルだけ古いまま (0 のまま) 残った。
 *
 * 直したあと (このテストが固定する):
 *   - 途中保存の upsert が成功したら、POST /api/profile/completeness を呼ぶ (upsert のあと)
 *   - upsert が失敗したら呼ばない (書けていない行から計算し直さない)
 *   - 計算し直しが失敗しても画面に Alert は出さない (答えの保存は済んでいる。ログに残すだけ)
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ resume: 'true' }),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: mockPost }),
}));

/** 呼ばれた順 (upsert と API の前後を見る) */
const mockCallOrder: string[] = [];
const mockGetUser = jest.fn();
const mockUpsert = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { onboarding_started_at: '2026-11-01T00:00:00.000Z' }, error: null }) }) }),
      upsert: (...args: unknown[]) => {
        mockCallOrder.push('upsert');
        return mockUpsert(...args);
      },
    }),
  },
}));

/** 調理器具の質問 (QUESTIONS の 31 個目。スキップでき、次の質問 (コンロ) がある) の番号 */
const KITCHEN_APPLIANCES_STEP = 30;
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({
    profile: { onboardingProgress: { currentStep: 30, answers: { nickname: 'ほり' } } },
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock('../../src/components/ui', () => {
  const { Text, View } = require('react-native');
  return {
    Card: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
    LoadingState: ({ message }: { message?: string }) => <Text>{message ?? 'loading'}</Text>,
  };
});

import OnboardingQuestions from '../../app/onboarding/questions';

/** 完成度を計算し直す API (src/app/api/profile/completeness/route.ts) */
const PROFILE_COMPLETENESS_REFRESH_PATH = '/api/profile/completeness';

let alertSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockCallOrder.length = 0;
  mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-2206' } } });
  mockUpsert.mockResolvedValue({ error: null });
  mockPost.mockImplementation(async (path: string) => {
    mockCallOrder.push(`post ${path}`);
    return { profileCompleteness: 8 };
  });
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  alertSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

async function skipKitchenAppliances() {
  render(<OnboardingQuestions />);
  await waitFor(() => expect(screen.getByText(/お持ちの調理器具は/)).toBeTruthy());
  expect(KITCHEN_APPLIANCES_STEP).toBe(30);
  await act(async () => {
    fireEvent.press(screen.getByTestId('onboarding-skip-question-button'));
  });
  // 次の質問 (コンロ) へ進む
  await waitFor(() => expect(screen.getByText(/お使いのコンロは/)).toBeTruthy());
}

describe('途中保存のあとに完成度を計算し直す (#2206 G4)', () => {
  it('upsert が成功したら、そのあとに POST /api/profile/completeness を呼ぶ', async () => {
    await skipKitchenAppliances();

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(PROFILE_COMPLETENESS_REFRESH_PATH));
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0]).toMatchObject({ id: 'uid-2206', nickname: 'ほり' });
    expect(mockCallOrder).toEqual(['upsert', `post ${PROFILE_COMPLETENESS_REFRESH_PATH}`]);
  });

  it('upsert が失敗したら計算し直さない (書けていない行から数えない)', async () => {
    const dbError = { message: 'db error', code: 'XX000' };
    mockUpsert.mockResolvedValueOnce({ error: dbError });

    await skipKitchenAppliances();

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to save progress:', dbError));
    expect(mockPost).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('計算し直しが失敗しても Alert は出さず、ログに残すだけ (答えの保存は済んでいる)', async () => {
    const apiError = new Error('HTTP 500 Internal Server Error: {"error":"処理中にエラーが発生しました"}');
    mockPost.mockRejectedValueOnce(apiError);

    await skipKitchenAppliances();

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to save progress:', apiError));
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
