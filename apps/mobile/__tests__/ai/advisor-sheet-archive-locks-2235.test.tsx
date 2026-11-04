/**
 * #2235 I7: アーカイブの /close の応答待ちの間に送信・新しい相談・相談の切り替えができた / 送信中にアーカイブできた (回帰テスト)。
 *
 * 直す前: 送信 (sendMessage)・新しい相談 (ボタンの onPress)・相談の切り替え (selectSession) の入口と描画の disabled は
 * アーカイブの応答待ち (closingSessionRef / isClosingSession) を見ず、アーカイブの入口と描画の disabled は送信中
 * (sendingRef / sending) を見なかった。
 *   (a) 応答待ちの間に送った文は閉じる側の相談へ送られ、アーカイブのあとの新しい相談で画面から消えた
 *   (b) 応答待ちの間に「新しい相談を始める」を押すと、アーカイブの作成と合わせて相談が 2 つ作られた
 *   (c) 応答待ちの間に選んだ相談が、アーカイブのあとの新しい相談で上書きされた
 *   (2) 送信中にアーカイブすると、送信の返答は閉じた相談にだけ保存され、新しい相談の画面には出なかった
 * いまはどれもハンドラの入口 (ref) と描画の disabled の両側で止め、アーカイブ・送信が終われば (成功・失敗・例外のどれでも) 下りる。
 * 経路ごとに「描画の側」(ボタンが止まる) と「ハンドラの側」(止める描画の前に、同じ描画のうちに押す) を確かめる。
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

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const OTHER_SESSION = { id: 'session-other', title: 'AI相談', messageCount: 1, status: 'closed' };
const NEW_SESSION = { id: 'session-new', title: 'AI相談', messageCount: 0, status: 'active' };
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const OTHER_MESSAGES_PATH = `/api/ai/consultation/sessions/${OTHER_SESSION.id}/messages`;
const CLOSE_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/close`;
const OLD_SESSION_SEND_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/messages?stream=true`;
const NEW_SESSION_SEND_URL = `http://localhost:3000/api/ai/consultation/sessions/${NEW_SESSION.id}/messages?stream=true`;
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];
const OTHER_MESSAGES = [
  { id: 'o1', role: 'assistant', content: '前の相談の返答です', createdAt: '2026-10-07T00:00:01.000Z' },
];
const SENT_TEXT = '今夜の夕食を1食作って';
const SUMMARY_TEXT = '夕飯に野菜を足す相談でした';
const SUMMARY_LINE = `📝 相談を要約しました：\n\n${SUMMARY_TEXT}`;
const CREATE_SESSION_ARGS = ['/api/ai/consultation/sessions', { title: 'AI相談' }] as const;

const fetchMock = jest.fn();

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 開いたときの今の相談の会話 (空ならウェルカムだけになり、クイック質問が出る) */
let currentMessages: typeof OLD_MESSAGES = OLD_MESSAGES;

beforeEach(() => {
  jest.clearAllMocks();
  currentMessages = OLD_MESSAGES;
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string) => {
    if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION, OTHER_SESSION] };
    if (requestPath === MESSAGES_PATH) return { messages: currentMessages };
    if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
    throw new Error(`unexpected GET ${requestPath}`);
  });
  mockPost.mockResolvedValue({ success: true, session: { id: NEW_SESSION.id } });
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockImplementation(() => ({ eq: mockEq }));
  mockEq.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function openSheet() {
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  if (currentMessages.length > 0) {
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
  } else {
    await waitFor(() => expect(screen.getByTestId('ai-quick-0')).toBeTruthy());
  }
  await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
}

type CloseOutcome = 'success' | 'failure' | 'exception';

/** /close の応答を release まで返さない (要約の LLM を待つあいだ)。outcome で応答の形を選ぶ */
function holdCloseResponse(outcome: CloseOutcome = 'success') {
  const close = gate();
  fetchMock.mockImplementationOnce(async () => {
    await close.promise;
    if (outcome === 'exception') throw new TypeError('Network request failed');
    if (outcome === 'failure') return { ok: false, status: 500, json: async () => ({ error: 'failed' }) };
    return { ok: true, status: 200, json: async () => ({ summary: { summary: SUMMARY_TEXT } }) };
  });
  return close;
}

async function pressArchiveAndWaitClosePosted() {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));
}

