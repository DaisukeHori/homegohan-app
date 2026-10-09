/**
 * chat-stream-abort.test.tsx
 * 送信のタイムアウト / 通信断のとき、履歴を取り直して画面を合わせるテスト (#1049 F7-18)
 *
 * 以前は 26 秒で AbortController を発火していた。RN 標準の fetch は応答を最後まで溜めてから返すので、
 * これは「応答が完全に終わるまで」の制限になり、サーバーが成功していても (AI の呼び出しだけで最大 25 秒、
 * そのあと重要度判定と保存)、26 秒を超えるとタイムアウト表示になった。しかもサーバーにはメッセージも
 * 返信も保存済みなのに、画面では送信が失敗した扱いで、履歴も取り直さなかった。
 *
 * 今は、サーバーの上限より長く待ち、待ち切れなかったときは履歴を取り直す。
 * 返信が届いていれば何も言わずに画面を合わせ、届いていなければタイムアウトを知らせる。
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
import { HttpNetworkError } from '@homegohan/core';
import React from 'react';
import { Pressable } from 'react-native';
import AiSessionPage from '../../app/ai/[sessionId]';
import { NETWORK_ERROR_MESSAGES } from '../../src/lib/api-error';

// 最初のテストでは、画面の読み込みと変換が走る。CI の --coverage (全ファイルの計装) や、
// 他の処理で混み合った環境では、既定の 5 秒を超えることがあるので、余裕を持たせる
jest.setTimeout(60_000);

/** 共通 API クライアント (packages/core) が、待ち時間を過ぎたときに投げるエラー */
const timeoutError = () => new HttpNetworkError('timeout', 'Request timed out after 75000ms', { timeoutMs: 75_000 });
/** 同じく、通信が切れたとき (圏外・接続の切断など) に投げるエラー */
const networkError = () => new HttpNetworkError('offline', 'Network request failed', { cause: new TypeError('Network request failed') });
/** fetch が中断されたときの例外 (DOMException と同じ name) */
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

const PRIOR_MESSAGES = [
  { id: 'msg-1', role: 'user' as const, content: 'こんにちは', createdAt: '2026-04-01T10:00:00.000Z' },
  { id: 'msg-2', role: 'assistant' as const, content: 'はじめまして！', createdAt: '2026-04-01T10:00:05.000Z' },
];
const SENT_USER = { id: 'msg-3', role: 'user' as const, content: '夕食を教えて', createdAt: '2026-04-01T10:01:00.000Z' };
const SAVED_REPLY = { id: 'msg-4', role: 'assistant' as const, content: 'カレーはいかがですか？', createdAt: '2026-04-01T10:01:30.000Z' };

/** テキスト入力欄を見つけて文字を入力し、送信ボタンを押す */
async function typeAndSend(inputText: string) {
  const input = screen.getByPlaceholderText('相談内容を入力...');
  fireEvent.changeText(input, inputText);
  const pressables = screen.UNSAFE_getAllByType(Pressable);
  await act(async () => {
    fireEvent.press(pressables[pressables.length - 1]);
  });
}

async function renderWithPriorMessages() {
  mockGet.mockResolvedValueOnce({ messages: PRIOR_MESSAGES });
  render(<AiSessionPage />);
  await waitFor(() => {
    expect(screen.getByText('はじめまして！')).toBeTruthy();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AiSessionPage — 26 秒を超える応答', () => {
  it('30 秒かかって成功した応答もそのまま表示する (以前は 26 秒で打ち切ってタイムアウト表示にしていた)', async () => {
    jest.useFakeTimers();
    mockGet.mockResolvedValueOnce({ messages: [] });
    mockPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                success: true,
                userMessage: { id: 'u-1', content: '遅い質問', createdAt: '2026-04-01T10:59:00.000Z' },
                aiMessage: { id: 'a-1', content: '時間はかかりましたが答えです', createdAt: '2026-04-01T11:00:00.000Z' },
                actionExecuted: false,
              }),
            30_000,
          );
        }),
    );

    render(<AiSessionPage />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy();
    });

    await typeAndSend('遅い質問');

    // 26 秒の時点ではまだ待っている (エラーにしない)
    await act(async () => {
      jest.advanceTimersByTime(26_000);
    });
    expect(screen.queryByText(/タイムアウト/)).toBeNull();
    expect(screen.getByTestId('ai-chat-streaming-view')).toBeTruthy();

    // 30 秒で届いた返信が表示される
    await act(async () => {
      jest.advanceTimersByTime(4_000);
    });
    await waitFor(() => {
      expect(screen.getByText('時間はかかりましたが答えです')).toBeTruthy();
    });
    expect(screen.queryByText(/タイムアウト/)).toBeNull();
  });
});

