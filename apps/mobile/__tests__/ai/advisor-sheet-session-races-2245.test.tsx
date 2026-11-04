/**
 * #2245 K1: AI 相談のシート (AIAdvisorSheet) の会話の読み込みの取り違えと、1日献立変更の止め (回帰テスト)。
 * Web の AIChatBubble は tests/ai-chat-bubble-session-races-2245.test.tsx が同じ決まりを確かめる。
 *
 * 直す前:
 *   1. 会話の読み込み (loadMessages) は await のあと、今出している相談の応答かを確かめずに画面の会話を置き換えた。
 *      (a) 相談を A→B と切り替えたあとに遅れて返った A の会話が、B の画面に出た
 *      (b) 切り替えの直後にアーカイブすると、アーカイブのあとの新しい相談の画面に、遅れて返った閉じた相談の会話が出た
 *      (c) アーカイブの応答待ちの間にシートを閉じて開き直すと、開き直し (initSession) がアーカイブの応答待ちを見ずに読み込み、
 *          アーカイブのあとの新しい相談の画面を、閉じた相談の会話で上書きした (一覧を待つ間にアーカイブしたときも同じ)
 *   2. 「1日献立変更」に disabled が無く、送信中・アーカイブの応答待ちの間も押せた。モーダルの「作成する」も止めなかった
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
import { AIDayMenuModal } from '../../src/components/ai/AIDayMenuModal';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
// アーカイブできる (closed でない) もう 1 つの相談。開いたときは先に並ぶ SESSION が出る
const OTHER_SESSION = { id: 'session-other', title: '別の相談', messageCount: 1, status: 'active' };
const NEW_SESSION_ID = 'session-new';
const SESSIONS_PATH = '/api/ai/consultation/sessions?status=all';
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const OTHER_MESSAGES_PATH = `/api/ai/consultation/sessions/${OTHER_SESSION.id}/messages`;
const closeUrlOf = (sessionId: string) => `http://localhost:3000/api/ai/consultation/sessions/${sessionId}/close`;
const SEND_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/messages?stream=true`;
const MAIN_REPLY_TEXT = '野菜を足しましょう';
const MAIN_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: MAIN_REPLY_TEXT, createdAt: '2026-10-08T00:00:01.000Z' },
];
const OTHER_REPLY_TEXT = '別の相談の返答です';
const OTHER_MESSAGES = [{ id: 'o1', role: 'assistant', content: OTHER_REPLY_TEXT, createdAt: '2026-10-07T00:00:01.000Z' }];
const SENT_TEXT = '今夜の夕食を1食作って';
const DAY_MENU_GENERATE_PATH = '/api/ai/menu/v4/generate';

const fetchMock = jest.fn();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 決まった GET を一度だけ待たせる (path → 待たせる応答) */
let heldGets: Map<string, Deferred<unknown>>;

function holdGet<T>(requestPath: string): Deferred<T> {
  const pending = deferred<T>();
  heldGets.set(requestPath, pending as Deferred<unknown>);
  return pending;
}

beforeEach(() => {
  jest.clearAllMocks();
  heldGets = new Map();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ summary: null }) }));
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string) => {
    const held = heldGets.get(requestPath);
    if (held) {
      heldGets.delete(requestPath);
      return held.promise;
    }
    if (requestPath.startsWith(SESSIONS_PATH)) return { sessions: [SESSION, OTHER_SESSION] };
    if (requestPath === MESSAGES_PATH) return { messages: MAIN_MESSAGES };
    if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
    throw new Error(`unexpected GET ${requestPath}`);
  });
  mockPost.mockImplementation(async (requestPath: string) => {
    if (requestPath === DAY_MENU_GENERATE_PATH) return { status: 'processing', requestId: 'req-1' };
    return { success: true, session: { id: NEW_SESSION_ID } };
  });
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockImplementation(() => ({ eq: mockEq }));
  mockEq.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const getCount = (requestPath: string) => mockGet.mock.calls.filter(([p]) => p === requestPath).length;
const sessionsGetCount = () => mockGet.mock.calls.filter(([p]) => typeof p === 'string' && p.startsWith(SESSIONS_PATH)).length;
const dayMenuGenerateCalls = () => mockPost.mock.calls.filter(([p]) => p === DAY_MENU_GENERATE_PATH);

