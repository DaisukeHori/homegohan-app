/**
 * #2283 (A): モバイルの AI 相談 (AIAdvisorSheet) で、終了した相談への入力と送信を止め、次の手を出す (Web の AIChatBubble と同じ。
 * Web は tests/ai-chat-bubble-session-closed-2283.test.tsx)。
 *
 * 直す前:
 *   アーカイブを受け付けたあとに新しい相談の作成が失敗すると、閉じた相談が今の相談のまま画面に残る。一覧の status は先の読み直しで
 *   終了になりアーカイブのボタンも止まるが、入力欄・送信・クイック質問・1日献立変更は止まらず、閉じた相談に会話が足されていった
 *   (status === "closed" を見るのはアーカイブの押下・ボタンの止め・一覧の印だけで、sendMessage は見なかった)。
 *
 * いま:
 *   1. 出している相談が終了したと分かっていれば (一覧の status・アーカイブの応答)、入力欄・送信・1日献立変更を止め、
 *      『この相談は終了しています。新しい相談を始めてください』の一文 (1 つだけ) と『新しい相談を始める』を出す
 *   2. 送信が 409 (終了した相談の code) で返ったときも同じ一文と操作を出し、送った文を入力欄に戻し、一覧を読み直す
 *   3. 『新しい相談を始める』で新しい相談を出すと、止めが外れて一文が消える
 *   4. 409 でも code が違う応答は、ふだんの送信の失敗のまま
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
import { SESSION_CREATE_FAILED_MESSAGE } from '../../src/lib/ai-chat-load-failure';
import {
  CONSULTATION_SESSION_CLOSED_CODE,
  CONSULTATION_SESSION_CLOSED_MESSAGE,
  CONSULTATION_SESSION_CLOSED_STATUS,
} from '../../src/lib/ai-consultation-session-closed';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const OTHER_SESSION = { id: 'session-other', title: 'AI相談', messageCount: 1, status: 'closed' };
const NEW_SESSION = { id: 'session-new', title: 'AI相談', messageCount: 0, status: 'active' };
const SESSIONS_PATH = '/api/ai/consultation/sessions?status=all';
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const OTHER_MESSAGES_PATH = `/api/ai/consultation/sessions/${OTHER_SESSION.id}/messages`;
const CREATE_PATH = '/api/ai/consultation/sessions';
const CLOSE_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/close`;
const SEND_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/messages?stream=true`;
const HISTORY_REPLY = '野菜を足しましょう';
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: HISTORY_REPLY, createdAt: '2026-10-08T00:00:01.000Z' },
];
const OTHER_REPLY = '前の相談の返答です';
const OTHER_MESSAGES = [{ id: 'o1', role: 'assistant', content: OTHER_REPLY, createdAt: '2026-10-07T00:00:01.000Z' }];
const WELCOME_FRAGMENT = 'ほめゴハンのAIアドバイザーです';
const SENT_TEXT = '明日の朝ごはんは?';

const fetchMock = jest.fn();

/** 失敗の応答 (非 ok) のときに共通クライアントが投げる例外と同じ形 */
function httpError(): Error {
  return new Error('HTTP 500 Internal Server Error: {"error":"boom"}');
}

type GetHandler = (requestPath: string) => Promise<unknown>;

const defaultGet: GetHandler = async (requestPath) => {
  if (requestPath === SESSIONS_PATH) return { sessions: [SESSION, OTHER_SESSION] };
  if (requestPath === MESSAGES_PATH) return { messages: OLD_MESSAGES };
  if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
  throw new Error(`unexpected GET ${requestPath}`);
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(defaultGet);
  mockPost.mockResolvedValue({ success: true, session: { id: NEW_SESSION.id } });
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockImplementation(() => ({ eq: mockEq }));
  mockEq.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const sessionListReads = () => mockGet.mock.calls.filter(([requestPath]) => requestPath === SESSIONS_PATH);
const createCalls = () => mockPost.mock.calls.filter(([requestPath]) => requestPath === CREATE_PATH);
const sendCalls = () => fetchMock.mock.calls.filter(([url]) => url === SEND_URL);

function sessionsGetWith(handler: () => Promise<unknown>) {
  mockGet.mockImplementation(async (requestPath: string) => (requestPath === SESSIONS_PATH ? handler() : defaultGet(requestPath)));
}

async function openSheetWithHistory() {
  const view = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText(HISTORY_REPLY)).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
  return view;
}

/** アーカイブを押す (/close は ok・要約なし) */
async function pressArchiveAccepted() {
  fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-archive-btn'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));
}

/** 出している相談が終了した画面: 一文 1 つと『新しい相談を始める』・入力欄と送信と 1日献立変更が止まっている */
function expectClosedScreen() {
  expect(screen.getByTestId('ai-session-closed-notice')).toBeTruthy();
  expect(screen.getAllByText(CONSULTATION_SESSION_CLOSED_MESSAGE)).toHaveLength(1);
  expect(screen.getByTestId('ai-session-closed-new-session')).toBeTruthy();
  expect(screen.getByTestId('ai-input').props.editable).toBe(false);
  expect(screen.getByTestId('ai-send-btn')).toBeDisabled();
  expect(screen.getByTestId('ai-day-menu-btn')).toBeDisabled();
}

/** 入力欄に文を入れて送信ボタンを押す (止めているときも押下を送り、入口の止めを確かめる) */
async function typeAndPressSend() {
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
}

