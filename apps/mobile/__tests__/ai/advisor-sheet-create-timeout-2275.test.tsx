/**
 * #2275 T2: モバイルの AI 相談 (AIAdvisorSheet) の回帰テスト。
 *
 * 直す前:
 *   (1) 新しい相談の作成 (「新しい相談を始める」の createNewSession・開いたときの initSession) の POST が時間切れになると、作成の
 *       時間切れの一文をすぐ出すだけで、一覧を読み直さなかった。作成がサーバーで済んでいても、その相談は画面に出ず、もう一度
 *       押す (開いたときなら、そのまま送る) と空の相談がもう 1 つできた。Web (#2265 Q2・#2272 S2) は一覧を読み直し、作成を始める
 *       前に見えていなかった終了していない・メッセージの無い相談 (sessionCreatedSince) を出す。判定が Web と一致することは
 *       tests/mobile-ai-session-created-since-2275.test.ts が確かめる。
 *   (2) 一覧を読めなかった一文 (#2272 S1) は会話の 1 件として持つので、そのあとの会話の置き換え (相談の切り替え・開き直しの
 *       読み込み・新しい相談・取り直し) で、一覧がまだ古いのに一文だけ先に消えた (一覧の画面の一文も一緒に消えた)。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { HttpNetworkError } from '@homegohan/core';
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
  SESSION_CREATE_FAILED_MESSAGE,
  SESSION_CREATE_TIMEOUT_MESSAGE,
  SESSIONS_LOAD_FAILED_MESSAGE,
  SESSIONS_LOAD_TIMEOUT_MESSAGE,
  MESSAGES_LOAD_FAILED_MESSAGE,
} from '../../src/lib/ai-chat-load-failure';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const OTHER_SESSION = { id: 'session-other', title: 'AI相談', messageCount: 1, status: 'closed' };
/** 作成の応答は時間切れだったが、サーバーで作れていた相談 */
const MADE_SESSION = { id: 'session-made', title: 'AI相談', messageCount: 0, status: 'active' };
/** 作成を始める前から一覧に出ていた、メッセージの無い相談 (作れていた相談として選ばない) */
const EMPTY_LISTED_SESSION = { id: 'session-empty-listed', title: 'AI相談', messageCount: 0, status: 'active' };
const SESSIONS_PATH = '/api/ai/consultation/sessions?status=all';
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const OTHER_MESSAGES_PATH = `/api/ai/consultation/sessions/${OTHER_SESSION.id}/messages`;
const CREATE_PATH = '/api/ai/consultation/sessions';
const sendUrlOf = (sessionId: string) => `http://localhost:3000/api/ai/consultation/sessions/${sessionId}/messages?stream=true`;
const HISTORY_REPLY = '野菜を足しましょう';
const OTHER_REPLY = '前の相談の返答です';
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: HISTORY_REPLY, createdAt: '2026-10-08T00:00:01.000Z' },
];
const OTHER_MESSAGES = [{ id: 'o1', role: 'assistant', content: OTHER_REPLY, createdAt: '2026-10-07T00:00:01.000Z' }];
const WELCOME_FRAGMENT = 'ほめゴハンのAIアドバイザーです';
const SENT_TEXT = '今夜の夕食を1食作って';
/** 共通クライアントが待ちの上限を過ぎたときに投げる例外の待ち時間 (値は判定に関わらない) */
const CLIENT_TIMEOUT_MS = 120_000;

const fetchMock = jest.fn();

/** 失敗の応答 (非 ok) のときに共通クライアントが投げる例外と同じ形 */
function httpError(): Error {
  return new Error('HTTP 500 Internal Server Error: {"error":"boom"}');
}

/** 共通クライアントの待ちの上限を過ぎたときの例外 */
function clientTimeout(): HttpNetworkError {
  return new HttpNetworkError('timeout', '通信がタイムアウトしました', { timeoutMs: CLIENT_TIMEOUT_MS });
}

