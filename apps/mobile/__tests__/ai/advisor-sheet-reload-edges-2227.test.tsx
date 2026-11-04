/**
 * #2227 H1: AI 相談シート (AIAdvisorSheet) の取り直しの残りの縁 (回帰テスト)。
 *
 * 直す前:
 *   1. サーバーが失敗の行も DB に書けず {error, code} だけを送ると、その行を読み捨てて取り直し、返答が無いので
 *      『返答を作っているところかもしれません…もう一度「最新の会話を読み込む」を押して』を出し続けた (押しても返答は来ない)
 *   2. 取り直しの GET は /api/ai/ の下なので既定の 120 秒を待ち、GET が詰まると『送信中』で入力欄が止まった
 *      (Web は 10 秒)。取り直しのあとの提案の記録の直読みにも上限が無かった
 *   3. 応答を受ける前の時間切れで送った文が見つからないと、『届いていませんでした』と言い切った (Web は『確かめられませんでした』)
 *   4. 送信中・取り直しの最中に別の相談へ切り替えると、前の相談の会話と送った文を今の画面に書いた
 *   5. (R1 の指摘) 届いているが返答がまだ無いと分かったあと「最新の会話を読み込む」をもう一度押すと、1 回目でこの送信に当てた
 *      保存行を除いて探し、届いていた送信を『届いていません』と取り違えた (入力欄に送った文を戻し、Alert を出した)
 *   6. (R1 の指摘) 本文を流している最中に相談を切り替えると、前の相談の返答の断片が今の画面に流れ、finalData が来ても消えずに残った。
 *   7. (R2 の指摘) まだ確かめていない時間切れの送信の案内を、相談の切り替え・新しい相談で外すとき、確かめられなかった送信として
 *      覚えなかった。相談を開き直した取り直しがこの送信を知らず、送った文が保存済みでも入力欄に戻した文が消えなかった
 *      (そのまま送ると同じ相談に二重に届く。Web は入力欄に戻すときに必ず覚える)
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
  AI_CHAT_RELOAD_TIMEOUT_MS,
  PREVIOUS_REQUEST_EXECUTED_MESSAGE,
  REPLY_FAILED_MESSAGE,
  TIMEOUT_DELIVERED_NO_REPLY_MESSAGE,
  TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE,
  TIMEOUT_DELIVERY_UNCONFIRMED_TITLE,
  TIMEOUT_NOT_DELIVERED_MESSAGE,
} from '../../src/lib/ai-chat-timeout';
import {
  resetAiConsultationDataChangedListenersForTests,
  subscribeAiConsultationDataChanged,
} from '../../src/lib/ai-consultation-data-changed';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const OTHER_SESSION = { id: 'session-2', title: '別の相談', messageCount: 1, status: 'closed' };
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const OTHER_MESSAGES_PATH = `/api/ai/consultation/sessions/${OTHER_SESSION.id}/messages`;
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];
const OTHER_MESSAGES = [{ id: 'o1', role: 'assistant', content: '別の相談の返答です', createdAt: '2026-10-09T00:00:00.000Z' }];
const SENT_TEXT = '今夜の夕食を1食作って';
const SAVED_USER = { id: 'm3', role: 'user', content: SENT_TEXT, createdAt: '2026-11-01T00:00:00.000Z' };
const SAVED_REPLY = '鶏むね肉の照り焼きで1食作りますね';
const SAVED_MESSAGES = [
  ...OLD_MESSAGES,
  SAVED_USER,
  { id: 'm4', role: 'assistant', content: SAVED_REPLY, proposedActions: null, createdAt: '2026-11-01T00:00:01.000Z' },
];
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const REPLY_FAILED_TEXT = '応答に失敗しました。再試行してください。';

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();
const encoder = new TextEncoder();

let serverMessages: unknown[] = OLD_MESSAGES;

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsultationDataChangedListenersForTests();
  serverMessages = OLD_MESSAGES;
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string) => {
    if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION, OTHER_SESSION] };
    if (requestPath === MESSAGES_PATH) return { messages: serverMessages };
    if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
    throw new Error(`unexpected GET ${requestPath}`);
  });
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockImplementation(() => ({ eq: mockEq }));
  mockEq.mockResolvedValue({ data: [], error: null });
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

const inputValue = () => screen.getByTestId('ai-input').props.value as string;

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** 本文の行 (SSE の data) を順に 1 つずつ流して終わる、受け付けられた応答 */
function streamsLines(lines: unknown[]) {
  const chunks = lines.map((line) => encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
        cancel: async () => undefined,
      }),
    },
    text: async () => '',
  };
}