const sentUrls = () => fetchMock.mock.calls.map(([url]) => url);
const createSessionCalls = () =>
  mockPost.mock.calls.filter(([path, body]) => path === CREATE_SESSION_ARGS[0] && JSON.stringify(body) === JSON.stringify(CREATE_SESSION_ARGS[1]));

/** アーカイブの応答を返し、新しい相談が 1 つだけ作られ、要約の一文が出たことを確かめる */
async function releaseCloseAndExpectNewSession(close: { release: () => void }) {
  await act(async () => {
    close.release();
  });
  await waitFor(() => expect(screen.getByText(SUMMARY_LINE)).toBeTruthy());
  expect(createSessionCalls()).toHaveLength(1);
}

describe('#2235 I7 (a) アーカイブの応答待ちの間は送らない', () => {
  it('描画の側: 入力欄・送信ボタンが止まり、押しても閉じる側の相談へ送らない。応答のあと送った文は消えず入力欄に残る', async () => {
    await openSheet();
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    const close = holdCloseResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await pressArchiveAndWaitClosePosted();

    expect(screen.getByTestId('ai-send-btn')).toBeDisabled();
    expect(screen.getByTestId('ai-input').props.editable).toBe(false);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    expect(sentUrls()).not.toContain(OLD_SESSION_SEND_URL);

    await releaseCloseAndExpectNewSession(close);
    expect(sentUrls()).not.toContain(OLD_SESSION_SEND_URL);
    expect(screen.getByTestId('ai-input').props.value).toBe(SENT_TEXT);
  });

  it('ハンドラの側: アーカイブと同じ描画のうちに送信を押しても (止める描画の前)、閉じる側の相談へ送らない', async () => {
    await openSheet();
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    const close = holdCloseResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    await pressArchiveAndWaitClosePosted();

    await releaseCloseAndExpectNewSession(close);
    expect(sentUrls()).not.toContain(OLD_SESSION_SEND_URL);
    expect(sentUrls()).not.toContain(NEW_SESSION_SEND_URL);
    // 送らなかったので、送った文は画面から消えず入力欄に残る
    expect(screen.getByTestId('ai-input').props.value).toBe(SENT_TEXT);
  });

  it('クイック質問: 描画の側でもハンドラの側でも、アーカイブの応答待ちの間は送らない', async () => {
    currentMessages = [];
    await openSheet();
    const close = holdCloseResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
      fireEvent.press(screen.getByTestId('ai-quick-0'));
    });
    await pressArchiveAndWaitClosePosted();
    expect(screen.getByTestId('ai-quick-0')).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-quick-1'));
    });
    expect(sentUrls()).not.toContain(OLD_SESSION_SEND_URL);

    await releaseCloseAndExpectNewSession(close);
    expect(sentUrls()).not.toContain(OLD_SESSION_SEND_URL);
    expect(sentUrls()).not.toContain(NEW_SESSION_SEND_URL);
  });
});

describe('#2235 I7 (b) アーカイブの応答待ちの間は新しい相談を始めない', () => {
  it('描画の側: 「新しい相談を始める」が止まり、押しても相談は 1 つしか作られない', async () => {
    await openSheet();
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    const close = holdCloseResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await pressArchiveAndWaitClosePosted();

    expect(screen.getByTestId('ai-new-session')).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-new-session'));
    });
    expect(createSessionCalls()).toHaveLength(0);

    await releaseCloseAndExpectNewSession(close);
  });

  it('ハンドラの側: アーカイブと同じ描画のうちに押しても、相談は 1 つしか作られない', async () => {
    await openSheet();
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    const close = holdCloseResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
      fireEvent.press(screen.getByTestId('ai-new-session'));
    });
    await pressArchiveAndWaitClosePosted();
    expect(createSessionCalls()).toHaveLength(0);

    await releaseCloseAndExpectNewSession(close);
  });
});