/** 送信の待ちの上限で打ち切ったときの例外 */
function abortError(): Error {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/** 一覧の GET が返す相談 (テストの中で差し替える) */
let listedSessions: unknown[] = [];

const defaultGet = async (requestPath: string) => {
  if (requestPath === SESSIONS_PATH) return { sessions: listedSessions };
  if (requestPath === MESSAGES_PATH) return { messages: OLD_MESSAGES };
  if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
  if (requestPath.endsWith('/messages')) return { messages: [] };
  throw new Error(`unexpected GET ${requestPath}`);
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  global.fetch = fetchMock as unknown as typeof fetch;
  listedSessions = [SESSION, OTHER_SESSION];
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(defaultGet);
  mockPost.mockResolvedValue({ success: true, session: { id: MADE_SESSION.id } });
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockImplementation(() => ({ eq: mockEq }));
  mockEq.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const createCalls = () => mockPost.mock.calls.filter(([requestPath]) => requestPath === CREATE_PATH);
const sessionListReads = () => mockGet.mock.calls.filter(([requestPath]) => requestPath === SESSIONS_PATH);
const sentUrls = () => fetchMock.mock.calls.map(([url]) => url);

/** 一覧の GET だけを handler に差し替える (会話の GET は既定のまま) */
function sessionsGetWith(handler: () => Promise<unknown>) {
  mockGet.mockImplementation(async (requestPath: string) => (requestPath === SESSIONS_PATH ? handler() : defaultGet(requestPath)));
}

/** 作成の POST は時間切れ (サーバーでは作れていたかもしれない)。そのあとの一覧は sessionsAfter を返す */
function createTimesOutThenListShows(sessionsAfter: unknown[]) {
  mockPost.mockImplementation(async () => {
    listedSessions = sessionsAfter;
    throw clientTimeout();
  });
}

/** 開いて、今の相談の履歴が出るまで待つ */
async function openSheetWithHistory() {
  const view = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText(HISTORY_REPLY)).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
  return view;
}

/** シートを閉じて開き直す (開き直しの読み込み initSession が走る) */
async function reopen(view: ReturnType<typeof render>) {
  view.rerender(<AIAdvisorSheet visible={false} onClose={jest.fn()} />);
  await act(async () => {
    view.rerender(<AIAdvisorSheet visible onClose={jest.fn()} />);
  });
}

/** 一覧の画面から「新しい相談を始める」を押す */
async function pressNewSession() {
  fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-new-session'));
  });
}

/** 文を送る (送信の POST は ok でない応答にして、宛先だけを見る) */
async function sendText() {
  await waitFor(() => expect(screen.getByTestId('ai-input').props.editable).toBe(true));
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, text: async () => '{"error":"boom"}' }));
  await waitFor(() => expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled());
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
}