/**
 * 本文の行 (SSE の data) を順に流す、受け付けられた応答。gate のある行は、gate が解けるまで読み取りを返さない
 * (流れの途中で相談を切り替えるため)
 */
function streamsGatedLines(steps: { line: unknown; gate?: Promise<void> }[]) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= steps.length) return { done: true, value: undefined };
          const step = steps[index++];
          if (step.gate) await step.gate;
          return { done: false, value: encoder.encode(`data: ${JSON.stringify(step.line)}\n\n`) };
        },
        cancel: async () => undefined,
      }),
    },
    text: async () => '',
  };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const SERVER_ERROR_ONLY_LINE = { error: 'サーバーでエラーが発生しました', code: 'INTERNAL_ERROR' };

describe('#2227 H1 サーバーが失敗の行も書けずに error だけを送った', () => {
  it('取り直して送った文はあるが返答が無ければ、『返答を作っているところ』の案内ではなく失敗の文を出す', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => {
      // サーバーは送った文を保存したが、返答の行は書けなかった
      serverMessages = [...OLD_MESSAGES, SAVED_USER];
      return streamsLines([SERVER_ERROR_ONLY_LINE]);
    });
    await send();

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('エラー', REPLY_FAILED_MESSAGE));
    expect(REPLY_FAILED_MESSAGE).toBe(REPLY_FAILED_TEXT);
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(screen.queryByText(TIMEOUT_DELIVERED_NO_REPLY_MESSAGE)).toBeNull();
    expect(screen.getByText(SENT_TEXT)).toBeTruthy();
  });

  it('会話も取り直せなければ、失敗の文を出して送った文を入力欄に戻す (取り直しの導線は出さない)', async () => {
    await openSheet();
    mockGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === MESSAGES_PATH) throw new Error('Network request failed');
      return { sessions: [SESSION, OTHER_SESSION] };
    });
    fetchMock.mockResolvedValueOnce(streamsLines([SERVER_ERROR_ONLY_LINE]));
    await send();

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('エラー', REPLY_FAILED_MESSAGE));
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(inputValue()).toBe(SENT_TEXT);
  });

  it('error の行が無いまま流れが切れて返答がまだ無ければ、今までどおり返答を待つ案内を出す (上の対照)', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => {
      serverMessages = [...OLD_MESSAGES, SAVED_USER];
      return streamsLines([]);
    });
    await send();

    await waitFor(() => expect(screen.getByText(TIMEOUT_DELIVERED_NO_REPLY_MESSAGE)).toBeTruthy());
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('#2227 H1 取り直しの GET と記録の直読みに Web と同じ上限', () => {
  it('応答を受け取れなかったあとの取り直しの GET は AI_CHAT_RELOAD_TIMEOUT_MS で打ち切る (開いたときの読み込みは今までどおり)', async () => {
    await openSheet();
    // 開いたときの読み込みには上限を足さない
    expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH);
    mockGet.mockClear();
    fetchMock.mockImplementationOnce(async () => {
      serverMessages = SAVED_MESSAGES;
      return streamsLines([]);
    });
    await send();

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS });
    expect(AI_CHAT_RELOAD_TIMEOUT_MS).toBe(10_000);
  });

  it('「最新の会話を読み込む」の取り直しも同じ上限', async () => {
    await openSheet();
    fetchMock.mockRejectedValueOnce(abortError());
    await send();
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    mockGet.mockClear();
    serverMessages = SAVED_MESSAGES;
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS });
  });

  it('取り直しのあとの記録の読み取りが返らなければ、AI_CHAT_RELOAD_TIMEOUT_MS で打ち切って会話を出す', async () => {
    await openSheet();
    // 記録の読み取りは返らない
    mockEq.mockImplementation(() => new Promise(() => {}));
    jest.useFakeTimers();
    fetchMock.mockImplementationOnce(async () => {
      serverMessages = SAVED_MESSAGES;
      return streamsLines([]);
    });
    await send();
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(mockEq).toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(AI_CHAT_RELOAD_TIMEOUT_MS - 1);
    });
    expect(screen.queryByText(SAVED_REPLY)).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    jest.useRealTimers();
    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
  });
});

