/**
 * advisor-sheet-send.test.tsx
 * AIAdvisorSheet (タブ画面の右下の AI ボタンから開くシート。実際に使われている画面) の送信のテスト (#1049 F7-18)
 *
 * app/ai/[sessionId].tsx と同じ問題があった: 26 秒の AbortController が「応答が完全に終わるまで」を
 * 制限していて、サーバーが成功していてもタイムアウト表示になり、履歴も取り直していなかった。
 * 今は共通 API クライアントでストリーミングでない POST を呼び、サーバーの上限より長く待つ。
 * 待ち切れなかったときは履歴を取り直し、返信が届いていれば何も言わずに画面を合わせる。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// --- モック設定 ---
const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) } },
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('lucide-react-native', () => ({
  Archive: () => null,
  Calendar: () => null,
  ChevronDown: () => null,
  MessageCircle: () => null,
  Send: () => null,
  Sparkles: () => null,
  X: () => null,
}));

// 1 日献立モーダルは送信と関係ないので空にする
jest.mock('../../src/components/ai/AIDayMenuModal', () => ({
  AIDayMenuModal: () => null,
}));

import React from 'react';
import { Alert } from 'react-native';
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const PRIOR = [
  { id: 'm-1', role: 'user' as const, content: '前回の質問', createdAt: '2026-04-01T10:00:00.000Z' },
  { id: 'm-2', role: 'assistant' as const, content: '前回の返事', createdAt: '2026-04-01T10:00:05.000Z' },
];
const SENT_USER = { id: 'm-3', role: 'user' as const, content: '夕食を教えて', createdAt: '2026-04-01T10:01:00.000Z' };
const SAVED_REPLY = { id: 'm-4', role: 'assistant' as const, content: 'カレーはいかがですか？', createdAt: '2026-04-01T10:01:30.000Z' };

const MESSAGES_PATH = '/api/ai/consultation/sessions/session-1/messages';

let alertSpy: jest.SpyInstance;

/** シートを開いて、既存の履歴が表示されるまで待つ */
async function openSheet() {
  mockGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/ai/consultation/sessions?')) return Promise.resolve({ sessions: [SESSION] });
    if (path === MESSAGES_PATH) return Promise.resolve({ messages: PRIOR });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => {
    expect(screen.getByText('前回の返事')).toBeTruthy();
  });
}

async function send(text: string) {
  fireEvent.changeText(screen.getByTestId('ai-input'), text);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
}

/** 履歴の取り直しで返す内容を差し替える (最初の取得は openSheet で済んでいる) */
function serverHistoryIs(messages: Array<{ id: string; role: string; content: string; createdAt: string }>) {
  mockGet.mockImplementation((path: string) => {
    if (path === MESSAGES_PATH) return Promise.resolve({ messages });
    return Promise.resolve({ sessions: [SESSION] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  // 送信は fetch を直接使わない。使ったらテストが気付けるよう、呼ばれたら失敗するモックにしておく
  global.fetch = jest.fn(() => {
    throw new Error('fetch は直接使わない (getApi().post を使う)');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  alertSpy.mockRestore();
  jest.useRealTimers();
});

describe('AIAdvisorSheet — 送信', () => {
  it('ストリーミングでない通常の POST で送り、タイムアウトは 26 秒より長い', async () => {
    await openSheet();
    mockPost.mockResolvedValueOnce({
      success: true,
      userMessage: { id: 'm-3', content: '夕食を教えて', createdAt: SENT_USER.createdAt },
      aiMessage: { id: 'm-4', content: 'カレーはいかがですか？', createdAt: SAVED_REPLY.createdAt },
    });

    await send('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('カレーはいかがですか？')).toBeTruthy();
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body, init] = mockPost.mock.calls[0];
    expect(path).toBe(MESSAGES_PATH);
    expect(path).not.toContain('stream=true');
    expect(body).toEqual({ message: '夕食を教えて' });
    expect(init.timeoutMs).toBeGreaterThan(40_000);
    // 仮メッセージは確定したメッセージに置き換わり、二重にならない
    expect(screen.getAllByText('夕食を教えて')).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('30 秒かかって成功した応答もそのまま表示する (以前は 26 秒で打ち切ってタイムアウト表示にしていた)', async () => {
    await openSheet();
    jest.useFakeTimers();
    mockPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                success: true,
                userMessage: { id: 'm-3', content: '遅い質問', createdAt: SENT_USER.createdAt },
                aiMessage: { id: 'm-4', content: '時間はかかりましたが答えです', createdAt: SAVED_REPLY.createdAt },
              }),
            30_000,
          );
        }),
    );

    await send('遅い質問');
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });

    await waitFor(() => {
      expect(screen.getByText('時間はかかりましたが答えです')).toBeTruthy();
    });
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('AIAdvisorSheet — タイムアウト・通信断のあとの履歴の取り直し', () => {
  it('サーバーに返信が保存済みなら、エラーを出さずに履歴を合わせる', async () => {
    await openSheet();
    mockPost.mockRejectedValueOnce(namedError('TimeoutError', 'Request timed out after 75000ms'));
    serverHistoryIs([...PRIOR, SENT_USER, SAVED_REPLY]);

    await send('夕食を教えて');

    await waitFor(() => {
      expect(screen.getByText('カレーはいかがですか？')).toBeTruthy();
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getAllByText('夕食を教えて')).toHaveLength(1);
  });

  it('返信が届いていなければ、タイムアウトを知らせる', async () => {
    await openSheet();
    mockPost.mockRejectedValueOnce(namedError('TimeoutError', 'Request timed out after 75000ms'));
    serverHistoryIs(PRIOR);

    await send('夕食を教えて');

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('タイムアウト', '応答がタイムアウトしました。しばらく待ってから再度お試しください。');
    });
    // 保存されなかった仮メッセージは消え、以前の履歴は残る
    expect(screen.queryByText('夕食を教えて')).toBeNull();
    expect(screen.getByText('前回の返事')).toBeTruthy();
  });

  it('通信が切れて返信も無ければ、元のエラーメッセージを知らせる', async () => {
    await openSheet();
    mockPost.mockRejectedValueOnce(namedError('HttpNetworkError', 'Network request failed'));
    serverHistoryIs(PRIOR);

    await send('夕食を教えて');

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('エラー', 'Network request failed');
    });
  });

  it('履歴の取り直しにも失敗したら、エラーを知らせて仮メッセージを消し、画面の履歴は消さない', async () => {
    await openSheet();
    mockPost.mockRejectedValueOnce(namedError('TimeoutError', 'Request timed out after 75000ms'));
    mockGet.mockImplementation(() => Promise.reject(new Error('Network request failed')));

    await send('夕食を教えて');

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('タイムアウト', expect.stringContaining('タイムアウト'));
    });
    expect(screen.queryByText('夕食を教えて')).toBeNull();
    // 取り直しの失敗でウェルカム画面に戻って、これまでの会話が消えることはない
    expect(screen.getByText('前回の返事')).toBeTruthy();
  });

  it('HTTP エラー (サーバーが拒否) は履歴を取り直さない', async () => {
    await openSheet();
    const getCallsBefore = mockGet.mock.calls.length;
    mockPost.mockRejectedValueOnce(namedError('HttpError', 'HTTP 429 Too Many Requests: {"error":"rate limited"}'));

    await send('夕食を教えて');

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('エラー', expect.stringContaining('HTTP 429'));
    });
    expect(mockGet.mock.calls.length).toBe(getCallsBefore);
    expect(screen.queryByText('夕食を教えて')).toBeNull();
  });
});
