/**
 * api-error-alert-japanese.test.tsx
 * 利用者向けの API (栄養目標の計算・初期設定の完了・栄養目標の保存) が失敗したとき、
 * モバイルの画面の Alert に `HTTP 404 Not Found: {"error":"…"}` のような英語の状態の行と生の JSON を出さず、
 * 本文の日本語の文だけを出す (#1917)。
 *
 * 対象の画面 (getApi() で呼び、catch で Alert に文を出す):
 *   - app/profile/nutrition-targets.tsx  … POST /api/nutrition-targets/calculate (再計算)
 *   - app/onboarding/questions.tsx       … POST /api/onboarding/complete (最後の質問の後の保存)
 *   - app/onboarding/complete/index.tsx  … POST /api/nutrition-targets/calculate / PUT /api/nutrition/targets (保存)
 *
 * getApi() (@homegohan/core の createHttpClient) は HTTP の失敗を
 *   new Error(`HTTP ${status} ${statusText}: ${JSON.stringify(本文)}`)
 * の形で投げる (packages/core/src/api/httpClient.ts の toHttpError)。下の httpErrorOf はそれと同じ形の Error を作る。
 */

import React from 'react';
import { Alert, Switch } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// ---- Mocks ----

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

const mockPost = jest.fn();
const mockPut = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: mockPost, put: mockPut }),
}));

const mockGetUser = jest.fn();
const mockMaybeSingle = jest.fn();
const mockUpsert = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args) }) }),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    }),
  },
}));

let mockProfile: unknown = null;
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ profile: mockProfile, isLoading: false, refresh: jest.fn() }),
}));

jest.mock('../../src/components/ui', () => {
  const { Text, View } = require('react-native');
  return {
    Card: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
    SectionHeader: ({ title }: { title?: string }) => <Text>{title}</Text>,
    PageHeader: ({ title }: { title?: string }) => <Text>{title}</Text>,
    LoadingState: ({ message }: { message?: string }) => <Text>{message ?? 'loading'}</Text>,
    Button: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
  };
});

import NutritionTargetsScreen from '../../app/profile/nutrition-targets';
import OnboardingQuestions from '../../app/onboarding/questions';
import OnboardingComplete from '../../app/onboarding/complete/index';

// ---- Helpers ----

/** getApi() が HTTP の失敗で投げる Error と同じ形 (packages/core/src/api/httpClient.ts の toHttpError) */
function httpErrorOf(status: number, statusText: string, body: unknown): Error {
  return new Error(`HTTP ${status} ${statusText}: ${JSON.stringify(body)}`);
}

/** route が返す日本語の文 (src/app/api/nutrition-targets/calculate/route.ts・src/lib/api/error-responses.ts) */
const PROFILE_NOT_FOUND_BODY_MESSAGE = 'プロフィールが見つかりません。先にプロフィールを登録してください';
const UNAUTHENTICATED_BODY_MESSAGE = 'ログインが必要です';
const INTERNAL_ERROR_BODY_MESSAGE = '処理中にエラーが発生しました';

/** Alert に出た本文 (2 つ目の引数) を集める */
function alertMessages(alertSpy: jest.SpyInstance): string[] {
  return alertSpy.mock.calls.map((call) => String(call[1]));
}

/** 生の HTTP の行や JSON が入っていないこと */
function expectNoRawHttpText(message: string) {
  expect(message).not.toMatch(/HTTP/);
  expect(message).not.toContain('{');
  expect(message).not.toMatch(/Not Found|Unauthorized|Internal Server Error/);
}

let alertSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockProfile = null;
  mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1917' } } });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockUpsert.mockResolvedValue({ error: null });
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  alertSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ---- 栄養目標の画面 (再計算) ----

describe('栄養目標の画面: 再計算の失敗 (#1917)', () => {
  it.each([
    [404, 'Not Found', { error: PROFILE_NOT_FOUND_BODY_MESSAGE }, PROFILE_NOT_FOUND_BODY_MESSAGE],
    [401, 'Unauthorized', { error: UNAUTHENTICATED_BODY_MESSAGE }, UNAUTHENTICATED_BODY_MESSAGE],
  ])('HTTP %i の失敗は本文の日本語の文だけを出す', async (status, statusText, body, expected) => {
    // 目標がまだ無いので、開いた時に再計算を呼ぶ (load → recalculate)
    mockPost.mockRejectedValueOnce(httpErrorOf(status, statusText, body));

    render(<NutritionTargetsScreen />);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith('/api/nutrition-targets/calculate', {});
    const [message] = alertMessages(alertSpy);
    expect(message).toBe(expected);
    expectNoRawHttpText(message);
  });

  it('HTTP 500 (src/lib/api/errors.ts の internalError の flat の本文) も本文の日本語の文だけを出す', async () => {
    mockPost.mockRejectedValueOnce(
      httpErrorOf(500, 'Internal Server Error', { error: INTERNAL_ERROR_BODY_MESSAGE, code: 'INTERNAL_ERROR' }),
    );

    render(<NutritionTargetsScreen />);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [message] = alertMessages(alertSpy);
    expect(message).toBe(INTERNAL_ERROR_BODY_MESSAGE);
    expectNoRawHttpText(message);
  });
});