describe('#2227 H1 応答を受ける前の時間切れで送った文が見つからない', () => {
  it('『届いていませんでした』と言い切らず、確かめられなかった旨を出して入力欄の文を残す', async () => {
    await openSheet();
    fetchMock.mockRejectedValueOnce(abortError());
    await send();
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    serverMessages = OLD_MESSAGES;
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(TIMEOUT_DELIVERY_UNCONFIRMED_TITLE, TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE),
    );
    expect(alertSpy).not.toHaveBeenCalledWith('送信できませんでした', TIMEOUT_NOT_DELIVERED_MESSAGE);
    expect(inputValue()).toBe(SENT_TEXT);
  });

  it('受け付けられたあとの取り直しで送った文が見つからなければ、今までどおり『届いていませんでした』 (上の対照)', async () => {
    await openSheet();
    fetchMock.mockResolvedValueOnce(streamsLines([]));
    await send();

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('送信できませんでした', TIMEOUT_NOT_DELIVERED_MESSAGE));
    expect(inputValue()).toBe(SENT_TEXT);
  });
});

describe('#2227 H1 送信中・取り直しの最中に別の相談へ切り替えた', () => {
  async function switchToOtherSession() {
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });
    await waitFor(() => expect(screen.getByText('別の相談の返答です')).toBeTruthy());
  }

  it('取り直しの GET を待つ間に切り替えたら、前の相談の会話を今の画面に書かず、入力欄も変えない', async () => {
    await openSheet();
    let releaseReload: () => void = () => {};
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    fetchMock.mockResolvedValueOnce(streamsLines([]));
    mockGet.mockImplementation(async (requestPath: string, init?: unknown) => {
      if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION, OTHER_SESSION] };
      if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
      if (requestPath === MESSAGES_PATH && init) {
        // 応答を受け取れなかったあとの取り直し: 切り替えるまで返さない。届いていなかった (入力欄に戻す分岐)
        await reloadGate;
        return { messages: OLD_MESSAGES };
      }
      if (requestPath === MESSAGES_PATH) return { messages: OLD_MESSAGES };
      throw new Error(`unexpected GET ${requestPath}`);
    });
    await send();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));

    await switchToOtherSession();
    await act(async () => {
      releaseReload();
    });

    await waitFor(() => expect(screen.getByTestId('ai-send-btn')).toBeTruthy());
    expect(screen.getByText('別の相談の返答です')).toBeTruthy();
    expect(screen.queryByText('野菜を足しましょう')).toBeNull();
    expect(inputValue()).toBe('');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('送信の応答 (finalData) を待つ間に切り替えたら、前の相談の返答を今の画面に足さない', async () => {
    await openSheet();
    let releaseResponse: () => void = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      await responseGate;
      return streamsLines([
        {
          userMessage: { id: SAVED_USER.id, content: SENT_TEXT, createdAt: SAVED_USER.createdAt },
          aiMessage: { id: 'm4', content: SAVED_REPLY, createdAt: '2026-11-01T00:00:01.000Z' },
          actionExecuted: false,
          actionResult: null,
        },
      ]);
    });
    await send();

    await switchToOtherSession();
    await act(async () => {
      releaseResponse();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('別の相談の返答です')).toBeTruthy();
    expect(screen.queryByText(SAVED_REPLY)).toBeNull();
    expect(screen.queryByText(SENT_TEXT)).toBeNull();
  });
});