/** アーカイブを受け付けたあと、新しい相談の作成が失敗して、閉じた相談が今の相談のまま残る順序 */
async function archiveThenCreateFails(options: { reloadedListFails: boolean }) {
  await openSheetWithHistory();
  if (options.reloadedListFails) {
    sessionsGetWith(async () => {
      throw httpError();
    });
  } else {
    sessionsGetWith(async () => ({ sessions: [{ ...SESSION, status: 'closed' }, OTHER_SESSION] }));
  }
  mockPost.mockRejectedValue(httpError());
  await pressArchiveAccepted();
  await waitFor(() => expect(screen.getByText(SESSION_CREATE_FAILED_MESSAGE)).toBeTruthy());
  // 閉じた相談が今の相談のまま (会話がそのまま)
  expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
}

describe('#2283 (A) 終了した相談が今の相談として残ったら、入力と送信を止めて次の手を出す', () => {
  it('アーカイブを受け付けたあとに作成が失敗して閉じた相談が残ると、入力欄・送信・1日献立変更を止め、一文と『新しい相談を始める』を出す', async () => {
    await archiveThenCreateFails({ reloadedListFails: false });

    await waitFor(() => expect(screen.getByTestId('ai-session-closed-notice')).toBeTruthy());
    expectClosedScreen();

    // 送信ボタンの押下 (入口の止め) でも、閉じた相談へ送らない
    await typeAndPressSend();
    expect(sendCalls()).toHaveLength(0);
    // 1日献立変更の押下でもモーダルを開かない
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-day-menu-btn'));
    });
    expect(sendCalls()).toHaveLength(0);
  });

  it('アーカイブのあとの一覧の読み直しも失敗しても、アーカイブを受け付けた相談は終了として止める', async () => {
    await archiveThenCreateFails({ reloadedListFails: true });

    await waitFor(() => expect(screen.getByTestId('ai-session-closed-notice')).toBeTruthy());
    expectClosedScreen();
    await typeAndPressSend();
    expect(sendCalls()).toHaveLength(0);
  });

  it('『新しい相談を始める』で新しい相談を出すと、止めが外れて一文が消える', async () => {
    await archiveThenCreateFails({ reloadedListFails: false });
    await waitFor(() => expect(screen.getByTestId('ai-session-closed-notice')).toBeTruthy());
    mockPost.mockResolvedValue({ success: true, session: { id: NEW_SESSION.id } });
    sessionsGetWith(async () => ({ sessions: [NEW_SESSION, { ...SESSION, status: 'closed' }, OTHER_SESSION] }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-session-closed-new-session'));
    });
    await waitFor(() => expect(screen.getByText(new RegExp(WELCOME_FRAGMENT))).toBeTruthy());

    expect(createCalls()).toHaveLength(2);
    expect(screen.queryByTestId('ai-session-closed-notice')).toBeNull();
    expect(screen.queryByText(CONSULTATION_SESSION_CLOSED_MESSAGE)).toBeNull();
    expect(screen.getByTestId('ai-input').props.editable).toBe(true);
  });

  it('一覧で終了の相談に切り替えても、入力と送信を止めて一文を出す', async () => {
    await openSheetWithHistory();
    expect(screen.queryByTestId('ai-session-closed-notice')).toBeNull();
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });
    await waitFor(() => expect(screen.getByText(OTHER_REPLY)).toBeTruthy());

    expectClosedScreen();
  });
});

describe('#2283 (A) 送信が 409 (終了した相談) で返ったとき', () => {
  /** 次の送信を 409 で返す (code を変えられる) */
  function rejectNextSendWith(code: string) {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: CONSULTATION_SESSION_CLOSED_STATUS,
      text: async () => JSON.stringify({ error: CONSULTATION_SESSION_CLOSED_MESSAGE, code }),
    }));
  }

  it('同じ一文と『新しい相談を始める』を出し、送った文を入力欄に戻し、一覧を読み直して終了に合わせる', async () => {
    await openSheetWithHistory();
    const listReadsBefore = sessionListReads().length;
    sessionsGetWith(async () => ({ sessions: [{ ...SESSION, status: 'closed' }, OTHER_SESSION] }));
    rejectNextSendWith(CONSULTATION_SESSION_CLOSED_CODE);

    await typeAndPressSend();
    await waitFor(() => expect(screen.getByTestId('ai-session-closed-notice')).toBeTruthy());
    await waitFor(() => expect(sessionListReads().length).toBe(listReadsBefore + 1));

    expect(sendCalls()).toHaveLength(1);
    expectClosedScreen();
    // 送った文は失われない (入力欄に戻す)。送っていないので、仮の吹き出しも失敗の Alert も出さない
    expect(screen.getByTestId('ai-input').props.value).toBe(SENT_TEXT);
    expect(screen.queryByText(SENT_TEXT)).toBeNull();
    expect(Alert.alert).not.toHaveBeenCalled();
    // 閉じた相談の status が一覧に反映され、アーカイブのボタンも止まる
    await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).toBeDisabled());

    // 二度目の送信も止まる
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    expect(sendCalls()).toHaveLength(1);
  });

  it('一覧の読み直しが失敗しても、終了した相談として止める', async () => {
    await openSheetWithHistory();
    sessionsGetWith(async () => {
      throw httpError();
    });
    rejectNextSendWith(CONSULTATION_SESSION_CLOSED_CODE);

    await typeAndPressSend();
    await waitFor(() => expect(screen.getByTestId('ai-session-closed-notice')).toBeTruthy());

    expectClosedScreen();
    expect(screen.getByTestId('ai-input').props.value).toBe(SENT_TEXT);
  });

  it('409 でも code が違う応答は、終了した相談として扱わない (ふだんの送信の失敗のまま)', async () => {
    await openSheetWithHistory();
    rejectNextSendWith('SOMETHING_ELSE');

    await typeAndPressSend();
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());

    expect(screen.queryByTestId('ai-session-closed-notice')).toBeNull();
    expect(screen.getByTestId('ai-input').props.editable).toBe(true);
  });
});
