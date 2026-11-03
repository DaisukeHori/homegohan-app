/**
 * #2206 G2: AI 相談シート (AIAdvisorSheet) が応答 (SSE の最後の finalData) を受け取れなかったときの扱いを、Web
 * (src/components/AIChatBubble.tsx の resolveIncompleteReply) と揃える。
 *
 * 問題 (直す前):
 *   - 本文 (accumulated) だけを受け取って finalData が無いと、途中の本文だけを返答として出していた。サーバーでは返答の保存と
 *     自動実行が済んでいることがあるのに、自動実行の一文もタブの読み込み直しも出なかった
 *   - 応答を受け付けたあとの AbortError 以外の例外 (本文の読み取りの失敗) では、Alert を出して送った文を消していた
 *   - 送信の待ちの上限は応答の見出しを受けた時点で外れたので、本文の読み取りには上限が無かった (止まると送信中のまま)
 *   - 応答を受ける前に通信が切れた (TypeError) ときも Alert だけで、取り直す導線が無かった
 *
 * 直したあと:
 *   1. finalData が無ければ、本文が流れてきていても会話を取り直し、保存された返答と前の依頼の一文を出す
 *   2. 取り直せなければ、送った文を入力欄に戻し、途中で切れた旨の案内と「最新の会話を読み込む」を出す
 *   3. 本文の読み取りも送信の待ちの上限 (AI_CHAT_STREAM_TIMEOUT_MS) で打ち切り、時間切れと同じ導線を出す
 *   4. 応答を受ける前に通信が切れたら、時間切れと同じ導線 (途中で切れた旨の案内) を出し、Alert は出さない
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockGetSession = jest.fn();
const mockFrom = jest.fn();
const mockSelect = jest.fn();
const mockEq = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost, del: jest.fn(), patch: jest.fn() }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
    channel: jest.fn(),
    from: (...args: unknown[]) => mockFrom(...args),
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
  INTERRUPTED_NOTICE_MESSAGE,
  PREVIOUS_REQUEST_EXECUTED_MESSAGE,
  TIMEOUT_NOTICE_MESSAGE,
} from '../../src/lib/ai-chat-timeout';
import {
  resetAiConsultationDataChangedListenersForTests,
  subscribeAiConsultationDataChanged,
} from '../../src/lib/ai-consultation-data-changed';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];
const SENT_TEXT = '今夜の夕食を1食作って';
const REPLY_ID = 'm4';
const SAVED_REPLY = '鶏むね肉の照り焼きで1食作りますね';
const PARTIAL = '鶏むね肉の照り';
const SAVED_MESSAGES = [
  ...OLD_MESSAGES,
  { id: 'm3', role: 'user', content: SENT_TEXT, createdAt: '2026-11-01T00:00:00.000Z' },
  { id: REPLY_ID, role: 'assistant', content: SAVED_REPLY, proposedActions: null, createdAt: '2026-11-01T00:00:01.000Z' },
];

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();
const dataChanged = jest.fn();

let serverMessages: unknown[] = OLD_MESSAGES;

const encoder = new TextEncoder();
const partialChunk = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: PARTIAL } }] })}\n\n`);

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsultationDataChangedListenersForTests();
  subscribeAiConsultationDataChanged(dataChanged);
  serverMessages = OLD_MESSAGES;
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string) => {
    if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION] };
    if (requestPath === MESSAGES_PATH) return { messages: serverMessages };
    throw new Error(`unexpected GET ${requestPath}`);
  });
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockImplementation(() => ({ eq: mockEq }));
  mockEq.mockResolvedValue({ data: [{ status: 'executed' }], error: null });
});

afterEach(() => {
  resetAiConsultationDataChangedListenersForTests();
  jest.useRealTimers();
});

async function openSheet() {
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
}

async function send() {
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
}

/** 本文の断片だけを流して、finalData を流さずに終わる応答 (流れが途中で切れた) */
function streamsPartialWithoutFinalData() {
  let reads = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          reads += 1;
          return reads === 1 ? { done: false, value: partialChunk } : { done: true, value: undefined };
        },
        cancel: async () => undefined,
      }),
    },
    text: async () => '',
  };
}

describe('AIAdvisorSheet — finalData が無いまま終わった (#2206 G2)', () => {
  it('本文の断片が流れていても断片だけを出さず、会話を取り直して保存された返答と前の依頼の一文を出す', async () => {
    serverMessages = SAVED_MESSAGES;
    fetchMock.mockResolvedValueOnce(streamsPartialWithoutFinalData());
    await openSheet();
    await send();

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeTruthy());
    expect(screen.getByText(SAVED_REPLY)).toBeTruthy();
    expect(screen.queryByText(PARTIAL)).toBeNull();
    expect(mockEq).toHaveBeenCalledWith('message_id', REPLY_ID);
    expect(dataChanged).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('会話を取り直せなければ、送った文を入力欄に戻し、途中で切れた旨の案内と取り直しの導線を出す (Alert は出さない)', async () => {
    fetchMock.mockResolvedValueOnce(streamsPartialWithoutFinalData());
    await openSheet();
    mockGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === MESSAGES_PATH) throw new Error('Network request failed');
      return { sessions: [SESSION] };
    });
    await send();

    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    expect(screen.getByText(INTERRUPTED_NOTICE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(PARTIAL)).toBeNull();
    expect(screen.getByTestId('ai-input').props.value).toBe(SENT_TEXT);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('AIAdvisorSheet — 応答を受ける前に通信が切れた (#2206 G2)', () => {
  it('Alert ではなく、途中で切れた旨の案内と「最新の会話を読み込む」を出し、送った文を入力欄に戻す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await openSheet();
    await send();

    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    expect(screen.getByText(INTERRUPTED_NOTICE_MESSAGE)).toBeTruthy();
    expect(screen.getByTestId('ai-input').props.value).toBe(SENT_TEXT);
    expect(alertSpy).not.toHaveBeenCalled();

    // 押すと取り直し、保存された返答を出す
    serverMessages = SAVED_MESSAGES;
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });
});

describe('AIAdvisorSheet — 本文の読み取りにも送信の待ちの上限 (#2206 G2)', () => {
  it('応答の見出しの後に本文が止まっても、AI_CHAT_STREAM_TIMEOUT_MS で打ち切って時間切れの導線を出す', async () => {
    await openSheet();
    jest.useFakeTimers();
    let cancelled = false;
    let finishPendingRead: ((result: { done: boolean; value?: Uint8Array }) => void) | null = null;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          // 本文が届かない (読み取りが返らない)。cancel されたら done で返る (ストリームの reader と同じ)
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              finishPendingRead = resolve;
            }),
          cancel: async () => {
            cancelled = true;
            finishPendingRead?.({ done: true });
          },
        }),
      },
      text: async () => '',
    });
    await send();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      jest.advanceTimersByTime(AI_CHAT_STREAM_TIMEOUT_MS - 1);
    });
    expect(cancelled).toBe(false);
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(cancelled).toBe(true);
    jest.useRealTimers();
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    expect(screen.getByText(TIMEOUT_NOTICE_MESSAGE)).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
