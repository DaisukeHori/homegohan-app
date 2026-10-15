/**
 * #1049 F7-18: AI 相談シート (AIAdvisorSheet) の送信が時間切れになったとき
 *
 * React Native の fetch は応答を最後まで受け取ってから返すので、送信の待ち (AI_CHAT_STREAM_TIMEOUT_MS) は
 * 「返答が全部届くまで」の上限になる。打ち切っても、サーバーでは返答の保存が続いていることがある。
 * 以前は「タイムアウトしました」の Alert を出して終わり、返答が保存されていても画面に出す手段が無かった。
 * ここでは次を確かめる。
 *   1. 待ちの上限は名前付きの定数で、送信はその時間で打ち切られる (その前には打ち切らない)
 *   2. 打ち切ったら、Alert ではなく、会話を取り直す導線 (「最新の会話を読み込む」) を出す
 *   3. 押すと会話を取り直し、サーバーに保存されていた返答が出て、導線は消える
 *   4. 取り直しに失敗したら、今の会話を消さず、導線を残してエラーを知らせる
 *   5. 次の送信・別の相談に移ったら、導線は消える
 *   6. 時間切れのときは送った文を入力欄に戻す。取り直しで届いていたと分かったら、戻した文のままの入力欄を消す
 *      (二重に送らないため。書き換えていれば残す)。返答がまだ無ければ、その旨の案内と導線を残す。
 *      届いていなければ、導線を消して入力欄の文を残し、もう一度送るように知らせる
 */
import fs from 'fs';
import path from 'path';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockGetSession = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost, del: jest.fn(), patch: jest.fn() }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
    channel: jest.fn(),
    from: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children,
}));

import React from 'react';
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';
import {
  AI_CHAT_STREAM_TIMEOUT_MS,
  TIMEOUT_DELIVERED_NO_REPLY_MESSAGE,
  TIMEOUT_NOTICE_MESSAGE,
  TIMEOUT_NOT_DELIVERED_MESSAGE,
} from '../../src/lib/ai-chat-timeout';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const OTHER_SESSION = { id: 'session-2', title: 'AI相談', messageCount: 0, status: 'closed' };
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];
const SENT_TEXT = '鶏むね肉の使い方は?';
const SAVED_REPLY = '鶏むね肉は低温調理がおすすめです';
const SAVED_MESSAGES = [
  ...OLD_MESSAGES,
  { id: 'm3', role: 'user', content: SENT_TEXT, createdAt: '2026-10-08T00:01:00.000Z' },
  { id: 'm4', role: 'assistant', content: SAVED_REPLY, createdAt: '2026-10-08T00:01:30.000Z' },
];
const RELOAD_LABEL = '最新の会話を読み込む';

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** signal が中断されるまで応答しない fetch (中断されたら AbortError で失敗する) */
function hangUntilAborted(_url: string, init: { signal?: AbortSignal }): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(abortError()));
  });
}

let serverMessages: unknown[] = OLD_MESSAGES;

beforeEach(() => {
  jest.clearAllMocks();
  serverMessages = OLD_MESSAGES;
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string) => {
    if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION, OTHER_SESSION] };
    if (requestPath === MESSAGES_PATH) return { messages: serverMessages };
    if (requestPath === `/api/ai/consultation/sessions/${OTHER_SESSION.id}/messages`) return { messages: [] };
    throw new Error(`unexpected GET ${requestPath}`);
  });
});

afterEach(() => {
  jest.useRealTimers();
});

async function openSheet() {
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
}

/** メッセージを送り、送信が時間切れ (AbortError) で終わるまで待つ */
async function sendAndTimeOut() {
  fetchMock.mockRejectedValueOnce(abortError());
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
}

describe('AIAdvisorSheet — 送信の待ちの上限 (#1049 F7-18)', () => {
  it('上限は名前付きの定数 (サーバーの AI の打ち切り 25 秒 + 余裕 1 秒)。相談画面は直書きの数値を使わない', () => {
    expect(AI_CHAT_STREAM_TIMEOUT_MS).toBe(26_000);
    // (全画面の AI 相談 app/ai/[sessionId].tsx は、通常の操作で届かないネイティブの画面として消した。#1598)
    for (const file of ['src/components/ai/AIAdvisorSheet.tsx']) {
      const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
      expect(source).not.toMatch(/\b26_?000\b/);
      expect(source).toContain('AI_CHAT_STREAM_TIMEOUT_MS');
    }
  });

  it('送信は AI_CHAT_STREAM_TIMEOUT_MS で打ち切られ、その前には打ち切られない', async () => {
    await openSheet();
    jest.useFakeTimers();
    fetchMock.mockImplementationOnce(hangUntilAborted);

    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = (fetchMock.mock.calls[0][1] as { signal: AbortSignal }).signal;

    await act(async () => {
      jest.advanceTimersByTime(AI_CHAT_STREAM_TIMEOUT_MS - 1);
    });
    expect(signal.aborted).toBe(false);
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy();
  });
});

