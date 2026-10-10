/**
 * new-consent.test.tsx
 * 食事の新規作成 (meals/new) で、写真の解析が「同意が必要です」(403 AI_CONSENT_REQUIRED。T15 / #1154) で止められたとき
 *
 * この画面はルートの Stack で presentation: "modal" として開く (app/_layout.tsx)。iOS のネイティブのスタックは、
 * modal の画面のあとに push した画面を modal の下に入れるので、ここから同意画面へ移ると、同意画面がこの画面の下に隠れる
 * (R5 の指摘。R4 の「シート・モーダルの下に隠れる」と同じ型)。5 つの解析の経路 (オートの判別・食事・冷蔵庫・健診・体重計) とも:
 *   - 「解析失敗」「判別失敗」は出さず、「同意が必要です」の案内を 1 回だけ出して、撮影の画面へ戻す
 *   - 「閉じる」なら、この画面を閉じず、同意画面へも移らない
 *   - 「同意画面を開く」なら、この画面を閉じて (router.back) から同意画面へ移る (router.push)
 * この画面がもう一番上でない (案内が出る前に利用者が閉じた) ときと、戻る先が無い (スタックの先頭) ときは、閉じずに移る
 * (router.back が別の画面を閉じないように)。
 * modal で開く画面の案内がこの形であることは、tests/ai-consent-mobile-modal-nesting.test.ts が構文木でも検査する。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockIsFocused = jest.fn(() => true);

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
  useNavigation: jest.fn(() => ({ isFocused: () => mockIsFocused() })),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: false, assets: [{ uri: 'file://test/photo.jpg' }] }),
  launchCameraAsync: jest.fn().mockResolvedValue({ canceled: false, assets: [{ uri: 'file://test/camera.jpg' }] }),
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ uri: 'file://test/resized.jpg', base64: 'base64encodedimage' }),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost, del: jest.fn(), patch: jest.fn() }),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) }, from: jest.fn() },
}));

import { router } from 'expo-router';
import MealNewPage from '../../app/meals/new';
import { AI_CONSENT_SCREEN_PATH, resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';

// 最初の描画は読み込むモジュールが多く、キャッシュの無い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

// 非同期の段数が多く、遅い環境で既定の 1 秒では足りないことがあるため、長めに待つ
const WAIT = { timeout: 5000 };

/** 撮影の種類 (モード選択のボタン) → 写真を送って止められる API */
const ANALYZE_PATHS = {
  auto: '/api/ai/classify-photo',
  meal: '/api/ai/analyze-meal-photo',
  fridge: '/api/ai/analyze-fridge',
  health_checkup: '/api/ai/analyze-health-checkup',
  weight_scale: '/api/ai/analyze-weight-scale',
} as const;
type Mode = keyof typeof ANALYZE_PATHS;
const MODES = Object.keys(ANALYZE_PATHS) as Mode[];

const CONSENT_ERROR = () =>
  new Error(`HTTP 403 Forbidden: ${JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE })}`);

type AlertButton = { text?: string; style?: string; onPress?: () => void };

const alertMock = Alert.alert as jest.Mock;
const backMock = router.back as jest.Mock;
const pushMock = router.push as jest.Mock;
const canGoBackMock = router.canGoBack as jest.Mock;

function alertTitles(): string[] {
  return alertMock.mock.calls.map((call) => call[0] as string);
}

function consentButton(text: string): AlertButton | undefined {
  const call = alertMock.mock.calls.find((c) => c[0] === '同意が必要です');
  expect(call).toBeDefined();
  return (call![2] as AlertButton[]).find((b) => b.text === text);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsentPromptForTests();
  mockIsFocused.mockReturnValue(true);
  canGoBackMock.mockReturnValue(true);
  mockGet.mockResolvedValue({ products: [] });
});

/** 撮影の種類を選び、写真を 1 枚選んで解析を押す。解析の API は「同意が必要です」で止める */
async function analyzeAndStopAtConsent(mode: Mode) {
  mockPost.mockImplementation(async (path: string) => {
    if (path === ANALYZE_PATHS[mode]) throw CONSENT_ERROR();
    throw new Error(`unexpected POST ${path}`);
  });
  render(<MealNewPage />);
  fireEvent.press(screen.getByTestId(`meal-mode-${mode.replace(/_/g, '-')}`));
  fireEvent.press(screen.getByText('撮影へ進む'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('camera-gallery-button'));
  });
  await waitFor(() => expect(screen.getByText('選択した写真 (1枚)')).toBeTruthy(), WAIT);

  await act(async () => {
    fireEvent.press(screen.getByText(mode === 'auto' ? 'AIが判別して解析' : 'AIで解析する'));
  });
  await waitFor(() => expect(alertTitles()).toEqual(['同意が必要です']), WAIT);
  expect(mockPost).toHaveBeenCalledWith(ANALYZE_PATHS[mode], expect.any(Object));
  expect(alertMock).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array));
  // 撮影の画面へ戻っている (解析中のまま止まらない)
  expect(screen.getByTestId('camera-screen')).toBeTruthy();
  // 案内を出しただけでは、まだ閉じない・移らない
  expect(backMock).not.toHaveBeenCalled();
  expect(pushMock).not.toHaveBeenCalled();
}

describe('食事の新規作成 (modal で開く画面) の写真の解析が「同意が必要です」で止められたとき', () => {
  it.each(MODES)('%s: 「同意画面を開く」を押したら、この画面を閉じてから同意画面へ移る (同意画面が modal の下に隠れない)', async (mode) => {
    await analyzeAndStopAtConsent(mode);

    await act(async () => {
      consentButton('同意画面を開く')?.onPress?.();
    });

    expect(backMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
    // 閉じてから移る (移ってから閉じると、移った同意画面が modal の下に入る)
    expect(backMock.mock.invocationCallOrder[0]).toBeLessThan(pushMock.mock.invocationCallOrder[0]);
  });

  it.each(MODES)('%s: 「閉じる」なら、この画面を閉じず、同意画面へも移らない', async (mode) => {
    await analyzeAndStopAtConsent(mode);

    const close = consentButton('閉じる');
    expect(close?.style).toBe('cancel');
    await act(async () => {
      close?.onPress?.();
    });

    expect(backMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('camera-screen')).toBeTruthy();
  });

  it('この画面がもう一番上でない (案内が出る前に利用者が閉じた) ときは、閉じずに同意画面へ移る (別の画面を閉じない)', async () => {
    await analyzeAndStopAtConsent('meal');
    mockIsFocused.mockReturnValue(false);

    await act(async () => {
      consentButton('同意画面を開く')?.onPress?.();
    });

    expect(backMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
  });

  it('戻る先が無い (この画面がスタックの先頭で、push として積まれている) ときは、閉じずに同意画面へ移る', async () => {
    await analyzeAndStopAtConsent('fridge');
    canGoBackMock.mockReturnValue(false);

    await act(async () => {
      consentButton('同意画面を開く')?.onPress?.();
    });

    expect(backMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
  });
});
