/**
 * analyze-retry.test.tsx
 * 冷蔵庫の写真解析が失敗したときの「もう一度試す」のテスト (#1168)
 *
 * 失敗のアラートから、撮影し直さずに、同じ写真でもう一度解析できること。
 *  - 解析 (API) が失敗したら、アップロード済みの URL を使い回す (同じ写真を二重にアップロードしない)
 *  - アップロードが失敗したら、同じ写真 (ローカルの uri) でアップロードからやり直す
 *  - どちらも、写真の選択 (カメラ・ライブラリ) はやり直さない
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

const PHOTO_URI = 'file:///var/mobile/Containers/fridge.jpg';
const UPLOADED_URL = 'https://storage.example.com/fridge-images/user-1/1700000000000.jpg';
const OFFLINE_MESSAGE = '通信できません。インターネットへの接続を確認して、もう一度お試しください。';

const ANALYSIS_RESULT = {
  ingredients: ['トマト'],
  detailedIngredients: [
    { name: 'トマト', category: '野菜', quantity: '2個', freshness: 'fresh', daysRemaining: 3 },
  ],
  summary: 'トマトが写っています',
  suggestions: ['トマトサラダ'],
};

// 非同期の段数が多く、遅い環境 (CI の初回実行など) で既定の 1 秒では足りないことがあるため、長めに待つ
const WAIT = { timeout: 5000 };

type AlertButton = { text?: string; style?: string; onPress?: () => void };

const alertSpy = jest.spyOn(Alert, 'alert');

/** これまでに出た「解析失敗」のアラートのうち、最後のもの */
function lastFailureAlert(): { message: string; buttons: AlertButton[] } | undefined {
  const calls = alertSpy.mock.calls.filter((c) => c[0] === '解析失敗');
  const last = calls[calls.length - 1];
  return last ? { message: last[1] as string, buttons: (last[2] ?? []) as AlertButton[] } : undefined;
}

function failureAlertCount(): number {
  return alertSpy.mock.calls.filter((c) => c[0] === '解析失敗').length;
}

function buttonOf(text: string): AlertButton {
  const button = lastFailureAlert()?.buttons.find((b) => b.text === text);
  if (!button) throw new Error(`「${text}」ボタンのあるアラートが出ていません`);
  return button;
}

/** 「写真を選ぶ」を押して、ライブラリから写真を選ぶところまで進める */
async function pickPhotoFromLibrary() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('pantry-fridge-photo-button'));
  });
}

