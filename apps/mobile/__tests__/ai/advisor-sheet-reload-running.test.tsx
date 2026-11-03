/**
 * #2201 U3: AI 相談シート (AIAdvisorSheet) が応答 (SSE の最後の finalData) を受け取れずに会話を取り直したとき、
 * 送った文への返答の提案の記録 (ai_action_logs) が実行中の印 (approved) のままなら、頼み直しを勧めない一文
 * 『前の依頼は実行中か実行済みです』を出し、少し待って (PREVIOUS_REQUEST_RECHECK_DELAY_MS) 1 回だけ読み直す。
 * 読み直して実行できていれば一文を『前の依頼は実行されました』に置き換え、タブの読み込み直しを 1 回知らせる。
 *
 * 問題 (直す前): 実行できた行 (executed) だけを数えていたので、献立の生成のように時間切れより長く走る提案は、取り直した時点で
 * 行が実行中の印のままになり、何も出さず、タブも読み込み直さなかった (案内も消えるので、後から確かめる道も無かった)。
 *   1. 時間切れの後の「最新の会話を読み込む」で実行中の印のまま → 一文を出す。読み直しで実行できていれば置き換えて知らせる
 *   2. 読み直しでもまだ実行中の印のまま・読めない → 一文はそのまま、知らせない (読み直しは 1 回だけ)
 *   3. 応答の本文を読めなかったときの取り直しでも同じ
 *   4. シートを外したら、読み直さない
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

// 読み直しまでの待ちを短くする (本物は PREVIOUS_REQUEST_RECHECK_DELAY_MS)
jest.mock('@homegohan/shared', () => ({
  ...jest.requireActual('@homegohan/shared'),
  PREVIOUS_REQUEST_RECHECK_DELAY_MS: 30,
}));
/** 読み直しの待ち (上の jest.mock の値と同じ) より十分長い待ち */
const LONGER_THAN_RECHECK_MS = 200;

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children,
}));

import React from 'react';
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';
import { PREVIOUS_REQUEST_EXECUTED_MESSAGE, PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE } from '../../src/lib/ai-chat-timeout';
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

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();
const dataChanged = jest.fn();

let serverMessages: unknown[] = OLD_MESSAGES;

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** 提案の記録 (ai_action_logs) の読み取りの結果を、読む順に決める (最後の 1 つは使い続ける) */
function actionLogsReads(...results: Array<{ data: unknown; error: unknown } | Error>) {
  const queue = [...results];
  mockEq.mockImplementation(async () => {
    const result = queue.length > 1 ? queue.shift()! : queue[0];
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
  actionLogsReads({ data: [], error: null });
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



const APPROVED = { data: [{ status: 'approved' }], error: null };
const EXECUTED = { data: [{ status: 'executed' }], error: null };

async function waitPastRecheck() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LONGER_THAN_RECHECK_MS));
  });
}

describe('AIAdvisorSheet — 時間切れの後の取り直しで、記録が実行中の印のまま (#2201 U3)', () => {
  it('『前の依頼は実行中か実行済みです』を返答のすぐ後に出し、読み直して実行できていれば置き換えて 1 回知らせる', async () => {
    actionLogsReads(APPROVED, EXECUTED);
    await openSheet();
    await sendTimeOutAndReload(SAVED_MESSAGES);

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE)).toBeTruthy());
    let texts = renderedTexts();
    expect(texts.indexOf(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE)).toBe(texts.indexOf(SAVED_REPLY) + 1);
    expect(dataChanged).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE)).toBeNull();
    texts = renderedTexts();
    expect(texts.indexOf(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBe(texts.indexOf(SAVED_REPLY) + 1);
    expect(dataChanged).toHaveBeenCalledTimes(1);
    expect(mockEq).toHaveBeenCalledTimes(2);
    expect(mockEq).toHaveBeenLastCalledWith('message_id', REPLY_ID);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['まだ実行中の印のまま', APPROVED],
    ['読み直しが失敗を返した', { data: null, error: { message: 'permission denied' } }],
    ['読み直しが例外を投げた', new Error('Network request failed')],
  ])('読み直しで %s なら、一文はそのまま・知らせない (読み直しは 1 回だけ)', async (_label, recheck) => {
    actionLogsReads(APPROVED, recheck);
    await openSheet();
    await sendTimeOutAndReload(SAVED_MESSAGES);

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE)).toBeTruthy());
    await waitFor(() => expect(mockEq).toHaveBeenCalledTimes(2));
    await waitPastRecheck();
    expect(screen.getByText(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeNull();
    expect(dataChanged).not.toHaveBeenCalled();
    expect(mockEq).toHaveBeenCalledTimes(2);
  });

  it('シートを外したら、読み直さない', async () => {
    actionLogsReads(APPROVED, EXECUTED);
    await openSheet();
    await sendTimeOutAndReload(SAVED_MESSAGES);
    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE)).toBeTruthy());

    screen.unmount();
    await waitPastRecheck();
    expect(mockEq).toHaveBeenCalledTimes(1);
    expect(dataChanged).not.toHaveBeenCalled();
  });
});

describe('AIAdvisorSheet — 応答の本文を読めなかったときの取り直しで、記録が実行中の印のまま (#2201 U3)', () => {
  it('一文を出し、読み直して実行できていれば置き換えて 1 回知らせる', async () => {
    actionLogsReads(APPROVED, EXECUTED);
    await openSheet();
    await sendWithUnreadableBody(SAVED_MESSAGES);

    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE)).toBeNull();
    expect(dataChanged).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
