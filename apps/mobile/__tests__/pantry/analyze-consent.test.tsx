/**
 * analyze-consent.test.tsx
 * 冷蔵庫の写真の解析が「同意が必要です」(403 AI_CONSENT_REQUIRED) で止められたとき (T15 / #1154)
 *
 *  - 「解析失敗」のアラート (と「もう一度試す」) は出さず、「同意が必要です」の案内 (同意画面を開く) を出す
 *  - ほかの 403 (同意と関係ない) は、従来どおり「解析失敗」を出す
 * 画面の判定の有無は tests/ai-consent-mobile-entry-points.test.ts が全画面で検査する。ここは代表の挙動を確かめる。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

// --- モック設定 ---
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDel = jest.fn();
const mockGetUser = jest.fn();
const mockUploadFridgePhoto = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
  }),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getUser: (...args: unknown[]) => mockGetUser(...args) } },
}));

jest.mock('../../src/lib/storage', () => ({
  uploadFridgePhoto: (...args: unknown[]) => mockUploadFridgePhoto(...args),
}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import React from 'react';
import PantryPage from '../../app/pantry/index';
import { router } from 'expo-router';
import { resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';

const PHOTO_URI = 'file:///var/mobile/Containers/fridge.jpg';
const UPLOADED_URL = 'https://storage.example.com/fridge-images/user-1/1700000000000.jpg';

// 非同期の段数が多く、遅い環境 (CI の初回実行など) で既定の 1 秒では足りないことがあるため、長めに待つ
const WAIT = { timeout: 5000 };

type AlertButton = { text?: string; style?: string; onPress?: () => void };

const alertSpy = jest.spyOn(Alert, 'alert');

function failureAlertCount(): number {
  return alertSpy.mock.calls.filter((c) => c[0] === '解析失敗').length;
}

/** 「写真を選ぶ」を押して、ライブラリから写真を選ぶところまで進める */
async function pickPhotoFromLibrary() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('pantry-fridge-photo-button'));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsentPromptForTests();

  mockGet.mockResolvedValue({ items: [] });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  mockUploadFridgePhoto.mockResolvedValue(UPLOADED_URL);

  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [{ uri: PHOTO_URI }],
  });

  // 「写真の選択」では、いつもライブラリを選ぶ。それ以外のアラート (解析失敗など) は、呼び出しだけを記録する
  alertSpy.mockImplementation((title, _message, buttons) => {
    if (title === '写真の選択') {
      (buttons as AlertButton[]).find((b) => b.text === 'ライブラリから選択')?.onPress?.();
    }
  });
});

const CONSENT_ERROR = new Error(
  `HTTP 403 Forbidden: ${JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE })}`,
);

function consentAlerts() {
  return alertSpy.mock.calls.filter((c) => c[0] === '同意が必要です');
}

describe('PantryPage — 解析が「同意が必要です」で止められたとき', () => {
  it('「解析失敗」を出さず、同意画面への案内を出す。「同意画面を開く」で同意画面へ移る', async () => {
    mockPost.mockRejectedValueOnce(CONSENT_ERROR);

    render(<PantryPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled(), WAIT);
    await pickPhotoFromLibrary();

    await waitFor(() => expect(consentAlerts()).toHaveLength(1), WAIT);
    expect(mockPost).toHaveBeenCalledWith('/api/ai/analyze-fridge', { imageUrl: UPLOADED_URL });
    expect(failureAlertCount()).toBe(0);
    const [, message, buttons] = consentAlerts()[0];
    expect(message).toBe(AI_CONSENT_REQUIRED_MESSAGE);
    const open = (buttons as AlertButton[]).find((b) => b.text === '同意画面を開く');
    expect(open).toBeDefined();
    open?.onPress?.();
    expect(router.push).toHaveBeenCalledWith('/settings/ai-consent');
    // 解析は 1 回だけ (勝手にやり直さない)
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('同意と関係ない 403 は、従来どおり「解析失敗」を出す (案内は出さない)', async () => {
    mockPost.mockRejectedValueOnce(new Error('HTTP 403 Forbidden: {"error":"Forbidden"}'));

    render(<PantryPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled(), WAIT);
    await pickPhotoFromLibrary();

    await waitFor(() => expect(failureAlertCount()).toBe(1), WAIT);
    expect(consentAlerts()).toHaveLength(0);
  });
});