describe('#2275 T2 (1) 「新しい相談を始める」の作成が時間切れ', () => {
  it('一覧を読み直し、作れていた相談を出す (時間切れの一文を出さず、続けて送ると作れていた相談へ送る。2 つ目を作らない)', async () => {
    await openSheetWithHistory();
    const listReadsBefore = sessionListReads().length;
    createTimesOutThenListShows([MADE_SESSION, SESSION, OTHER_SESSION]);
    await pressNewSession();

    await waitFor(() => expect(screen.getByText(new RegExp(WELCOME_FRAGMENT))).toBeTruthy());
    expect(sessionListReads().length).toBe(listReadsBefore + 1);
    expect(screen.queryByText(SESSION_CREATE_TIMEOUT_MESSAGE)).toBeNull();
    expect(screen.queryByText(HISTORY_REPLY)).toBeNull();
    // 作れていた相談が今の相談 (アーカイブも押せる)
    await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());

    await sendText();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(sendUrlOf(MADE_SESSION.id), expect.anything()));
    expect(sentUrls()).not.toContain(sendUrlOf(SESSION.id));
    expect(createCalls()).toHaveLength(1);
  });

  it('作れていた相談が見つからない (一覧に増えていない): 作成の時間切れの一文を出し、今の会話を残す', async () => {
    await openSheetWithHistory();
    createTimesOutThenListShows([SESSION, OTHER_SESSION]);
    await pressNewSession();

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_TIMEOUT_MESSAGE)).toBeTruthy());
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
    expect(createCalls()).toHaveLength(1);
  });

  it.each([
    ['終了した相談', { ...MADE_SESSION, status: 'closed' }],
    ['メッセージのある相談', { ...MADE_SESSION, messageCount: 1 }],
  ] as const)('読み直した一覧で初めて見えたのが %s なら、作れていた相談として選ばない', async (_label, appeared) => {
    await openSheetWithHistory();
    createTimesOutThenListShows([appeared, SESSION, OTHER_SESSION]);
    await pressNewSession();

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_TIMEOUT_MESSAGE)).toBeTruthy());
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
  });

  it('作成の前から一覧に出ていたメッセージの無い相談は、作れていた相談として選ばない', async () => {
    listedSessions = [SESSION, EMPTY_LISTED_SESSION, OTHER_SESSION];
    await openSheetWithHistory();
    createTimesOutThenListShows([EMPTY_LISTED_SESSION, SESSION, OTHER_SESSION]);
    await pressNewSession();

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_TIMEOUT_MESSAGE)).toBeTruthy());
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
  });

  it('一覧の読み直しも失敗: 作成の時間切れの一文だけを出す (一覧の一文を重ねない)', async () => {
    await openSheetWithHistory();
    mockPost.mockImplementation(async () => {
      sessionsGetWith(async () => {
        throw httpError();
      });
      throw clientTimeout();
    });
    await pressNewSession();

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_TIMEOUT_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(SESSIONS_LOAD_FAILED_MESSAGE)).toBeNull();
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
  });

  it('時間切れでない失敗の応答では、一覧を読み直さない (作成の失敗の一文。以前のまま)', async () => {
    await openSheetWithHistory();
    const listReadsBefore = sessionListReads().length;
    mockPost.mockRejectedValue(httpError());
    await pressNewSession();

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_FAILED_MESSAGE)).toBeTruthy());
    expect(sessionListReads().length).toBe(listReadsBefore);
  });

  it('作成を待つ間に別の相談に切り替えて出さなかった相談も、次の作成の時間切れで『作れていた相談』として選ばない', async () => {
    await openSheetWithHistory();
    // 1 回目の作成: 応答を待つ間に別の相談に切り替える (作れた相談は画面に出さない)
    let resolveFirstCreate: (value: unknown) => void = () => {};
    mockPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstCreate = resolve;
        }),
    );
    await pressNewSession();
    // 一覧の画面は作成の応答まで開いたまま
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });
    await waitFor(() => expect(screen.getByText(OTHER_REPLY)).toBeTruthy());
    await act(async () => {
      resolveFirstCreate({ success: true, session: { id: MADE_SESSION.id } });
    });
    // 2 回目の作成: 時間切れ。読み直した一覧に初めて出たのは、1 回目に作れて出さなかった相談だけ
    createTimesOutThenListShows([MADE_SESSION, SESSION, OTHER_SESSION]);
    await pressNewSession();

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_TIMEOUT_MESSAGE)).toBeTruthy());
    expect(screen.getByText(OTHER_REPLY)).toBeTruthy();
    expect(createCalls()).toHaveLength(2);
  });
});

describe('#2275 T2 (1) 開いたときの作成が時間切れ', () => {
  it('相談が無く作成が時間切れ: 一覧を読み直して作れていた相談を出し、続けて送っても 2 つ目を作らない', async () => {
    listedSessions = [];
    createTimesOutThenListShows([MADE_SESSION]);
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(new RegExp(WELCOME_FRAGMENT))).toBeTruthy());
    await waitFor(() => expect(sessionListReads()).toHaveLength(2));
    expect(screen.queryByText(SESSION_CREATE_TIMEOUT_MESSAGE)).toBeNull();

    await sendText();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(sendUrlOf(MADE_SESSION.id), expect.anything()));
    expect(createCalls()).toHaveLength(1);
  });

  it('相談が無く作成が時間切れで、作れていた相談も無い: 作成の時間切れの一文を出す', async () => {
    listedSessions = [];
    createTimesOutThenListShows([]);
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_TIMEOUT_MESSAGE)).toBeTruthy());
    expect(sessionListReads()).toHaveLength(2);
  });
});