describe('#2227 H1 (R1) 届いているが返答がまだ無いと分かったあと、もう一度「最新の会話を読み込む」を押した', () => {
  const EXECUTED_LOGS = { data: [{ status: 'executed' }], error: null };

  async function pressReload() {
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
  }

  it('時間切れのあと: 2 回目で返答が届いていれば、届いていた送信として会話と前の依頼の一文を出す (Alert も入力欄の戻しもしない)', async () => {
    await openSheet();
    const changed = jest.fn();
    subscribeAiConsultationDataChanged(changed);
    fetchMock.mockRejectedValueOnce(abortError());
    await send();
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());

    serverMessages = [...OLD_MESSAGES, SAVED_USER];
    await pressReload();
    await waitFor(() => expect(screen.getByText(TIMEOUT_DELIVERED_NO_REPLY_MESSAGE)).toBeTruthy());
    expect(inputValue()).toBe('');

    serverMessages = SAVED_MESSAGES;
    mockEq.mockResolvedValue(EXECUTED_LOGS);
    await pressReload();

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeTruthy());
    expect(changed).toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(screen.getAllByText(SENT_TEXT)).toHaveLength(1);
  });

  it('時間切れのあと: 2 回目もまだ返答が無ければ、返答を待つ案内のまま (『届いていません』にしない)', async () => {
    await openSheet();
    fetchMock.mockRejectedValueOnce(abortError());
    await send();
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());

    serverMessages = [...OLD_MESSAGES, SAVED_USER];
    await pressReload();
    await waitFor(() => expect(screen.getByText(TIMEOUT_DELIVERED_NO_REPLY_MESSAGE)).toBeTruthy());
    await pressReload();

    // 取り直しの GET (上限つき) が 2 回目まで済んだ
    await waitFor(() => expect(mockGet.mock.calls.filter((call) => call[1] !== undefined)).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('ai-timeout-reload')).toBeTruthy());
    expect(screen.getByText(TIMEOUT_DELIVERED_NO_REPLY_MESSAGE)).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(inputValue()).toBe('');
  });

  it('応答が途中で切れたあと: 取り直しで返答がまだ無く、押した取り直しで返答が届いていれば、届いていた送信として出す', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => {
      serverMessages = [...OLD_MESSAGES, SAVED_USER];
      return streamsLines([]);
    });
    await send();
    await waitFor(() => expect(screen.getByText(TIMEOUT_DELIVERED_NO_REPLY_MESSAGE)).toBeTruthy());

    serverMessages = SAVED_MESSAGES;
    mockEq.mockResolvedValue(EXECUTED_LOGS);
    await pressReload();

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(PREVIOUS_REQUEST_EXECUTED_MESSAGE)).toBeTruthy());
    expect(alertSpy).not.toHaveBeenCalled();
    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });
});