/** シートを開き、今の相談の会話が出てアーカイブを押せるまで待つ */
async function openSheet() {
  const view = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText(MAIN_REPLY_TEXT)).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
  return view;
}

/** /close の応答を返すまで待たせる (ok の応答) */
function holdClose() {
  const pending = deferred<void>();
  fetchMock.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, status: 200, json: async () => ({ summary: null }) };
  });
  return pending;
}

async function pressArchive(sessionId = SESSION.id) {
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-archive-btn'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(closeUrlOf(sessionId), expect.objectContaining({ method: 'POST' })));
}

/** アーカイブのあとの新しい相談 (ウェルカムだけ。クイック質問が出る) になるまで待つ */
async function waitForNewSession() {
  await waitFor(() => expect(screen.getByTestId('ai-quick-0')).toBeTruthy());
}

async function selectOtherSession() {
  fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
  await act(async () => {
    fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
  });
}

/** 返し終えた待ちの続き (setState) を流す */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('#2245 K1 1 会話の読み込みは、返ったときに今出している相談のものだけを画面に置く', () => {
  it('(a) A→B と切り替えたあとに遅れて返った A の会話を、B の画面に出さない', async () => {
    const mainLoad = holdGet<{ messages: typeof MAIN_MESSAGES }>(MESSAGES_PATH);
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(getCount(MESSAGES_PATH)).toBe(1));

    await selectOtherSession();
    await waitFor(() => expect(screen.getByText(OTHER_REPLY_TEXT)).toBeTruthy());

    await act(async () => {
      mainLoad.resolve({ messages: MAIN_MESSAGES });
    });
    await flush();

    expect(screen.getByText(OTHER_REPLY_TEXT)).toBeTruthy();
    expect(screen.queryByText(MAIN_REPLY_TEXT)).toBeNull();
  });

  it('(b) 切り替えの直後にアーカイブすると、アーカイブのあとの新しい相談の画面に、遅れて返った閉じた相談の会話を出さない', async () => {
    await openSheet();
    const otherLoad = holdGet<{ messages: typeof OTHER_MESSAGES }>(OTHER_MESSAGES_PATH);
    await selectOtherSession();
    await waitFor(() => expect(getCount(OTHER_MESSAGES_PATH)).toBe(1));

    await pressArchive(OTHER_SESSION.id);
    await waitForNewSession();

    await act(async () => {
      otherLoad.resolve({ messages: OTHER_MESSAGES });
    });
    await flush();

    expect(screen.getByTestId('ai-quick-0')).toBeTruthy();
    expect(screen.queryByText(OTHER_REPLY_TEXT)).toBeNull();
  });

  it('(c) アーカイブの応答待ちの間にシートを閉じて開き直しても、開き直しは読み込まず、アーカイブのあとの新しい相談の画面のまま', async () => {
    const view = await openSheet();
    const close = holdClose();
    await pressArchive();
    // 開き直しの読み込みが走っても (直す前)、その会話はアーカイブの応答のあとまで返らないようにする
    const reopenLoad = holdGet<{ messages: typeof MAIN_MESSAGES }>(MESSAGES_PATH);
    const sessionsBefore = sessionsGetCount();
    const messagesBefore = getCount(MESSAGES_PATH);

    view.rerender(<AIAdvisorSheet visible={false} onClose={jest.fn()} />);
    view.rerender(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await flush();
    expect(sessionsGetCount()).toBe(sessionsBefore);
    expect(getCount(MESSAGES_PATH)).toBe(messagesBefore);

    await act(async () => {
      close.resolve();
    });
    await waitForNewSession();
    await act(async () => {
      reopenLoad.resolve({ messages: MAIN_MESSAGES });
    });
    await flush();

    expect(screen.getByTestId('ai-quick-0')).toBeTruthy();
    expect(screen.queryByText(MAIN_REPLY_TEXT)).toBeNull();
  });

  it('(c) 開き直しの一覧を待つ間にアーカイブしたら、一覧のあとも出す相談を変えず、会話も読み込まない', async () => {
    const view = await openSheet();
    view.rerender(<AIAdvisorSheet visible={false} onClose={jest.fn()} />);
    const sessionsBefore = sessionsGetCount();
    const reopenSessions = holdGet<{ sessions: Array<typeof SESSION> }>(SESSIONS_PATH);
    view.rerender(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(sessionsGetCount()).toBe(sessionsBefore + 1));
    const messagesBefore = getCount(MESSAGES_PATH);

    // 一覧を待つ間にアーカイブする (応答はすぐ返り、アーカイブのあとの新しい相談になる)
    await pressArchive();
    await waitForNewSession();

    await act(async () => {
      reopenSessions.resolve({ sessions: [SESSION] });
    });
    await flush();

    expect(getCount(MESSAGES_PATH)).toBe(messagesBefore);
    expect(screen.getByTestId('ai-quick-0')).toBeTruthy();
    expect(screen.queryByText(MAIN_REPLY_TEXT)).toBeNull();
  });

  it('対照: 切り替えた相談の会話は、その相談を出している間に返れば画面に出る', async () => {
    await openSheet();
    const otherLoad = holdGet<{ messages: typeof OTHER_MESSAGES }>(OTHER_MESSAGES_PATH);
    await selectOtherSession();
    await act(async () => {
      otherLoad.resolve({ messages: OTHER_MESSAGES });
    });
    await waitFor(() => expect(screen.getByText(OTHER_REPLY_TEXT)).toBeTruthy());
    expect(screen.queryByText(MAIN_REPLY_TEXT)).toBeNull();
  });
});