describe('#2275 T2 (2) 一覧を読めなかった一文は、一覧を読み直せるまで会話の置き換えで消さない', () => {
  /** 開いたあと、開き直しで一覧の GET を失敗させ、一覧を読めなかった一文を出す (以後の一覧の GET は handler) */
  async function showSessionsLoadFailure(then: () => Promise<unknown>) {
    const view = await openSheetWithHistory();
    sessionsGetWith(async () => {
      throw clientTimeout();
    });
    await reopen(view);
    await waitFor(() => expect(screen.getByText(SESSIONS_LOAD_TIMEOUT_MESSAGE)).toBeTruthy());
    sessionsGetWith(then);
    return view;
  }

  /** 会話と一覧の画面の両方に、一覧を読めなかった一文が残っている */
  function expectSessionsLoadFailureKept() {
    expect(screen.getByText(SESSIONS_LOAD_TIMEOUT_MESSAGE)).toBeTruthy();
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    expect(screen.getByTestId('ai-sessions-load-failure')).toHaveTextContent(SESSIONS_LOAD_TIMEOUT_MESSAGE);
  }

  it('相談の切り替えで会話を読めた (置き換え): 一文は残る', async () => {
    await showSessionsLoadFailure(async () => {
      throw clientTimeout();
    });
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });
    await waitFor(() => expect(screen.getByText(OTHER_REPLY)).toBeTruthy());
    expect(screen.queryByText(HISTORY_REPLY)).toBeNull();
    expectSessionsLoadFailureKept();
  });

  it('相談の切り替えで会話を読めなかった (会話の失敗の一文だけの画面に置き換え): 一覧の一文も残る', async () => {
    await showSessionsLoadFailure(async () => {
      throw clientTimeout();
    });
    mockGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === SESSIONS_PATH) throw clientTimeout();
      if (requestPath === OTHER_MESSAGES_PATH) throw httpError();
      return defaultGet(requestPath);
    });
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });
    await waitFor(() => expect(screen.getByText(MESSAGES_LOAD_FAILED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(HISTORY_REPLY)).toBeNull();
    expectSessionsLoadFailureKept();
  });

  it('新しい相談を作れ、一覧の読み直しが返る前 (ようこその一文の画面に置き換え): 一文は残り、一覧を読めたら外れる', async () => {
    let resolveList: (value: unknown) => void = () => {};
    await showSessionsLoadFailure(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    await pressNewSession();
    await waitFor(() => expect(screen.getByText(new RegExp(WELCOME_FRAGMENT))).toBeTruthy());
    expect(screen.queryByText(HISTORY_REPLY)).toBeNull();
    expect(screen.getByText(SESSIONS_LOAD_TIMEOUT_MESSAGE)).toBeTruthy();

    await act(async () => {
      resolveList({ sessions: [MADE_SESSION, SESSION, OTHER_SESSION] });
    });
    await waitFor(() => expect(screen.queryByText(SESSIONS_LOAD_TIMEOUT_MESSAGE)).toBeNull());
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    expect(screen.queryByTestId('ai-sessions-load-failure')).toBeNull();
  });

  it('送信の時間切れのあと「最新の会話を読み込む」で会話を取り直した (置き換え): 一文は残る', async () => {
    await showSessionsLoadFailure(async () => {
      throw clientTimeout();
    });
    await waitFor(() => expect(screen.getByTestId('ai-input').props.editable).toBe(true));
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    fetchMock.mockRejectedValueOnce(abortError());
    await waitFor(() => expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled());
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('ai-timeout-reload')).toBeTruthy());
    const reloadsBefore = mockGet.mock.calls.filter(([requestPath]) => requestPath === MESSAGES_PATH).length;
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() =>
      expect(mockGet.mock.calls.filter(([requestPath]) => requestPath === MESSAGES_PATH).length).toBe(reloadsBefore + 1),
    );
    // 取り直した会話 (送った文はまだ無い) で置き換わった
    await waitFor(() => expect(screen.queryByTestId('ai-timeout-notice')).toBeNull());
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
    expectSessionsLoadFailureKept();
  });

  it('開き直しで一覧を読めたら、一文は外れる (以前のまま)', async () => {
    const view = await showSessionsLoadFailure(async () => ({ sessions: [SESSION, OTHER_SESSION] }));
    await reopen(view);
    await waitFor(() => expect(screen.queryByText(SESSIONS_LOAD_TIMEOUT_MESSAGE)).toBeNull());
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
  });
});