beforeEach(() => {
  jest.clearAllMocks();

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

describe('PantryPage — 解析失敗の「もう一度試す」', () => {
  it('解析 (API) が失敗したら「もう一度試す」付きのアラートが出て、押すと撮り直さず同じ写真で解析し直す', async () => {
    mockPost.mockRejectedValueOnce(new Error(OFFLINE_MESSAGE)).mockResolvedValueOnce(ANALYSIS_RESULT);

    render(<PantryPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled(), WAIT);
    await pickPhotoFromLibrary();

    await waitFor(() => expect(failureAlertCount()).toBe(1), WAIT);
    const failure = lastFailureAlert()!;
    // 通信できないときは、その文面がそのまま出る
    expect(failure.message).toBe(OFFLINE_MESSAGE);
    expect(failure.buttons.map((b) => b.text)).toEqual(['閉じる', 'もう一度試す']);
    expect(buttonOf('閉じる').style).toBe('cancel');
    // 失敗した時点では、まだ 1 回しか解析していない
    expect(mockPost).toHaveBeenCalledTimes(1);

    await act(async () => {
      buttonOf('もう一度試す').onPress?.();
    });

    // 同じ写真 (同じ URL) をもう一度解析する
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2), WAIT);
    expect(mockPost).toHaveBeenNthCalledWith(1, '/api/ai/analyze-fridge', { imageUrl: UPLOADED_URL });
    expect(mockPost).toHaveBeenNthCalledWith(2, '/api/ai/analyze-fridge', { imageUrl: UPLOADED_URL });
    // 撮り直し (写真の選択) も、同じ写真の再アップロードもしない
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    expect(mockUploadFridgePhoto).toHaveBeenCalledTimes(1);
    expect(mockUploadFridgePhoto).toHaveBeenCalledWith(PHOTO_URI, 'user-1');

    // 2 回目で成功したので、結果が表示され、新しい失敗のアラートは出ない
    await waitFor(() => expect(screen.getByText('トマトが写っています')).toBeTruthy(), WAIT);
    expect(screen.getByText('トマト')).toBeTruthy();
    expect(failureAlertCount()).toBe(1);
  });

  it('続けて失敗しても、そのたびに「もう一度試す」が出て、アップロード済みの URL を使い回す', async () => {
    mockPost
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable: {}'))
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable: {}'))
      .mockResolvedValueOnce(ANALYSIS_RESULT);

    render(<PantryPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled(), WAIT);
    await pickPhotoFromLibrary();

    await waitFor(() => expect(failureAlertCount()).toBe(1), WAIT);
    await act(async () => {
      buttonOf('もう一度試す').onPress?.();
    });
    await waitFor(() => expect(failureAlertCount()).toBe(2), WAIT);
    await act(async () => {
      buttonOf('もう一度試す').onPress?.();
    });

    await waitFor(() => expect(screen.getByText('トマトが写っています')).toBeTruthy(), WAIT);
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(mockUploadFridgePhoto).toHaveBeenCalledTimes(1);
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
  });

  it('アップロードが失敗したときは、同じ写真 (ローカルの uri) でアップロードからやり直す', async () => {
    mockUploadFridgePhoto
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(UPLOADED_URL);
    mockPost.mockResolvedValueOnce(ANALYSIS_RESULT);

    render(<PantryPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled(), WAIT);
    await pickPhotoFromLibrary();

    await waitFor(() => expect(failureAlertCount()).toBe(1), WAIT);
    expect(lastFailureAlert()!.message).toBe('Network request failed');
    // アップロードで止まったので、解析にはまだ進んでいない
    expect(mockPost).not.toHaveBeenCalled();

    await act(async () => {
      buttonOf('もう一度試す').onPress?.();
    });

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1), WAIT);
    expect(mockUploadFridgePhoto).toHaveBeenCalledTimes(2);
    expect(mockUploadFridgePhoto).toHaveBeenNthCalledWith(2, PHOTO_URI, 'user-1');
    expect(mockPost).toHaveBeenCalledWith('/api/ai/analyze-fridge', { imageUrl: UPLOADED_URL });
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('トマトが写っています')).toBeTruthy(), WAIT);
  });

  it('「閉じる」を押しても、解析をやり直さない', async () => {
    mockPost.mockRejectedValueOnce(new Error(OFFLINE_MESSAGE));

    render(<PantryPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled(), WAIT);
    await pickPhotoFromLibrary();

    await waitFor(() => expect(failureAlertCount()).toBe(1), WAIT);
    await act(async () => {
      buttonOf('閉じる').onPress?.();
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockUploadFridgePhoto).toHaveBeenCalledTimes(1);
    expect(failureAlertCount()).toBe(1);
  });

  it('失敗したあとも、選んだ写真のプレビューは残り、「写真を選ぶ」から別の写真を選び直せる', async () => {
    mockPost.mockRejectedValueOnce(new Error(OFFLINE_MESSAGE)).mockResolvedValueOnce(ANALYSIS_RESULT);

    render(<PantryPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled(), WAIT);
    await pickPhotoFromLibrary();
    await waitFor(() => expect(failureAlertCount()).toBe(1), WAIT);

    expect(screen.getByLabelText('選択した冷蔵庫の写真')).toBeTruthy();
    // 解析中の表示は終わっている (ボタンが押せる)
    expect(screen.getByText('写真を選ぶ')).toBeTruthy();

    // アラートを閉じて、自分で別の写真を選び直す: 写真の選択からやり直す
    await pickPhotoFromLibrary();
    await waitFor(() => expect(screen.getByText('トマトが写っています')).toBeTruthy(), WAIT);
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(2);
    expect(mockUploadFridgePhoto).toHaveBeenCalledTimes(2);
  });

  it('カメラで撮った写真でも、失敗したら撮り直さずに同じ写真で解析し直す', async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: PHOTO_URI }],
    });
    alertSpy.mockImplementation((title, _message, buttons) => {
      if (title === '写真の選択') {
        (buttons as AlertButton[]).find((b) => b.text === 'カメラで撮影')?.onPress?.();
      }
    });
    mockPost.mockRejectedValueOnce(new Error(OFFLINE_MESSAGE)).mockResolvedValueOnce(ANALYSIS_RESULT);

    render(<PantryPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled(), WAIT);
    await pickPhotoFromLibrary();
    await waitFor(() => expect(failureAlertCount()).toBe(1), WAIT);

    await act(async () => {
      buttonOf('もう一度試す').onPress?.();
    });

    await waitFor(() => expect(screen.getByText('トマトが写っています')).toBeTruthy(), WAIT);
    expect(ImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);
    expect(ImagePicker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockUploadFridgePhoto).toHaveBeenCalledTimes(1);
  });
});
