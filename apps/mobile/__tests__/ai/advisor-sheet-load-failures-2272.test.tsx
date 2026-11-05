/**
 * #2272 S1: モバイルの AI 相談 (AIAdvisorSheet) の読み込み・作成の失敗の扱いを Web (#2265 Q2) にそろえた (回帰テスト)。
 *
 * 直す前:
 *   (1) 開いたときの読み込み (initSession) の失敗は、ようこその一文だけの画面にし、理由を出さなかった。会話の読み込み
 *       (loadMessages → fetchMessages) の失敗は、履歴のある相談でもようこその一文だけの画面に置き換え、履歴が消えたように見えた。
 *       一覧の読み込み (fetchSessions) の失敗は黙って捨てた。
 *   (2) 新しい相談の作成 (createNewSession) は、作成の POST と一覧の GET が同じ try で、作れて新しい相談が画面に出ているのに一覧の
 *       GET だけが失敗しても Alert『新しいセッションの作成に失敗しました。』と言い切った。アーカイブのあと
 *       (showFreshSessionAfterArchive) は作成だけを呼び、作成が失敗すると一覧を読み直さず、閉じた相談の status が一覧で active のまま
 *       残った (アーカイブのボタンも押せたまま)。
 * いまは Web の一文 (src/lib/ai-chat-load-failure.ts。文が Web と一致することは tests/mobile-ai-chat-load-failure-2272.test.ts) を
 * 会話に出し、時間切れ (共通クライアントの kind が 'timeout' の HttpNetworkError) と、それ以外の失敗で文を分ける。
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
  MESSAGES_LOAD_FAILED_MESSAGE,
  MESSAGES_LOAD_TIMEOUT_MESSAGE,
  SESSION_CREATE_FAILED_MESSAGE,
  SESSION_CREATE_TIMEOUT_MESSAGE,
  SESSIONS_LOAD_FAILED_MESSAGE,
  SESSIONS_LOAD_TIMEOUT_MESSAGE,
} from '../../src/lib/ai-chat-load-failure';
import { ServiceUnavailableError } from '../../src/lib/service-unavailable';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const OTHER_SESSION = { id: 'session-other', title: 'AI相談', messageCount: 1, status: 'closed' };
const NEW_SESSION = { id: 'session-new', title: 'AI相談', messageCount: 0, status: 'active' };
const SESSIONS_PATH = '/api/ai/consultation/sessions?status=all';
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const OTHER_MESSAGES_PATH = `/api/ai/consultation/sessions/${OTHER_SESSION.id}/messages`;
const CREATE_PATH = '/api/ai/consultation/sessions';
const CLOSE_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/close`;
const OLD_SESSION_SEND_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/messages?stream=true`;
const NEW_SESSION_SEND_URL = `http://localhost:3000/api/ai/consultation/sessions/${NEW_SESSION.id}/messages?stream=true`;
const HISTORY_REPLY = '野菜を足しましょう';
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: HISTORY_REPLY, createdAt: '2026-10-08T00:00:01.000Z' },
];
const OTHER_MESSAGES = [
  { id: 'o1', role: 'assistant', content: '前の相談の返答です', createdAt: '2026-10-07T00:00:01.000Z' },
];
const WELCOME_FRAGMENT = 'ほめゴハンのAIアドバイザーです';
const OLD_CREATE_FAILED_ALERT = '新しいセッションの作成に失敗しました。';
const SENT_TEXT = '今夜の夕食を1食作って';
/** 共通クライアントが待ちの上限を過ぎたときに投げる例外の待ち時間 (値は文の選び方に関わらない) */
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

type GetHandler = (requestPath: string) => Promise<unknown>;

/** 既定の GET (一覧は今の相談と閉じた相談、会話はそれぞれの履歴) */
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

const alertCalls = () => (Alert.alert as jest.Mock).mock.calls;
const sessionListReads = () => mockGet.mock.calls.filter(([requestPath]) => requestPath === SESSIONS_PATH);
const createCalls = () => mockPost.mock.calls.filter(([requestPath]) => requestPath === CREATE_PATH);
const sentUrls = () => fetchMock.mock.calls.map(([url]) => url);

/** 一覧の GET だけを handler に差し替える (会話の GET は既定のまま) */
function sessionsGetWith(handler: () => Promise<unknown>) {
  mockGet.mockImplementation(async (requestPath: string) => (requestPath === SESSIONS_PATH ? handler() : defaultGet(requestPath)));
}

/** 会話の GET (今の相談) だけを handler に差し替える */
function messagesGetWith(handler: () => Promise<unknown>) {
  mockGet.mockImplementation(async (requestPath: string) => (requestPath === MESSAGES_PATH ? handler() : defaultGet(requestPath)));
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

/** 続けて送ると、宛先が expectedUrl (相談) であること */
async function expectNextSendGoesTo(expectedUrl: string, notUrl: string) {
  await waitFor(() => expect(screen.getByTestId('ai-input').props.editable).toBe(true));
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  fetchMock.mockRejectedValueOnce(new Error('send failed'));
  await waitFor(() => expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled());
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expectedUrl, expect.anything()));
  expect(sentUrls()).not.toContain(notUrl);
}

