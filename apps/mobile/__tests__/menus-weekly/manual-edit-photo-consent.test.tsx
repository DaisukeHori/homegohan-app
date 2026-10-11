/**
 * manual-edit-photo-consent.test.tsx
 * 手動編集 (ManualEditModal) の上に開く「写真から入力」(PhotoEditModal) の解析が、
 * 「同意が必要です」(403 AI_CONSENT_REQUIRED。T15 / #1154) で止められたとき
 *
 * 以前は、写真の画面が自分だけを閉じて案内を出していた。下の手動編集の画面 (モーダル) は開いたままなので、
 * 案内の「同意画面を開く」で移った同意画面が、手動編集の画面の下に隠れていた (R4 の指摘と同じ型: 1日献立のモーダルとシート)。
 * いまは次のとおり:
 *   - 写真の画面は自分を閉じ、手動編集の画面に知らせる (案内は自分で出さない)。「解析エラー」も出さない
 *   - 手動編集の画面は、案内の前には閉じない (編集中の内容を捨てない)。「閉じる」を選べば、そのまま編集を続けられる
 *   - 「同意画面を開く」を押したら、手動編集の画面を閉じてから同意画面へ移る
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: jest.fn(), post: mockPost, del: jest.fn(), patch: jest.fn() }),
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

import React from 'react';
import { router } from 'expo-router';
import { ManualEditModal, type ManualEditMeal } from '../../src/components/menu/ManualEditModal';
import { AI_CONSENT_SCREEN_PATH, resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';

// 最初の描画 (RN の Modal の初回描画) は読み込むモジュールが多く、キャッシュの無い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

// 非同期の段数が多く、遅い環境で既定の 1 秒では足りないことがあるため、長めに待つ
const WAIT = { timeout: 5000 };

const ANALYZE_PATH = '/api/ai/analyze-meal-photo';
const CONSENT_ERROR = () =>
  new Error(`HTTP 403 Forbidden: ${JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE })}`);

const MEAL: ManualEditMeal = {
  id: 'meal-1',
  dish_name: '焼き魚定食',
  mode: 'cook',
  calories_kcal: 600,
  dishes: [{ name: '焼き魚', role: 'main', calories_kcal: 300 }],
};

type AlertButton = { text?: string; style?: string; onPress?: () => void };

const alertMock = Alert.alert as jest.Mock;

function alertTitles(): string[] {
  return alertMock.mock.calls.map((call) => call[0] as string);
}

function consentButtons(): AlertButton[] {
  const call = alertMock.mock.calls.find((c) => c[0] === '同意が必要です');
  expect(call).toBeDefined();
  return call![2] as AlertButton[];
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsentPromptForTests();
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ base64: 'aGVsbG8=' }] });
});

/** 手動編集の画面を開き、「写真から入力」で写真を 1 枚選んで「解析」を押す */
async function analyzeFromManualEdit(onClose: () => void) {
  render(<ManualEditModal visible meal={MEAL} onClose={onClose} onSave={jest.fn()} />);
  fireEvent.press(screen.getByTestId('manual-edit-photo-btn'));
  expect(screen.getByTestId('photo-edit-modal')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByTestId('photo-edit-gallery-btn'));
  });
  await waitFor(() => expect(screen.getByTestId('photo-edit-remove-0')).toBeTruthy(), WAIT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('photo-edit-analyze-btn'));
  });
}

describe('手動編集の「写真から入力」が「同意が必要です」で止められたとき', () => {
  it('写真の画面は閉じ、案内を 1 回だけ出す。手動編集の画面は案内の前には閉じない (「解析エラー」も出さない)', async () => {
    mockPost.mockRejectedValue(CONSENT_ERROR());
    const onClose = jest.fn();
    await analyzeFromManualEdit(onClose);

    await waitFor(() => expect(alertTitles()).toEqual(['同意が必要です']), WAIT);
    expect(mockPost).toHaveBeenCalledWith(ANALYZE_PATH, expect.anything());
    expect(alertMock).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array));
    // 写真の画面は閉じた
    await waitFor(() => expect(screen.queryByTestId('photo-edit-modal')).toBeNull(), WAIT);
    // 手動編集の画面は開いたまま (編集中の内容を捨てない)
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('manual-edit-modal')).toBeTruthy();

    // 「閉じる」を選んだら、手動編集の画面はそのまま (同意画面へも移らない)
    const close = consentButtons().find((b) => b.text === '閉じる');
    expect(close?.style).toBe('cancel');
    close?.onPress?.();
    expect(onClose).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('「同意画面を開く」を押したら、手動編集の画面を閉じてから同意画面へ移る (同意画面が手動編集の画面の下に隠れない)', async () => {
    mockPost.mockRejectedValue(CONSENT_ERROR());
    const onClose = jest.fn();
    await analyzeFromManualEdit(onClose);
    await waitFor(() => expect(alertTitles()).toEqual(['同意が必要です']), WAIT);

    consentButtons()
      .find((b) => b.text === '同意画面を開く')
      ?.onPress?.();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan((router.push as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('同意以外の失敗は、これまでどおり「解析エラー」を出し、案内は出さない (上の検査の空振りでないことの確かめ)', async () => {
    mockPost.mockRejectedValue(new Error('HTTP 500 Internal Server Error'));
    const onClose = jest.fn();
    await analyzeFromManualEdit(onClose);

    await waitFor(() => expect(alertTitles()).toEqual(['解析エラー']), WAIT);
    expect(screen.getByTestId('photo-edit-modal')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