describe('AIAdvisorSheet — 送信が時間切れになったあとの取り直し (#1049 F7-18)', () => {
  it('Alert ではなく「最新の会話を読み込む」を出し、押すとサーバーに保存されていた返答が出て、導線は消える', async () => {
    await openSheet();
    await sendAndTimeOut();

    // 失敗の Alert は出さない (返答はサーバーで続いていることがある)
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getByText(RELOAD_LABEL)).toBeTruthy();

    // サーバーには、送った相談と返答が保存されていた
    serverMessages = SAVED_MESSAGES;
    mockGet.mockClear();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH);
    expect(screen.getByText(SENT_TEXT)).toBeTruthy();
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('取り直しに失敗したら、今の会話を消さず、導線を残してエラーを知らせる', async () => {
    await openSheet();
    await sendAndTimeOut();

    mockGet.mockImplementation(async () => {
      throw new Error('Network request failed');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('エラー', expect.stringContaining('会話を読み込めませんでした')));
    expect(screen.getByText('野菜を足しましょう')).toBeTruthy();
    expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy();
  });

  it('次の送信を始めたら、導線は消える', async () => {
    await openSheet();
    await sendAndTimeOut();

    jest.useFakeTimers();
    fetchMock.mockImplementationOnce(hangUntilAborted);
    fireEvent.changeText(screen.getByTestId('ai-input'), 'もう一度聞きます');
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();

    // 送信中のまま残さない (待ちの上限まで進めて終わらせる)
    await act(async () => {
      jest.advanceTimersByTime(AI_CHAT_STREAM_TIMEOUT_MS);
    });
  });

  it('別の相談に移ったら、導線は消える (前の相談の取り直しを、別の相談の画面で出さない)', async () => {
    await openSheet();
    await sendAndTimeOut();

    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });

    await waitFor(() => expect(screen.queryByText('野菜を足しましょう')).toBeNull());
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });
});

describe('AIAdvisorSheet — 時間切れのときの入力欄 (#1049 F7-18)', () => {
  const inputValue = () => screen.getByTestId('ai-input').props.value as string;

  it('時間切れになったら、送った文を入力欄に戻す', async () => {
    await openSheet();
    await sendAndTimeOut();

    expect(inputValue()).toBe(SENT_TEXT);
    expect(screen.getByText(TIMEOUT_NOTICE_MESSAGE)).toBeTruthy();
  });

  it('取り直しで返答まで届いていたら、戻した文を消し、導線も消す (そのまま送ると二重に届く)', async () => {
    await openSheet();
    await sendAndTimeOut();

    serverMessages = SAVED_MESSAGES;
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });

  it('送った文は届いているが返答がまだ無ければ、戻した文を消し、返答を待つ案内と導線を残す', async () => {
    await openSheet();
    await sendAndTimeOut();

    serverMessages = [...OLD_MESSAGES, { id: 'm3', role: 'user', content: SENT_TEXT, createdAt: '2026-10-08T00:01:00.000Z' }];
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });

    await waitFor(() => expect(screen.getByText(TIMEOUT_DELIVERED_NO_REPLY_MESSAGE)).toBeTruthy());
    expect(inputValue()).toBe('');
    expect(screen.getByTestId('ai-timeout-reload')).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();

    // もう一度取り直して返答が届いていれば、導線は消える
    serverMessages = SAVED_MESSAGES;
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });

  it('届いていたと分かっても、入力欄を書き換えていれば消さない', async () => {
    await openSheet();
    await sendAndTimeOut();

    fireEvent.changeText(screen.getByTestId('ai-input'), `${SENT_TEXT} ささみは?`);
    serverMessages = SAVED_MESSAGES;
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(inputValue()).toBe(`${SENT_TEXT} ささみは?`);
  });

  it('取り直しても届いていなければ、導線を消し、入力欄の文を残して、もう一度送るように知らせる', async () => {
    await openSheet();
    await sendAndTimeOut();

    serverMessages = OLD_MESSAGES;
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('送信できませんでした', TIMEOUT_NOT_DELIVERED_MESSAGE));
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(inputValue()).toBe(SENT_TEXT);
  });
});