describe('#2272 S1 (1) 会話の読み込み (GET) の失敗', () => {
  it.each([
    ['失敗の応答', httpError, MESSAGES_LOAD_FAILED_MESSAGE],
    ['時間切れ', clientTimeout, MESSAGES_LOAD_TIMEOUT_MESSAGE],
  ] as const)('開き直しで会話の GET が %s: 履歴を残したまま理由と次の手の一文を出す (ようこその一文だけの画面にしない)', async (_label, errorOf, expected) => {
    const view = await openSheetWithHistory();
    messagesGetWith(async () => {
      throw errorOf();
    });
    await reopen(view);

    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    // 履歴は消えない (直す前はようこその一文だけの画面に置き換えた)
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
    expect(screen.queryByText(new RegExp(WELCOME_FRAGMENT))).toBeNull();
  });

  it('初めて開いたときに会話の GET が失敗: ようこその一文だけの画面にせず、理由と次の手の一文を出す', async () => {
    messagesGetWith(async () => {
      throw httpError();
    });
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(MESSAGES_LOAD_FAILED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(new RegExp(WELCOME_FRAGMENT))).toBeNull();
  });

  it('別の相談に切り替えて会話の GET が失敗: 理由と次の手の一文を出し、前の相談の会話を切り替えた先の会話のように残さない', async () => {
    await openSheetWithHistory();
    mockGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === OTHER_MESSAGES_PATH) throw httpError();
      return defaultGet(requestPath);
    });
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });

    await waitFor(() => expect(screen.getByText(MESSAGES_LOAD_FAILED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(HISTORY_REPLY)).toBeNull();
    expect(screen.queryByText(new RegExp(WELCOME_FRAGMENT))).toBeNull();
  });
});

describe('#2272 S1 (1) 開いたときの読み込みの失敗', () => {
  it.each([
    ['失敗の応答', httpError, SESSIONS_LOAD_FAILED_MESSAGE],
    ['時間切れ', clientTimeout, SESSIONS_LOAD_TIMEOUT_MESSAGE],
  ] as const)('開き直しで一覧の GET が %s: 会話を残したまま一覧を読めなかった一文を出し、一覧の画面にも出す', async (_label, errorOf, expected) => {
    const view = await openSheetWithHistory();
    sessionsGetWith(async () => {
      throw errorOf();
    });
    await reopen(view);

    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
    expect(screen.queryByText(new RegExp(WELCOME_FRAGMENT))).toBeNull();
    // 一覧の画面 (会話を出さない) にも同じ一文を出す
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    expect(screen.getByTestId('ai-sessions-load-failure')).toHaveTextContent(expected);
  });

  it('一覧の GET の失敗のあと、一覧を読めたら一覧の画面の一文は外れる', async () => {
    const view = await openSheetWithHistory();
    sessionsGetWith(async () => {
      throw httpError();
    });
    await reopen(view);
    await waitFor(() => expect(screen.getByText(SESSIONS_LOAD_FAILED_MESSAGE)).toBeTruthy());

    mockGet.mockImplementation(defaultGet);
    await reopen(view);
    await waitFor(() => expect(screen.queryByText(SESSIONS_LOAD_FAILED_MESSAGE)).toBeNull());
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    expect(screen.queryByTestId('ai-sessions-load-failure')).toBeNull();
  });

  it.each([
    ['失敗の応答', httpError, SESSION_CREATE_FAILED_MESSAGE],
    ['時間切れ', clientTimeout, SESSION_CREATE_TIMEOUT_MESSAGE],
  ] as const)('相談が無く、開いたときの作成が %s: 理由と次の手の一文を出す', async (_label, errorOf, expected) => {
    sessionsGetWith(async () => ({ sessions: [] }));
    mockPost.mockRejectedValue(errorOf());
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    expect(alertCalls()).toHaveLength(0);
  });

  it('相談が無く、開いたときの作成が緊急停止・メンテナンス中の 503: その固定の文を出す (『少し待ってから』と出さない)', async () => {
    const unavailableMessage = 'ただいま AI 相談を一時停止しています。';
    sessionsGetWith(async () => ({ sessions: [] }));
    mockPost.mockRejectedValue(new ServiceUnavailableError(unavailableMessage));
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(unavailableMessage)).toBeTruthy());
    expect(screen.queryByText(SESSION_CREATE_FAILED_MESSAGE)).toBeNull();
  });
});

