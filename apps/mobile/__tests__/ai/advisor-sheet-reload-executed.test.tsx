/**
 * #2195 V3: AI 相談シート (AIAdvisorSheet) が応答 (SSE の最後の finalData) を受け取れずに会話を取り直したとき、
 * サーバーで自動実行が成功していたら、短い一文を足してタブの WebView に知らせる
 *
 * サーバーは提案の自動実行の結果を finalData の actionResult でだけ返す (保存しない)。送信が時間切れになった・応答の本文を
 * 読めなかったときは finalData を受け取れず、献立などは書き換わっているのに、結果の一文もタブの読み込み直しも出なかった。
 * 取り直した会話の GET は、実行できた提案も提案の無い返答も同じ形 (proposedActions が null) で返すので、送った文への
 * 返答の提案の記録 (ai_action_logs) の状態で見分ける。ここでは次を確かめる。
 *   1. 時間切れの後の「最新の会話を読み込む」で返答が出たとき、返答の提案の記録に実行できた行があれば、返答のすぐ後に
 *      『前の依頼は実行されました』を出し、読み込み直しを 1 回知らせる。無い・読めないときはその場では何も足さない
 *      (読めないときは少し待って 1 回だけ読み直す。#2206 G2。advisor-sheet-reload-running.test.tsx)
 *   2. 返答がまだ無い (届いているが返答の作成中) ときは記録を読まない
 *   3. 応答の本文を読めなかった (接続が切れた など) ときの取り直しでも同じ
 *   4. 流し読みで finalData を処理した後に読み取りが失敗しても、送信の失敗の Alert を出さない
 *   5. 実行を待つ・失敗した行だけなら『前の依頼は実行できませんでした』を出す / finalData の前に読み取りが失敗しても、
 *      Alert を出さずに会話を取り直す (#2206 G2)
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
import { PREVIOUS_REQUEST_EXECUTED_MESSAGE, PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE } from '../../src/lib/ai-chat-timeout';
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
const SAVED_MESSAGES = [
  ...OLD_MESSAGES,
  { id: 'm3', role: 'user', content: SENT_TEXT, createdAt: '2026-11-01T00:00:00.000Z' },
  { id: REPLY_ID, role: 'assistant', content: SAVED_REPLY, proposedActions: null, createdAt: '2026-11-01T00:00:01.000Z' },
];
const DELIVERED_NO_REPLY = SAVED_MESSAGES.slice(0, 3);

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();
const dataChanged = jest.fn();

let serverMessages: unknown[] = OLD_MESSAGES;

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** 提案の記録 (ai_action_logs) の読み取りの結果を決める */
function actionLogsRead(result: { data: unknown; error: unknown } | Error) {
  mockEq.mockImplementation(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

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
  actionLogsRead({ data: [], error: null });
});

afterEach(() => {
  resetAiConsultationDataChangedListenersForTests();
});

async function openSheet() {
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
}

/** 画面に出ている文を上から順に (Text の部品の、直下の文字列の子をつないだもの。空は除く) */
function renderedTexts(): string[] {
  return screen
    .getAllByText(/[\s\S]+/)
    .map((node) =>
      [node.props.children]
        .flat()
        .filter((child): child is string => typeof child === 'string')
        .join(''),
    )
    .filter((text) => text !== '');
}

/** メッセージを送り、送信が時間切れ (AbortError) で終わったあと、サーバーの会話を messages にして取り直す */
async function sendTimeOutAndReload(messages: unknown[]) {
  fetchMock.mockRejectedValueOnce(abortError());
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
  serverMessages = messages;
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-timeout-reload'));
  });
}

/** 応答の本文を読めなかった (text() が失敗した) 送信をし、サーバーの会話を messages にして取り直させる */
async function sendWithUnreadableBody(messages: unknown[]) {
  serverMessages = messages;
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: null,
    text: async () => {
      throw new TypeError('Network request failed');
    },
  });
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
}

function expectReadActionLogsOfReply() {
  expect(mockFrom).toHaveBeenCalledWith('ai_action_logs');
  expect(mockSelect).toHaveBeenCalledWith('status');
  expect(mockEq).toHaveBeenCalledWith('message_id', REPLY_ID);
}