describe('AiSessionPage — タイムアウト後の履歴の取り直し', () => {
  it('サーバーに返信が保存済みなら、エラーにせず履歴をサーバーの内容に合わせる', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(timeoutError());
    mockGet.mockResolvedValueOnce({ messages: [...PRIOR_MESSAGES, SENT_USER, SAVED_REPLY] });

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('カレーはいかがですか？')).toBeTruthy();
    });
    // タイムアウトのエラーは出さない。ユーザーのメッセージは 1 通のまま
    expect(screen.queryByText(/タイムアウト/)).toBeNull();
    expect(screen.getAllByText('夕食を教えて')).toHaveLength(1);
    // 履歴の取り直しは、取得したあとにもう一度 GET したことになる (初回 + 取り直し)
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('返信が届いていなければタイムアウトを知らせる。保存済みのユーザーメッセージは残る', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(timeoutError());
    // ユーザーのメッセージは保存されたが、AI の返信はまだ
    mockGet.mockResolvedValueOnce({ messages: [...PRIOR_MESSAGES, SENT_USER] });

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText(/タイムアウト/)).toBeTruthy();
    });
    expect(screen.getAllByText('夕食を教えて')).toHaveLength(1);
  });

  it('何も保存されていなければ、タイムアウトを知らせて仮メッセージを消す', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(timeoutError());
    mockGet.mockResolvedValueOnce({ messages: PRIOR_MESSAGES });

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText(/タイムアウト/)).toBeTruthy();
    });
    expect(screen.queryByText('夕食を教えて')).toBeNull();
    // 以前の履歴は残る
    expect(screen.getByText('はじめまして！')).toBeTruthy();
  });

  it('履歴の取り直しにも失敗したら、タイムアウトを知らせて仮メッセージを消し、画面の履歴は消さない', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(timeoutError());
    mockGet.mockRejectedValueOnce(new Error('Network request failed'));

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText(/タイムアウト/)).toBeTruthy();
    });
    expect(screen.queryByText('夕食を教えて')).toBeNull();
    expect(screen.getByText('はじめまして！')).toBeTruthy();
  });

  it('文言は 2 つの画面で同じで、秒数は書かない (以前は画面側が「25秒」だが実際は 26 秒だった)', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(timeoutError());
    mockGet.mockResolvedValueOnce({ messages: PRIOR_MESSAGES });

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('応答がタイムアウトしました。しばらく待ってから再度お試しください。')).toBeTruthy();
    });
    expect(screen.queryByText(/25秒|26秒/)).toBeNull();
  });
});

describe('AiSessionPage — 通信が切れたとき', () => {
  it('返信が保存済みなら、エラーにせず画面を合わせる', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(networkError());
    mockGet.mockResolvedValueOnce({ messages: [...PRIOR_MESSAGES, SENT_USER, SAVED_REPLY] });

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('カレーはいかがですか？')).toBeTruthy();
    });
    expect(screen.queryByText(/通信できません/)).toBeNull();
    expect(screen.queryByText(/Network request failed/)).toBeNull();
  });

  it('返信が無ければ、「通信できません」と知らせる (タイムアウト表示にはしない。英語の技術的な文面も出さない)', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(networkError());
    mockGet.mockResolvedValueOnce({ messages: PRIOR_MESSAGES });

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText(NETWORK_ERROR_MESSAGES.offline)).toBeTruthy();
    });
    expect(screen.queryByText(/Network request failed/)).toBeNull();
    expect(screen.queryByText(/タイムアウト/)).toBeNull();
    expect(screen.queryByText('夕食を教えて')).toBeNull();
  });

  it('中断 (AbortError) もタイムアウトと同じ扱いで履歴を取り直す', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(abortError());
    mockGet.mockResolvedValueOnce({ messages: [...PRIOR_MESSAGES, SENT_USER, SAVED_REPLY] });

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('カレーはいかがですか？')).toBeTruthy();
    });
  });
});

describe('AiSessionPage — サーバーが拒否したとき', () => {
  it('HTTP エラーは履歴を取り直さず、サーバーが返したメッセージを知らせて仮メッセージを消す', async () => {
    await renderWithPriorMessages();
    // サーバーのレート制限 (src/lib/rate-limit.ts の rateLimitExceededResponse) の本文
    // 共通クライアントは、HTTP のエラー応答を `HTTP <status> <statusText>: <本文>` の Error にして投げる
    mockPost.mockRejectedValueOnce(
      new Error(
        'HTTP 429 Too Many Requests: {"error":"リクエストが多すぎます。しばらく時間をおいてからお試しください。","code":"RATE_LIMITED","retryAfter":30}',
      ),
    );

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('リクエストが多すぎます。しばらく時間をおいてからお試しください。')).toBeTruthy();
    });
    // 「HTTP 429 Too Many Requests: {...}」のような生の文字列は画面に出さない
    expect(screen.queryByText(/HTTP 429/)).toBeNull();
    expect(screen.queryByText(/RATE_LIMITED/)).toBeNull();
    expect(screen.queryByText('夕食を教えて')).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('本文が JSON でない HTTP エラー (ゲートウェイの HTML など) は、ステータスの文字列をそのまま知らせる', async () => {
    await renderWithPriorMessages();
    mockPost.mockRejectedValueOnce(new Error('HTTP 502 Bad Gateway: <html>Bad Gateway</html>'));

    await typeAndSend('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('HTTP 502 Bad Gateway: <html>Bad Gateway</html>')).toBeTruthy();
    });
    expect(screen.queryByText('夕食を教えて')).toBeNull();
  });
});
