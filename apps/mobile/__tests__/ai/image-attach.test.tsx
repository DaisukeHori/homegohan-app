/**
 * image-attach.test.tsx
 * 画像添付機能のテスト (expo-image-picker モック)
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// --- モック設定 ---
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockDel = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
    del: mockDel,
  }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'test-session-id' }),
  router: {
    back: jest.fn(),
    push: jest.fn(),
  },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// --- コンポーネント import (モック設定後) ---
import React from 'react';
import { Alert, Pressable } from 'react-native';
import AiSessionPage from '../../app/ai/[sessionId]';
import { supabase } from '../../src/lib/supabase';
import * as ImagePicker from 'expo-image-picker';

// モック関数への型付きエイリアス
const mockRequestPermissions = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const mockLaunchLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock;

let mockAlertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (supabase.auth.getSession as jest.Mock).mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  });
  global.fetch = jest.fn();
  mockAlertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockGet.mockResolvedValue({ messages: [] });
});

afterEach(() => {
  mockAlertSpy.mockRestore();
});

/** 入力バーの画像添付ボタンを押す (最後から2番目の Pressable) */
async function pressImageAttachButton() {
  const pressables = screen.UNSAFE_getAllByType(Pressable);
  // PageHeader: back(0), summarize(1), close(2)
  // Input bar: image(last-1), send(last)
  const imageBtn = pressables[pressables.length - 2];
  await act(async () => {
    fireEvent.press(imageBtn);
  });
}

describe('AiSessionPage — 画像添付 (expo-image-picker)', () => {
  it('画像添付ボタン(入力バー内の最後から2番目の Pressable)が存在する', async () => {
    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    const pressables = screen.UNSAFE_getAllByType(Pressable);
    // 最低でも PageHeader×3 + 画像ボタン + 送信ボタン = 5 つ以上
    expect(pressables.length).toBeGreaterThanOrEqual(5);
  });

  it('権限が granted のとき、launchImageLibraryAsync が呼ばれる', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockLaunchLibrary.mockResolvedValueOnce({ canceled: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await pressImageAttachButton();

    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockLaunchLibrary).toHaveBeenCalledTimes(1);
    expect(mockLaunchLibrary).toHaveBeenCalledWith({
      mediaTypes: 'images',
      allowsEditing: true,
      quality: 0.7,
      base64: true,
    });
  });

  it('権限が denied のとき、Alert が表示され launchImageLibraryAsync は呼ばれない', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ status: 'denied' });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await pressImageAttachButton();

    expect(mockAlertSpy).toHaveBeenCalledWith(
      '権限が必要です',
      '画像を添付するにはカメラロールへのアクセスを許可してください。'
    );
    expect(mockLaunchLibrary).not.toHaveBeenCalled();
  });

  it('画像選択がキャンセルされた場合、添付プレビューは表示されない', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockLaunchLibrary.mockResolvedValueOnce({ canceled: true });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await pressImageAttachButton();

    // キャンセルなので launchImageLibraryAsync は呼ばれるが
    // attachedImage は設定されない
    expect(mockLaunchLibrary).toHaveBeenCalledTimes(1);
    // エラーや Alert は発生しない
    expect(mockAlertSpy).not.toHaveBeenCalled();
    // 入力欄は空のまま
    const input = screen.getByPlaceholderText('相談内容を入力...');
    expect(input.props.value).toBe('');
  });

  it('画像選択成功時、Pressable の数が増える (プレビューの削除ボタンが追加される)', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockLaunchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/test-image.jpg',
          base64: 'base64encodeddata==',
          width: 800,
          height: 600,
        },
      ],
    });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    const pressablesBefore = screen.UNSAFE_getAllByType(Pressable);
    const countBefore = pressablesBefore.length;

    await pressImageAttachButton();

    // 画像が選択されると削除ボタン(×)が追加される → Pressable が増える
    await waitFor(() => {
      const pressablesAfter = screen.UNSAFE_getAllByType(Pressable);
      expect(pressablesAfter.length).toBeGreaterThan(countBefore);
    });
  });

  it('添付画像の削除ボタン(×)を押すと Pressable の数が元に戻る', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockLaunchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/test-image.jpg',
          base64: 'base64encodeddata==',
        },
      ],
    });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    const pressablesBefore = screen.UNSAFE_getAllByType(Pressable);
    const countBefore = pressablesBefore.length;

    // 画像を添付
    await pressImageAttachButton();

    // 添付後は Pressable が増えている
    await waitFor(() => {
      expect(screen.UNSAFE_getAllByType(Pressable).length).toBeGreaterThan(countBefore);
    });

    // 削除ボタン(×)を押す
    // 添付プレビュー追加後、Pressable の順序:
    // [0]: back, [1]: summarize, [2]: close, [3]: 削除ボタン(×), [4]: image, [5]: send
    const pressablesAfterAttach = screen.UNSAFE_getAllByType(Pressable);
    // 削除ボタンは送信・画像添付より前、CloseSession より後
    const removeBtn = pressablesAfterAttach[pressablesAfterAttach.length - 3];
    await act(async () => {
      fireEvent.press(removeBtn);
    });

    // 削除後は Pressable の数が元に戻る
    await waitFor(() => {
      expect(screen.UNSAFE_getAllByType(Pressable).length).toBe(countBefore);
    });
  });

  it('base64 がない asset は attachedImage が設定されない (Pressable 数が変わらない)', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ status: 'granted' });
    mockLaunchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/no-base64.jpg',
          base64: null, // base64 なし
        },
      ],
    });

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    const pressablesBefore = screen.UNSAFE_getAllByType(Pressable);
    const countBefore = pressablesBefore.length;

    await pressImageAttachButton();

    // base64 がないので attachedImage は設定されない
    // → 削除ボタンが追加されない (Pressable の数が変わらない)
    await act(async () => {}); // 非同期更新を flush
    expect(screen.UNSAFE_getAllByType(Pressable).length).toBe(countBefore);
  });
});

// TODO: 画像添付付きメッセージの送信テスト
// 現在 apps/mobile/app/ai/[sessionId].tsx では imageBase64 を body に含めて送信している。
// 送信時のフルフロー (image picker -> attach -> send with imageBase64) のテストは
// Maestro E2E テストでカバー予定。
describe.skip('TODO: 画像付きメッセージ送信の統合テスト', () => {
  it('imageBase64 を含むリクエストボディで fetch が呼ばれる', () => {
    // Maestro E2E テストでカバー予定
  });
});