describe('AIAdvisorSheet — 時間切れの後の取り直しで、自動実行の成功を出す (#2195 V3)', () => {
  it('返答の提案の記録に実行できた行があれば、返答のすぐ後に一文を出し、読み込み直しを 1 回知らせる', async () => {
    actionLogsRead({ data: [{ status: 'executed' }], error: null });
    await openSheet();
    await sendTimeOutAndReload(SAVED_MESSAGES);

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeTruthy());
    expectReadActionLogsOfReply();
    const texts = renderedTexts();
    expect(texts.indexOf(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBe(texts.indexOf(SAVED_REPLY) + 1);
    expect(dataChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['行が無い (提案が無い返答)', { data: [], error: null }],
    ['読み取りが失敗を返した', { data: null, error: { message: 'permission denied' } }],
    ['読み取りが例外を投げた', new Error('Network request failed')],
  ])('%s なら、その場では何も足さず、読み込み直しも知らせない', async (_label, result) => {
    actionLogsRead(result);
    await openSheet();
    await sendTimeOutAndReload(SAVED_MESSAGES);

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expectReadActionLogsOfReply();
    expect(screen.queryByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeNull();
    expect(screen.queryByText(PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE)).toBeNull();
    expect(dataChanged).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });

  it('実行を待っている・失敗した行だけなら、返答のすぐ後に『実行できませんでした』を出し、読み込み直しは知らせない (#2206 G2)', async () => {
    actionLogsRead({ data: [{ status: 'pending' }, { status: 'failed' }], error: null });
    await openSheet();
    await sendTimeOutAndReload(SAVED_MESSAGES);

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE)).toBeTruthy());
    const texts = renderedTexts();
    expect(texts.indexOf(PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE)).toBe(texts.indexOf(SAVED_REPLY) + 1);
    expect(screen.queryByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeNull();
    expect(dataChanged).not.toHaveBeenCalled();
  });

  it('届いているが返答がまだ無いときは、記録を読まず何も足さない (導線を残す)', async () => {
    actionLogsRead({ data: [{ status: 'executed' }], error: null });
    await openSheet();
    await sendTimeOutAndReload(DELIVERED_NO_REPLY);

    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    expect(screen.getByText(SENT_TEXT)).toBeTruthy();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(screen.queryByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeNull();
    expect(dataChanged).not.toHaveBeenCalled();
  });

  it('届いていなければ、記録を読まず何も足さない', async () => {
    actionLogsRead({ data: [{ status: 'executed' }], error: null });
    await openSheet();
    await sendTimeOutAndReload(OLD_MESSAGES);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(mockFrom).not.toHaveBeenCalled();
    expect(screen.queryByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeNull();
    expect(dataChanged).not.toHaveBeenCalled();
  });
});

describe('AIAdvisorSheet — 応答の本文を読めなかったときの取り直しで、自動実行の成功を出す (#2195 V3)', () => {
  it('返答の提案の記録に実行できた行があれば、返答のすぐ後に一文を出し、読み込み直しを 1 回知らせる', async () => {
    actionLogsRead({ data: [{ status: 'executed' }], error: null });
    await openSheet();
    await sendWithUnreadableBody(SAVED_MESSAGES);

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeTruthy());
    expectReadActionLogsOfReply();
    const texts = renderedTexts();
    expect(texts.indexOf(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBe(texts.indexOf(SAVED_REPLY) + 1);
    expect(dataChanged).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('実行できた行が無ければ (実行を待つ行)、取り直した会話と実行できなかった一文を出し、読み込み直しを知らせない (#2206 G2)', async () => {
    actionLogsRead({ data: [{ status: 'pending' }], error: null });
    await openSheet();
    await sendWithUnreadableBody(SAVED_MESSAGES);

    expectReadActionLogsOfReply();
    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeNull();
    expect(dataChanged).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('AIAdvisorSheet — 会話を確定させた後の読み取りの失敗 (#2195 V3)', () => {
  it('流し読みで finalData を処理した後に reader.read() が失敗しても、成功の一文だけを出し、失敗の Alert を出さない', async () => {
    const finalData = {
      userMessage: { id: 'u-3', content: SENT_TEXT, createdAt: '2026-11-01T00:00:00.000Z' },
      aiMessage: { id: 'a-4', content: SAVED_REPLY, proposedActions: null, createdAt: '2026-11-01T00:00:01.000Z' },
      actionExecuted: true,
      actionResult: { success: true, result: {}, actionType: 'generate_single_meal' },
    };
    const chunk = new TextEncoder().encode(`data: ${JSON.stringify(finalData)}\n\n`);
    let reads = 0;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            if (reads === 1) return { done: false, value: chunk };
            throw new TypeError('Network request failed');
          },
        }),
      },
      text: async () => '',
    });
    await openSheet();
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    const executed = '✅ 1食を作成を実行しました！';
    await waitFor(() => expect(screen.getByText(executed)).toBeTruthy());
    expect(reads).toBe(2);
    expect(screen.getByText(SAVED_REPLY)).toBeTruthy();
    expect(screen.getByText(SENT_TEXT)).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(dataChanged).toHaveBeenCalledTimes(1);
  });

  it('finalData の前に読み取りが失敗したときは、失敗の Alert を出さずに会話を取り直す (#2206 G2。以前は Alert を出して送った文を消した)', async () => {
    actionLogsRead({ data: [{ status: 'executed' }], error: null });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            throw new TypeError('Network request failed');
          },
        }),
      },
      text: async () => '',
    });
    await openSheet();
    // 開いた後にサーバーで送った文と返答が保存された (開いたときの会話には無い)
    serverMessages = SAVED_MESSAGES;
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeTruthy());
    const texts = renderedTexts();
    expect(texts.indexOf(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBe(texts.indexOf(SAVED_REPLY) + 1);
    expect(screen.getByText(SENT_TEXT)).toBeTruthy();
    expect(dataChanged).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