// ---- 初期設定の最後の質問の後の保存 ----

/** questions.tsx の最後の質問 (hobbies。QUESTIONS の 33 個目) の番号 */
const LAST_QUESTION_STEP = 32;

async function renderQuestionsAtLastStep() {
  mockParams = { resume: 'true' };
  mockProfile = { onboardingProgress: { currentStep: LAST_QUESTION_STEP, answers: {} } };
  render(<OnboardingQuestions />);
  // 最後の質問 (趣味) が出ていること (QUESTIONS の並びが変わったらここで気づく)
  await waitFor(() => expect(screen.getByText(/趣味を教えてください/)).toBeTruthy());
}

describe('初期設定の質問の画面: 完了の保存の失敗 (#1917)', () => {
  it('POST /api/onboarding/complete の 401 は本文の日本語の文だけを出す', async () => {
    mockPost.mockRejectedValueOnce(httpErrorOf(401, 'Unauthorized', { error: UNAUTHENTICATED_BODY_MESSAGE }));
    await renderQuestionsAtLastStep();

    await act(async () => {
      fireEvent.press(screen.getByTestId('onboarding-skip-question-button'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith('/api/onboarding/complete');
    const [message] = alertMessages(alertSpy);
    expect(message).toBe(UNAUTHENTICATED_BODY_MESSAGE);
    expectNoRawHttpText(message);
  });

  it("ログインが切れていたときは英語の 'Unauthorized' を出さず日本語の文を出す", async () => {
    await renderQuestionsAtLastStep();
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });

    await act(async () => {
      fireEvent.press(screen.getByTestId('onboarding-skip-question-button'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [message] = alertMessages(alertSpy);
    expect(message).toBe('ログインが必要です。もう一度ログインしてください。');
    expect(message).not.toMatch(/Unauthorized/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('プロフィールの保存 (DB) の失敗は、DB の生の文面を出さず固定の文を出し、生の文面はログにだけ残す', async () => {
    const dbError = { message: 'new row violates row-level security policy for table "user_profiles"', code: '42501' };
    mockUpsert.mockResolvedValueOnce({ error: dbError });
    await renderQuestionsAtLastStep();

    await act(async () => {
      fireEvent.press(screen.getByTestId('onboarding-skip-question-button'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [message] = alertMessages(alertSpy);
    expect(message).toBe('保存に失敗しました。');
    expect(message).not.toMatch(/row-level security/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), dbError);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// ---- 初期設定の完了の画面 (栄養目標の保存) ----

const STORED_TARGETS = {
  daily_calories: 2000,
  protein_g: 100,
  fat_g: 60,
  carbs_g: 250,
  fiber_g: 20,
  sodium_g: 7,
  sugar_g: 25,
  auto_calculate: true,
  calculation_basis: null,
  last_calculated_at: null,
};

describe('初期設定の完了の画面: 栄養目標の保存の失敗 (#1917)', () => {
  it.each([
    [404, 'Not Found', { error: PROFILE_NOT_FOUND_BODY_MESSAGE }, PROFILE_NOT_FOUND_BODY_MESSAGE],
    [401, 'Unauthorized', { error: UNAUTHENTICATED_BODY_MESSAGE }, UNAUTHENTICATED_BODY_MESSAGE],
  ])('自動計算で保存の HTTP %i の失敗は本文の日本語の文だけを出す', async (status, statusText, body, expected) => {
    mockMaybeSingle.mockResolvedValue({ data: STORED_TARGETS, error: null });
    mockPost.mockRejectedValueOnce(httpErrorOf(status, statusText, body));

    render(<OnboardingComplete />);
    const saveButton = await screen.findByText('自動計算で保存');

    await act(async () => {
      fireEvent.press(saveButton);
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith('/api/nutrition-targets/calculate', {});
    const [message] = alertMessages(alertSpy);
    expect(message).toBe(expected);
    expectNoRawHttpText(message);
  });

  it('手動で保存 (PUT /api/nutrition/targets) の HTTP 401 の失敗も本文の日本語の文だけを出す', async () => {
    mockMaybeSingle.mockResolvedValue({ data: STORED_TARGETS, error: null });
    mockPut.mockRejectedValueOnce(httpErrorOf(401, 'Unauthorized', { error: UNAUTHENTICATED_BODY_MESSAGE }));

    render(<OnboardingComplete />);
    await screen.findByText('自動計算で保存');
    // 「自動計算を使う」を切ると、保存は PUT /api/nutrition/targets になる
    await act(async () => {
      fireEvent(screen.UNSAFE_getByType(Switch), 'valueChange', false);
    });
    const saveButton = await screen.findByText('この設定で保存');

    await act(async () => {
      fireEvent.press(saveButton);
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockPut).toHaveBeenCalledWith('/api/nutrition/targets', expect.objectContaining({ autoCalculate: false }));
    expect(mockPost).not.toHaveBeenCalled();
    const [message] = alertMessages(alertSpy);
    expect(message).toBe(UNAUTHENTICATED_BODY_MESSAGE);
    expectNoRawHttpText(message);
  });
});