describe('#2227 H1 (R1) 本文を流している最中に別の相談へ切り替えた', () => {
  // 流れの途中の吹き出しは本文の後ろにカーソル (▌) を足すので、断片は部分一致 (exact: false) で探す。返答 (SAVED_REPLY) に
  // 含まれない文にする
  const PARTIAL = 'まず下ごしらえ';
  const PARTIAL_MORE = 'から始めます';
  const partialShown = (text: string) => screen.queryByText(text, { exact: false }) !== null;
  const FINAL_LINE = {
    userMessage: { id: SAVED_USER.id, content: SENT_TEXT, createdAt: SAVED_USER.createdAt },
    aiMessage: { id: 'm4', content: SAVED_REPLY, createdAt: '2026-11-01T00:00:01.000Z' },
    actionExecuted: false,
    actionResult: null,
  };

  async function selectSessionById(id: string, shownText: string) {
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${id}`));
    });
    await waitFor(() => expect(screen.getByText(shownText)).toBeTruthy());
  }

  async function flush() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it('切り替えたら前の相談の断片を消し、続きの断片も finalData も今の画面に出さない', async () => {
    await openSheet();
    const more = gate();
    const final = gate();
    fetchMock.mockResolvedValueOnce(
      streamsGatedLines([
        { line: { choices: [{ delta: { content: PARTIAL } }] } },
        { line: { choices: [{ delta: { content: PARTIAL_MORE } }] }, gate: more.promise },
        { line: FINAL_LINE, gate: final.promise },
      ]),
    );
    await send();
    await waitFor(() => expect(partialShown(PARTIAL)).toBe(true));

    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    expect(partialShown(PARTIAL)).toBe(false);

    await act(async () => {
      more.release();
    });
    await flush();
    expect(partialShown(PARTIAL_MORE)).toBe(false);

    await act(async () => {
      final.release();
    });
    await flush();
    expect(screen.getByText('別の相談の返答です')).toBeTruthy();
    expect(partialShown(PARTIAL)).toBe(false);
    expect(partialShown(PARTIAL_MORE)).toBe(false);
    expect(screen.queryByText(SAVED_REPLY)).toBeNull();
    expect(screen.queryByText(SENT_TEXT)).toBeNull();
  });

  it('切り替えて戻ったあとに finalData が来ても、送った文と返答を 2 つ並べず、断片も残さない', async () => {
    await openSheet();
    const final = gate();
    fetchMock.mockImplementationOnce(async () => {
      // サーバーは AI に問い合わせる前に送った文を保存する
      serverMessages = [...OLD_MESSAGES, SAVED_USER];
      return streamsGatedLines([
        { line: { choices: [{ delta: { content: PARTIAL } }] } },
        { line: FINAL_LINE, gate: final.promise },
      ]);
    });
    await send();
    await waitFor(() => expect(partialShown(PARTIAL)).toBe(true));

    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    await selectSessionById(SESSION.id, '野菜を足しましょう');
    expect(screen.getAllByText(SENT_TEXT)).toHaveLength(1);
    expect(partialShown(PARTIAL)).toBe(false);

    await act(async () => {
      final.release();
    });
    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(screen.getAllByText(SENT_TEXT)).toHaveLength(1);
    expect(screen.getAllByText(SAVED_REPLY)).toHaveLength(1);
    expect(partialShown(PARTIAL)).toBe(false);
  });
});

describe('#2227 H1 (R2) 確かめていない時間切れの送信の案内を、相談の切り替え・新しい相談で外した', () => {
  const NEW_SESSION = { id: 'session-new', title: 'AI相談', messageCount: 0, status: 'active' };
  const NEW_MESSAGES_PATH = `/api/ai/consultation/sessions/${NEW_SESSION.id}/messages`;

  /** 取り直し (上限つきの GET) と開き直し (上限なしの GET) で返す会話を分ける */
  function serveMessages(params: { reload: () => Promise<unknown[]> | unknown[]; open: () => unknown[] }) {
    mockGet.mockImplementation(async (requestPath: string, init?: unknown) => {
      if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION, OTHER_SESSION] };
      if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
      if (requestPath === NEW_MESSAGES_PATH) return { messages: [] };
      if (requestPath === MESSAGES_PATH && init) return { messages: await params.reload() };
      if (requestPath === MESSAGES_PATH) return { messages: params.open() };
      throw new Error(`unexpected GET ${requestPath}`);
    });
  }

  async function selectSessionById(id: string, shownText: string) {
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${id}`));
    });
    await waitFor(() => expect(screen.getByText(shownText)).toBeTruthy());
  }

  async function timeOutSend() {
    fetchMock.mockRejectedValueOnce(abortError());
    await send();
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    expect(inputValue()).toBe(SENT_TEXT);
  }

  it('時間切れのあと同じ相談を選び直し、送った文が保存されていれば入力欄の文を消す', async () => {
    await openSheet();
    await timeOutSend();
    // サーバーは送った文と返答を保存済み
    serverMessages = SAVED_MESSAGES;

    await selectSessionById(SESSION.id, SAVED_REPLY);

    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });

  it('同じ相談を選び直しても送った文の保存行が無ければ、入力欄の文を残す (上の対照)', async () => {
    await openSheet();
    await timeOutSend();
    serverMessages = OLD_MESSAGES;

    await selectSessionById(SESSION.id, '野菜を足しましょう');

    expect(inputValue()).toBe(SENT_TEXT);
  });

  it('時間切れのあと別の相談へ移って戻り、送った文が保存されていれば入力欄の文を消す', async () => {
    await openSheet();
    await timeOutSend();
    serverMessages = SAVED_MESSAGES;

    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    expect(inputValue()).toBe(SENT_TEXT);
    await selectSessionById(SESSION.id, SAVED_REPLY);

    expect(inputValue()).toBe('');
  });

  it('時間切れのあと新しい相談を始めてから前の相談を選び、送った文が保存されていれば入力欄の文を消す', async () => {
    await openSheet();
    await timeOutSend();
    serverMessages = SAVED_MESSAGES;
    mockPost.mockResolvedValueOnce({ success: true, session: { id: NEW_SESSION.id } });
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-new-session'));
    });
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/ai/consultation/sessions', { title: 'AI相談' }));
    await waitFor(() => expect(screen.queryByTestId('ai-timeout-notice')).toBeNull());

    await selectSessionById(SESSION.id, SAVED_REPLY);

    expect(inputValue()).toBe('');
  });

  it('押した「最新の会話を読み込む」が失敗したあと同じ相談を選び直し、送った文が保存されていれば入力欄の文を消す', async () => {
    await openSheet();
    await timeOutSend();
    serveMessages({
      reload: () => {
        throw new Error('Network request failed');
      },
      open: () => SAVED_MESSAGES,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('エラー', expect.any(String)));
    expect(inputValue()).toBe(SENT_TEXT);

    await selectSessionById(SESSION.id, SAVED_REPLY);

    expect(inputValue()).toBe('');
  });

  it('応答が途中で切れて取り直せなかったあと同じ相談を選び直し、送った文が保存されていれば入力欄の文を消す', async () => {
    await openSheet();
    serveMessages({
      reload: () => {
        throw new Error('Network request failed');
      },
      open: () => SAVED_MESSAGES,
    });
    fetchMock.mockResolvedValueOnce(streamsLines([]));
    await send();
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    expect(inputValue()).toBe(SENT_TEXT);

    await selectSessionById(SESSION.id, SAVED_REPLY);

    expect(inputValue()).toBe('');
  });

  it('「最新の会話を読み込む」の取り直しの最中に別の相談へ移り、取り直しで届いていたと分かったら、前の相談に戻ったときに入力欄の文を消す', async () => {
    await openSheet();
    await timeOutSend();
    const reload = gate();
    serveMessages({
      reload: async () => {
        await reload.promise;
        return SAVED_MESSAGES;
      },
      open: () => SAVED_MESSAGES,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));

    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    await act(async () => {
      reload.release();
    });
    await waitFor(() => expect(screen.getByTestId('ai-send-btn')).toBeTruthy());
    expect(inputValue()).toBe(SENT_TEXT);

    await selectSessionById(SESSION.id, SAVED_REPLY);

    expect(inputValue()).toBe('');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('「最新の会話を読み込む」の取り直しの最中に別の相談へ移り、取り直しが失敗したら、前の相談に戻ったときに保存されていれば入力欄の文を消す', async () => {
    await openSheet();
    await timeOutSend();
    const reload = gate();
    serveMessages({
      reload: async () => {
        await reload.promise;
        throw new Error('Network request failed');
      },
      open: () => SAVED_MESSAGES,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));

    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    await act(async () => {
      reload.release();
    });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('エラー', expect.any(String)));
    expect(inputValue()).toBe(SENT_TEXT);

    await selectSessionById(SESSION.id, SAVED_REPLY);

    expect(inputValue()).toBe('');
  });

  it('「最新の会話を読み込む」の取り直しの最中に別の相談へ移って戻っても、取り直しの結果を『届いていません』に変えない', async () => {
    await openSheet();
    await timeOutSend();
    const reload = gate();
    serveMessages({
      reload: async () => {
        await reload.promise;
        return SAVED_MESSAGES;
      },
      open: () => SAVED_MESSAGES,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));

    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    await selectSessionById(SESSION.id, SAVED_REPLY);
    await act(async () => {
      reload.release();
    });
    await waitFor(() => expect(screen.getByTestId('ai-send-btn')).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
    });

    expect(alertSpy).not.toHaveBeenCalledWith(TIMEOUT_DELIVERY_UNCONFIRMED_TITLE, TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE);
    expect(alertSpy).not.toHaveBeenCalledWith('送信できませんでした', TIMEOUT_NOT_DELIVERED_MESSAGE);
    expect(inputValue()).toBe('');
    expect(screen.getAllByText(SENT_TEXT)).toHaveLength(1);
  });
});