describe('#2245 K1 2 「1日献立変更」は送信中・アーカイブの応答待ちの間は止める', () => {
  it('描画の側: アーカイブの応答待ちの間はボタンが止まり、押してもモーダルを開かない。応答のあとまた押せる', async () => {
    await openSheet();
    expect(screen.getByTestId('ai-day-menu-btn')).not.toBeDisabled();
    const close = holdClose();
    await pressArchive();

    expect(screen.getByTestId('ai-day-menu-btn')).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-day-menu-btn'));
    });
    expect(screen.queryByText('作成する')).toBeNull();

    await act(async () => {
      close.resolve();
    });
    await waitForNewSession();
    await waitFor(() => expect(screen.getByTestId('ai-day-menu-btn')).not.toBeDisabled());
  });

  it('描画の側: 送信中はボタンが止まる', async () => {
    await openSheet();
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    const send = deferred<void>();
    fetchMock.mockImplementationOnce(async () => {
      await send.promise;
      throw new Error('send failed');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(SEND_URL, expect.anything()));

    expect(screen.getByTestId('ai-day-menu-btn')).toBeDisabled();

    await act(async () => {
      send.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('ai-day-menu-btn')).not.toBeDisabled());
  });

  it('入口の側: アーカイブと同じ描画のうちに押しても (止める描画の前)、モーダルを開かない', async () => {
    await openSheet();
    const close = holdClose();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
      fireEvent.press(screen.getByTestId('ai-day-menu-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(closeUrlOf(SESSION.id), expect.anything()));
    expect(screen.queryByText('作成する')).toBeNull();

    await act(async () => {
      close.resolve();
    });
    await waitForNewSession();
  });

  it('対照: 止めていない間は、ボタンでモーダルが開く', async () => {
    await openSheet();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-day-menu-btn'));
    });
    await waitFor(() => expect(screen.getByText('作成する')).toBeTruthy());
  });
});

describe('#2245 K1 2 1日献立のモーダルの「作成する」は、開いた側が止めている間は作らない', () => {
  it('isStartBlocked が真なら、作成を依頼しない', async () => {
    render(<AIDayMenuModal visible onClose={jest.fn()} onAiConsentRequired={jest.fn()} isStartBlocked={() => true} />);
    await act(async () => {
      fireEvent.press(screen.getByText('作成する'));
    });
    await flush();
    expect(dayMenuGenerateCalls()).toHaveLength(0);
  });

  it('対照: isStartBlocked が偽 (または無い) なら作成を依頼する', async () => {
    render(<AIDayMenuModal visible onClose={jest.fn()} onAiConsentRequired={jest.fn()} isStartBlocked={() => false} />);
    await act(async () => {
      fireEvent.press(screen.getByText('作成する'));
    });
    await waitFor(() => expect(dayMenuGenerateCalls()).toHaveLength(1));
  });
});