describe('#2235 I7 (c) アーカイブの応答待ちの間は相談を切り替えない', () => {
  it('描画の側: 相談の行が止まり、押しても切り替えない。応答のあとは新しい相談が今の相談', async () => {
    await openSheet();
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    const close = holdCloseResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await pressArchiveAndWaitClosePosted();

    expect(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`)).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });
    expect(mockGet).not.toHaveBeenCalledWith(OTHER_MESSAGES_PATH);

    await releaseCloseAndExpectNewSession(close);
    expect(mockGet).not.toHaveBeenCalledWith(OTHER_MESSAGES_PATH);
    expect(screen.queryByText('前の相談の返答です')).toBeNull();
  });

  it('ハンドラの側: アーカイブと同じ描画のうちに相談を選んでも、切り替えない (直す前は、選んだ相談が応答のあとの新しい相談で上書きされた)', async () => {
    await openSheet();
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    const close = holdCloseResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });
    await pressArchiveAndWaitClosePosted();
    expect(mockGet).not.toHaveBeenCalledWith(OTHER_MESSAGES_PATH);

    await releaseCloseAndExpectNewSession(close);
    expect(mockGet).not.toHaveBeenCalledWith(OTHER_MESSAGES_PATH);
  });
});

/** 送信の応答を release まで返さず、そのあと通信の失敗で終える (送信の失敗の Alert で終わる) */
function holdSendResponse() {
  const send = gate();
  fetchMock.mockImplementationOnce(async () => {
    await send.promise;
    throw new Error('send failed');
  });
  return send;
}

describe('#2235 I7 (2) 送信中はアーカイブしない', () => {
  it('描画の側: 送信中はアーカイブのボタンが止まり、押しても /close を送らない。送信が終わればまた押せる', async () => {
    await openSheet();
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    const send = holdSendResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(OLD_SESSION_SEND_URL, expect.anything()));

    expect(screen.getByTestId('ai-archive-btn')).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    expect(sentUrls()).not.toContain(CLOSE_URL);

    await act(async () => {
      send.release();
    });
    await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
    expect(sentUrls()).not.toContain(CLOSE_URL);
  });

  it('ハンドラの側: 送信と同じ描画のうちにアーカイブを押しても (止める描画の前)、/close を送らない', async () => {
    await openSheet();
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    const send = holdSendResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(OLD_SESSION_SEND_URL, expect.anything()));
    expect(sentUrls()).not.toContain(CLOSE_URL);

    await act(async () => {
      send.release();
    });
    await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
    expect(sentUrls()).not.toContain(CLOSE_URL);
    expect(createSessionCalls()).toHaveLength(0);
  });
});

describe('#2235 I7 対照: アーカイブが終われば (成功・失敗・例外のどれでも) 止めたままにしない', () => {
  it.each<CloseOutcome>(['success', 'failure', 'exception'])(
    'アーカイブの応答 (%s) のあと、入力欄・送信・新しい相談・相談の切り替え・アーカイブをまた押せる',
    async (outcome) => {
      await openSheet();
      fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
      const close = holdCloseResponse(outcome);
      await act(async () => {
        fireEvent.press(screen.getByTestId('ai-archive-btn'));
      });
      await pressArchiveAndWaitClosePosted();
      expect(screen.getByTestId('ai-new-session')).toBeDisabled();
      expect(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`)).toBeDisabled();

      await act(async () => {
        close.release();
      });
      await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
      // 成功のときは、アーカイブの側で作った新しい相談の会話の画面に戻っているので、相談の一覧を開き直す
      if (screen.queryByTestId('ai-new-session') === null) fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
      await waitFor(() => expect(screen.getByTestId('ai-new-session')).not.toBeDisabled());
      expect(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`)).not.toBeDisabled();
      // 成功のときだけアーカイブの側で新しい相談を 1 つ作る (失敗・例外では作らない)
      expect(createSessionCalls()).toHaveLength(outcome === 'success' ? 1 : 0);

      // 新しい相談を手で始められる
      await act(async () => {
        fireEvent.press(screen.getByTestId('ai-new-session'));
      });
      await waitFor(() => expect(createSessionCalls()).toHaveLength(outcome === 'success' ? 2 : 1));

      // 会話の画面に戻ると、入力欄が使え、送れる
      await waitFor(() => expect(screen.getByTestId('ai-input').props.editable).toBe(true));
      fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
      fetchMock.mockRejectedValueOnce(new Error('send failed'));
      await waitFor(() => expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled());
      await act(async () => {
        fireEvent.press(screen.getByTestId('ai-send-btn'));
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(NEW_SESSION_SEND_URL, expect.anything()));
    },
  );
});