describe('#2272 S1 (2) 「新しい相談を始める」の作成と一覧の失敗を分ける', () => {
  it('作れたが一覧の読み直しだけが失敗: 『作成に失敗』と言わず、新しい相談を出して一覧を読めなかった一文を出す', async () => {
    await openSheetWithHistory();
    sessionsGetWith(async () => {
      throw httpError();
    });
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-new-session'));
    });

    await waitFor(() => expect(screen.getByText(SESSIONS_LOAD_FAILED_MESSAGE)).toBeTruthy());
    expect(alertCalls().some(([, message]) => message === OLD_CREATE_FAILED_ALERT)).toBe(false);
    expect(screen.queryByText(HISTORY_REPLY)).toBeNull();
    expect(screen.getByText(new RegExp(WELCOME_FRAGMENT))).toBeTruthy();
    // 新しい相談は出ている (続けて送ると新しい相談へ送る)
    await expectNextSendGoesTo(NEW_SESSION_SEND_URL, OLD_SESSION_SEND_URL);
  });

  it('作成が失敗: Alert ではなく、会話の画面に戻って今の会話のまま作成の失敗の一文を出す', async () => {
    await openSheetWithHistory();
    mockPost.mockRejectedValue(httpError());
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-new-session'));
    });

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_FAILED_MESSAGE)).toBeTruthy());
    expect(alertCalls()).toHaveLength(0);
    expect(screen.getByText(HISTORY_REPLY)).toBeTruthy();
  });
});

describe('#2272 S1 (2) アーカイブのあとの作成と一覧の失敗', () => {
  /** アーカイブを押す (/close は ok・要約なし) */
  async function pressArchiveAccepted() {
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));
  }

  it('作成が失敗: 先に一覧を読み直して閉じた相談の status を反映し (アーカイブのボタンが止まる)、作成の失敗の一文だけを出す', async () => {
    await openSheetWithHistory();
    const listReadsBefore = sessionListReads().length;
    // アーカイブのあとの一覧では、閉じた相談は終了
    sessionsGetWith(async () => ({ sessions: [{ ...SESSION, status: 'closed' }, OTHER_SESSION] }));
    mockPost.mockRejectedValue(httpError());
    await pressArchiveAccepted();

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_FAILED_MESSAGE)).toBeTruthy());
    // 一覧は作成より先に読み直した
    expect(sessionListReads().length).toBeGreaterThan(listReadsBefore);
    const firstListReadAfterArchive = mockGet.mock.invocationCallOrder[mockGet.mock.calls.indexOf(sessionListReads()[listReadsBefore])];
    expect(firstListReadAfterArchive).toBeLessThan(mockPost.mock.invocationCallOrder[0]);
    // 閉じた相談の status が一覧に反映され、アーカイブのボタンは止まる (直す前は active のまま押せた)
    await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).toBeDisabled());
    expect(alertCalls()).toHaveLength(0);
    expect(screen.queryByText(SESSIONS_LOAD_FAILED_MESSAGE)).toBeNull();
    expect(createCalls()).toHaveLength(1);
  });

  it('作れたが一覧の読み直しが失敗: 『作成に失敗』と言わず、新しい相談を出して一覧を読めなかった一文を出す', async () => {
    await openSheetWithHistory();
    sessionsGetWith(async () => {
      throw clientTimeout();
    });
    await pressArchiveAccepted();

    await waitFor(() => expect(screen.getByText(SESSIONS_LOAD_TIMEOUT_MESSAGE)).toBeTruthy());
    expect(alertCalls().some(([, message]) => message === OLD_CREATE_FAILED_ALERT)).toBe(false);
    expect(screen.queryByText(HISTORY_REPLY)).toBeNull();
    expect(createCalls()).toHaveLength(1);
    await expectNextSendGoesTo(NEW_SESSION_SEND_URL, OLD_SESSION_SEND_URL);
  });

  it('作成も一覧も失敗: 作成の失敗の一文だけを出す (一覧の一文を重ねない)', async () => {
    await openSheetWithHistory();
    sessionsGetWith(async () => {
      throw httpError();
    });
    mockPost.mockRejectedValue(httpError());
    await pressArchiveAccepted();

    await waitFor(() => expect(screen.getByText(SESSION_CREATE_FAILED_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(SESSIONS_LOAD_FAILED_MESSAGE)).toBeNull();
    expect(alertCalls()).toHaveLength(0);
  });

  it('すでにアーカイブ済み (400) で一覧の読み直しも失敗: 古い一覧のままなので、一覧を読めなかった一文を出す', async () => {
    await openSheetWithHistory();
    sessionsGetWith(async () => {
      throw httpError();
    });
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 400, json: async () => ({ error: 'already closed' }) }));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });

    await waitFor(() => expect(screen.getByText(SESSIONS_LOAD_FAILED_MESSAGE)).toBeTruthy());
    expect(alertCalls()).toContainEqual(['情報', 'このセッションは既にアーカイブ済みです。']);
  });
});
