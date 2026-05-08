/**
 * chat-stream-abort.test.tsx
 * AbortController.abort() による stream 中断 / fetch ハングタイムアウトのテスト
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// --- モック設定 (chat-stream.test.tsx と同パターン) ---
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
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// --- コンポーネント import (モック設定後) ---
import React from 'react';
import { Pressable } from 'react-native';
import AiSessionPage from '../../app/ai/[sessionId]';
import { supabase } from '../../src/lib/supabase';

/** テキスト入力欄を見つけて文字を入力し、送信ボタンを押す */
async function typeAndSend(inputText: string) {
  const input = screen.getByPlaceholderText('相談内容を入力...');
  fireEvent.changeText(input, inputText);
  const pressables = screen.UNSAFE_getAllByType(Pressable);
  await act(async () => {
    fireEvent.press(pressables[pressables.length - 1]);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  (supabase.auth.getSession as jest.Mock).mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  });
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AiSessionPage — AbortController abort() による stream 中断', () => {
  it('AbortController.abort() が呼ばれると AbortError が発生しタイムアウトメッセージが表示される', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    // fetch が AbortError をスローするシミュレーション
    (global.fetch as jest.Mock).mockImplementationOnce(
      (_url: string, opts: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // signal の abort イベントをリッスンして reject する
          const signal = opts.signal as AbortSignal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new DOMException('The operation was aborted.', 'AbortError');
              reject(err);
            });
          }
        })
    );

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('タイムアウトテスト');

    // 楽観的メッセージが表示される
    await waitFor(() => {
      expect(screen.getByText('タイムアウトテスト')).toBeTruthy();
    });

    // 26秒タイムアウトを発火させる
    await act(async () => {
      jest.advanceTimersByTime(26000);
    });

    // タイムアウトエラーメッセージが表示される
    await waitFor(() => {
      expect(screen.getByText(/タイムアウト/)).toBeTruthy();
    });
  });

  it('abort 後に楽観的メッセージが削除される', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    (global.fetch as jest.Mock).mockImplementationOnce(
      (_url: string, opts: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = opts.signal as AbortSignal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new DOMException('The operation was aborted.', 'AbortError');
              reject(err);
            });
          }
        })
    );

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('削除確認テスト');

    // 楽観的メッセージが一時的に表示される
    await waitFor(() => {
      expect(screen.getByText('削除確認テスト')).toBeTruthy();
    });

    // 26秒タイムアウトを発火させる
    await act(async () => {
      jest.advanceTimersByTime(26000);
    });

    // abort 後、楽観的メッセージが削除される
    await waitFor(() => {
      expect(screen.queryByText('削除確認テスト')).toBeNull();
    });
  });
});

describe('AiSessionPage — fetch ハングタイムアウト (26秒)', () => {
  it('fetch が 26 秒応答しない場合、タイムアウト後にエラー状態になる', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    // fetch が永久にハング (26秒タイムアウトで abort される)
    (global.fetch as jest.Mock).mockImplementationOnce(
      (_url: string, opts: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = opts.signal as AbortSignal;
          if (signal) {
            signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
          // resolve しない = ハング状態
        })
    );

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('ハングテスト');

    // 25秒ではまだタイムアウトしていない
    await act(async () => {
      jest.advanceTimersByTime(25999);
    });

    // まだエラーは表示されていない（タイムアウトが発火していない）
    // (楽観的メッセージが表示中)
    expect(screen.queryByText(/タイムアウト/)).toBeNull();

    // 26秒でタイムアウト発火
    await act(async () => {
      jest.advanceTimersByTime(1);
    });

    await waitFor(() => {
      expect(screen.getByText(/タイムアウト/)).toBeTruthy();
    });
  });

  it('fetch に signal が渡され、26秒タイムアウト設定が有効になっている', async () => {
    mockGet.mockResolvedValueOnce({ messages: [] });

    let capturedSignal: AbortSignal | undefined;
    (global.fetch as jest.Mock).mockImplementationOnce(
      (_url: string, opts: RequestInit) => {
        capturedSignal = opts.signal as AbortSignal;
        // すぐに成功レスポンスを返す
        const text = 'data: [DONE]\n';
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
          },
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          body: stream,
          text: () => Promise.resolve(text),
        } as unknown as Response);
      }
    );

    render(<AiSessionPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('signal 確認テスト');

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // signal が存在し、AbortSignal であることを確認
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // タイムアウト前は abort されていない
    expect(capturedSignal!.aborted).toBe(false);
  });
});
