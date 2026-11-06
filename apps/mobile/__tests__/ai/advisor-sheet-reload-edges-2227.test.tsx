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
 *   8. (R3 の指摘) 覚えるのを案内を外す側に任せていたので、外し方・書き換え方によって覚え忘れた。シートを開き直したときは、
 *      出す相談の id を変える前に会話を取ったので、届いていた送信の入力欄の文を消さなかった。新しい相談の作成を待つ間に終わった
 *      送信は、作成のあとで古い案内を見て覚えなかった。「最新の会話を読み込む」の最中に次を送って通信の切断で終わると、前の送信の
 *      取り直しの結果が次の送信の案内を消す・書き換えて、次の送信を覚えなかった。いまは入力欄に送った文を戻すその場で覚える
 *   9. (R4 の指摘) 「最新の会話を読み込む」の取り直しと次の送信を重ねられたので、取り直しの最中に送った次の送信とその返答を、
 *      あとから返った取り直しの古い会話が画面から消した (書いてよいかを相談の id で見ていたので、同じ相談の古い会話を止められない)。
 *      いまは取り直しのあいだ送信・入力欄・クイック質問・新しい相談・相談の切り替え・アーカイブを止め (Web と同じく直列)、取り直しの
 *      結果は、始めたときの画面の操作の番号が変わっていれば (開き直し・送信の中の取り直しなら切り替えも) 画面に書かない。
 *      送信の応答 (finalData・時間切れ) は会話の写しではないので、同じ相談を出し直した画面には書く (打った文を消さない)
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
// 切り替え先の相談は開いた相談にする (#2283 で、終了した相談を出している間は入力欄・送信を止めるようになった。このファイルは
// 送信・取り直しの最中の切り替えを確かめ、送信が終わったことを入力欄が動くことで見る (waitUntilSendEnds) ので、終了した相談だと
// 送信が終わっても入力欄が動かない。終了した相談の止めは advisor-sheet-session-closed-2283.test.tsx が確かめる)
const OTHER_SESSION = { id: 'session-2', title: '別の相談', messageCount: 1, status: 'active' };
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
const inputEditable = () => screen.getByTestId('ai-input').props.editable as boolean;

/** 待っている Promise の続きを流しきる */
async function flushPromises() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

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

  it.each([
    { name: '届いていた', reloaded: SAVED_MESSAGES, input: '', shown: SAVED_REPLY },
    { name: '取り直せなかった', reloaded: null, input: SENT_TEXT, shown: '野菜を足しましょう' },
  ])(
    '(R4) 「最新の会話を読み込む」の取り直しの最中は、相談の行・新しい相談・アーカイブを止め、押しても切り替えない (取り直しが$nameとき)',
    async ({ reloaded, input, shown }) => {
      await openSheet();
      await timeOutSend();
      const reload = gate();
      serveMessages({
        reload: async () => {
          await reload.promise;
          if (reloaded === null) throw new Error('Network request failed');
          return reloaded;
        },
        open: () => SAVED_MESSAGES,
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('ai-timeout-reload'));
      });
      await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));

      expect(screen.getByTestId('ai-archive-btn')).toBeDisabled();
      fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
      expect(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`)).toBeDisabled();
      expect(screen.getByTestId(`ai-session-${SESSION.id}`)).toBeDisabled();
      expect(screen.getByTestId('ai-new-session')).toBeDisabled();
      await act(async () => {
        fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
        fireEvent.press(screen.getByTestId('ai-new-session'));
      });
      expect(mockGet).not.toHaveBeenCalledWith(OTHER_MESSAGES_PATH);
      expect(mockPost).not.toHaveBeenCalled();
      // 相談の一覧はそのまま (切り替えていない)
      expect(screen.getByTestId('ai-new-session')).toBeTruthy();

      fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
      await act(async () => {
        reload.release();
      });
      await waitFor(() => expect(screen.getByText(shown)).toBeTruthy());
      await waitFor(() => expect(inputEditable()).toBe(true));
      expect(inputValue()).toBe(input);
      expect(screen.queryByText('別の相談の返答です')).toBeNull();

      // 取り直しが終われば、相談の行・新しい相談・アーカイブを押せる
      expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled();
      fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
      expect(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`)).not.toBeDisabled();
      expect(screen.getByTestId('ai-new-session')).not.toBeDisabled();
    },
  );
});

describe('#2227 H1 (R3・R4) 確かめていない送信を、案内の書き換え・開き直しの順に左右されずに覚える・取り直しと送信を重ねない', () => {
  const NEW_SESSION = { id: 'session-new', title: 'AI相談', messageCount: 0, status: 'active' };
  /** 取り直しのあとに送る、時間切れの送信とは別の文 */
  const NEXT_TEXT = '明日の朝ごはんも1食作って';
  const NEXT_SAVED_USER = { id: 'm5', role: 'user', content: NEXT_TEXT, createdAt: '2026-11-01T00:01:00.000Z' };
  const NEXT_REPLY = '卵焼きと味噌汁で作りますね';

  /** 取り直し (上限つきの GET) と開き直し (上限なしの GET) で返す会話を分ける */
  function serveMessages(params: { reload: () => Promise<unknown[]> | unknown[]; open: () => unknown[] }) {
    mockGet.mockImplementation(async (requestPath: string, init?: unknown) => {
      if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION, OTHER_SESSION] };
      if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
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

  /** 本文の失敗の行 (error だけ) を受けたあと、時間切れで読み取りが止まる応答 (サーバーが失敗を知らせた時間切れの送信) */
  function streamsErrorThenTimesOut() {
    let index = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            index += 1;
            if (index === 1) return { done: false, value: encoder.encode(`data: ${JSON.stringify(SERVER_ERROR_ONLY_LINE)}\n\n`) };
            throw abortError();
          },
          cancel: async () => undefined,
        }),
      },
      text: async () => '',
    };
  }

  /** シートを閉じて開き直す (シートは外されないので、会話・入力欄・覚えた送信は残る) */
  async function closeAndReopen(rerender: (element: React.ReactElement) => void, shownText: string) {
    await act(async () => {
      rerender(<AIAdvisorSheet visible={false} onClose={jest.fn()} />);
    });
    await act(async () => {
      rerender(<AIAdvisorSheet visible onClose={jest.fn()} />);
    });
    await waitFor(() => expect(screen.getByText(shownText)).toBeTruthy());
  }

  it('時間切れのあと別の相談へ移ってシートを閉じ、開き直して時間切れの相談が出たら、送った文が保存されていれば入力欄の文を消す', async () => {
    const { rerender } = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    await timeOutSend();
    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    expect(inputValue()).toBe(SENT_TEXT);
    // サーバーは送った文と返答を保存済み (開き直すと、出す相談は active の時間切れの相談)
    serverMessages = SAVED_MESSAGES;

    await closeAndReopen(rerender, SAVED_REPLY);

    expect(inputValue()).toBe('');
  });

  it('(R4) 「最新の会話を読み込む」の取り直しの最中にシートを開き直したら、あとから返った取り直しの古い会話・結果を画面に書かない', async () => {
    const { rerender } = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    await timeOutSend();
    const reload = gate();
    serveMessages({
      // 取り直しは、開き直しより前に読んだ古い会話 (送った文がまだ無い) を返す
      reload: async () => {
        await reload.promise;
        return OLD_MESSAGES;
      },
      open: () => SAVED_MESSAGES,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));

    await closeAndReopen(rerender, SAVED_REPLY);
    // 開き直しの読み込みが送った文の保存行を見つけたので、入力欄の文を消し、前の画面の案内を外す
    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    await act(async () => {
      reload.release();
    });
    await waitFor(() => expect(inputEditable()).toBe(true));
    await flushPromises();

    // 古い会話で置き換えない・『確かめられませんでした』を出さない・入力欄に戻さない・案内を出し直さない
    expect(screen.getByText(SAVED_REPLY)).toBeTruthy();
    expect(screen.getAllByText(SENT_TEXT)).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });

  it('(R4) 取り直しの最中に開き直して相談が空でも、クイック質問は取り直しが終わるまで止め、押しても送らない (古い会話も書かない)', async () => {
    const { rerender } = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    await timeOutSend();
    const reload = gate();
    serveMessages({
      reload: async () => {
        await reload.promise;
        return SAVED_MESSAGES;
      },
      // 開き直すと相談は空 (ようこその一文とクイック質問が出る)
      open: () => [],
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));
    await act(async () => {
      rerender(<AIAdvisorSheet visible={false} onClose={jest.fn()} />);
    });
    await act(async () => {
      rerender(<AIAdvisorSheet visible onClose={jest.fn()} />);
    });
    await waitFor(() => expect(screen.getByTestId('ai-quick-0')).toBeTruthy());

    expect(screen.getByTestId('ai-quick-0')).toBeDisabled();
    expect(inputEditable()).toBe(false);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-quick-0'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      reload.release();
    });
    await waitFor(() => expect(screen.getByTestId('ai-quick-0')).not.toBeDisabled());
    await flushPromises();
    // 取り直しの会話 (送った文と返答) は、開き直した画面に書かない
    expect(screen.queryByText(SAVED_REPLY)).toBeNull();
    expect(inputEditable()).toBe(true);
  });

  it('送信中に新しい相談を押し、作成を待つ間に送信が時間切れになっても、前の相談を選び直して送った文が保存されていれば入力欄の文を消す', async () => {
    await openSheet();
    const sendDone = gate();
    fetchMock.mockImplementationOnce(async () => {
      await sendDone.promise;
      throw abortError();
    });
    const created = gate();
    mockPost.mockImplementationOnce(async () => {
      await created.promise;
      return { success: true, session: { id: NEW_SESSION.id } };
    });
    await send();
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-new-session'));
    });
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/ai/consultation/sessions', { title: 'AI相談' }));
    // 作成を待つ間に送信が時間切れになる (送った文は入力欄に戻る)
    await act(async () => {
      sendDone.release();
    });
    await waitFor(() => expect(inputValue()).toBe(SENT_TEXT));
    await act(async () => {
      created.release();
    });
    await waitFor(() => expect(screen.queryByTestId('ai-new-session')).toBeNull());
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    serverMessages = SAVED_MESSAGES;

    await selectSessionById(SESSION.id, SAVED_REPLY);

    expect(inputValue()).toBe('');
  });

  const RELOAD_OUTCOMES = [
    {
      name: '届いていなかった (not-delivered)',
      timeOut: 'abort',
      reloaded: OLD_MESSAGES,
      alert: [TIMEOUT_DELIVERY_UNCONFIRMED_TITLE, TIMEOUT_DELIVERY_UNCONFIRMED_MESSAGE],
    },
    { name: '届いているが返答がまだ無い (delivered-no-reply)', timeOut: 'abort', reloaded: [...OLD_MESSAGES, SAVED_USER], alert: null },
    {
      name: 'サーバーが失敗を知らせていて返答が無い (serverFailed)',
      timeOut: 'server-failed',
      reloaded: [...OLD_MESSAGES, SAVED_USER],
      alert: ['エラー', REPLY_FAILED_MESSAGE],
    },
  ];

  /**
   * 送信が時間切れになり (timeOut)、「最新の会話を読み込む」の取り直し (reloaded を返す) を止める。戻り値の release で取り直しを通す
   */
  async function startGatedReload(timeOut: string, reloaded: unknown[]) {
    await openSheet();
    if (timeOut === 'abort') {
      await timeOutSend();
    } else {
      fetchMock.mockResolvedValueOnce(streamsErrorThenTimesOut());
      await send();
      await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
      expect(inputValue()).toBe(SENT_TEXT);
    }
    const reload = gate();
    serveMessages({
      reload: async () => {
        await reload.promise;
        return reloaded;
      },
      open: () => reloaded,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));
    return {
      release: async () => {
        await act(async () => {
          reload.release();
        });
        await waitFor(() => expect(inputEditable()).toBe(true));
      },
    };
  }

  it.each(RELOAD_OUTCOMES)(
    '(R4) 「最新の会話を読み込む」の取り直しの最中は送信ボタンと入力欄を止め、押しても送らない。取り直しが $name で返ったら止めを外す',
    async ({ timeOut, reloaded, alert }) => {
      const { release } = await startGatedReload(timeOut, reloaded);

      // 入力欄には時間切れで戻した文があるが、取り直しの最中は送れない
      expect(inputValue()).toBe(SENT_TEXT);
      expect(screen.getByTestId('ai-send-btn')).toBeDisabled();
      expect(inputEditable()).toBe(false);
      await act(async () => {
        fireEvent.press(screen.getByTestId('ai-send-btn'));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await release();
      if (alert) expect(alertSpy).toHaveBeenCalledWith(...alert);
      else expect(alertSpy).not.toHaveBeenCalled();
      // 取り直しが終われば、文を書いて送れる
      fireEvent.changeText(screen.getByTestId('ai-input'), NEXT_TEXT);
      expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled();
    },
  );

  it.each(RELOAD_OUTCOMES)(
    '(R4) 取り直しが $name で返ったあとに送った次の送信とその返答は、画面から消えない (取り直しと送信は重ならない)',
    async ({ timeOut, reloaded }) => {
      const { release } = await startGatedReload(timeOut, reloaded);
      await release();
      fireEvent.changeText(screen.getByTestId('ai-input'), NEXT_TEXT);
      fetchMock.mockResolvedValueOnce(
        streamsLines([
          {
            userMessage: { id: NEXT_SAVED_USER.id, content: NEXT_TEXT, createdAt: NEXT_SAVED_USER.createdAt },
            aiMessage: { id: 'm6', content: NEXT_REPLY, createdAt: '2026-11-01T00:01:01.000Z' },
            actionExecuted: false,
            actionResult: null,
          },
        ]),
      );
      await act(async () => {
        fireEvent.press(screen.getByTestId('ai-send-btn'));
      });
      await waitFor(() => expect(screen.getByText(NEXT_REPLY)).toBeTruthy());
      await flushPromises();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByText(NEXT_TEXT)).toBeTruthy();
      expect(screen.getByText(NEXT_REPLY)).toBeTruthy();
    },
  );
});

describe('#2227 H1 (R4) 画面の操作のあとに返った古い取り直し・送信の応答', () => {
  const NEW_SESSION = { id: 'session-new', title: 'AI相談', messageCount: 0, status: 'active' };
  const NEW_MESSAGES_PATH = `/api/ai/consultation/sessions/${NEW_SESSION.id}/messages`;

  /** 取り直し (上限つきの GET) と開き直し (上限なしの GET) で返す会話を分ける。どちらも Promise を返してよい */
  function serveMessages(params: { reload: () => Promise<unknown[]> | unknown[]; open: () => Promise<unknown[]> | unknown[] }) {
    mockGet.mockImplementation(async (requestPath: string, init?: unknown) => {
      if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION, OTHER_SESSION] };
      if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
      if (requestPath === NEW_MESSAGES_PATH) return { messages: [] };
      if (requestPath === MESSAGES_PATH && init) return { messages: await params.reload() };
      if (requestPath === MESSAGES_PATH) return { messages: await params.open() };
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

  async function reopen(rerender: (element: React.ReactElement) => void) {
    await act(async () => {
      rerender(<AIAdvisorSheet visible={false} onClose={jest.fn()} />);
    });
    await act(async () => {
      rerender(<AIAdvisorSheet visible onClose={jest.fn()} />);
    });
  }

  /** 送信が終わる (入力欄が動く) まで待つ */
  async function waitUntilSendEnds() {
    await waitFor(() => expect(inputEditable()).toBe(true));
    await flushPromises();
  }

  /** finalData の無いまま流れが終わる送信を送り、そのあとの取り直し (reloaded を返す) を止める */
  async function sendIncompleteWithGatedReload(reloaded: unknown[], open: () => unknown[]) {
    const reload = gate();
    serveMessages({
      reload: async () => {
        await reload.promise;
        return reloaded;
      },
      open,
    });
    fetchMock.mockResolvedValueOnce(streamsLines([]));
    await send();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH, { timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));
    return reload;
  }

  it('応答を受け取れなかったあとの取り直しの最中に別の相談へ移ったら、取り直しの結果を書かず、送信は確かめていない送信として覚える', async () => {
    await openSheet();
    const reload = await sendIncompleteWithGatedReload(SAVED_MESSAGES, () => SAVED_MESSAGES);

    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    await act(async () => {
      reload.release();
    });
    await waitUntilSendEnds();

    expect(screen.getByText('別の相談の返答です')).toBeTruthy();
    expect(screen.queryByText(SAVED_REPLY)).toBeNull();
    expect(screen.queryByText(SENT_TEXT)).toBeNull();
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(inputValue()).toBe('');
    expect(alertSpy).not.toHaveBeenCalled();

    // 覚えている: 入力欄に同じ文があり、相談を出し直して保存行が見つかれば消す (覚えていなければ消さない)
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    await selectSessionById(SESSION.id, SAVED_REPLY);
    expect(inputValue()).toBe('');
  });

  it('応答を受け取れなかったあとの取り直しの最中に新しい相談を始めたら、取り直しの結果を新しい相談に書かない', async () => {
    await openSheet();
    const reload = await sendIncompleteWithGatedReload(OLD_MESSAGES, () => OLD_MESSAGES);
    mockPost.mockResolvedValueOnce({ success: true, session: { id: NEW_SESSION.id } });
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-new-session'));
    });
    await waitFor(() => expect(screen.queryByTestId('ai-new-session')).toBeNull());

    await act(async () => {
      reload.release();
    });
    await waitUntilSendEnds();

    expect(screen.queryByText('野菜を足しましょう')).toBeNull();
    expect(screen.queryByText(SENT_TEXT)).toBeNull();
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(inputValue()).toBe('');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('応答を受け取れなかったあとの取り直しの最中にシートを開き直したら、あとから返った古い会話で開き直した会話を置き換えない', async () => {
    const { rerender } = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    // 取り直しは、開き直しより前に読んだ古い会話 (送った文がまだ無い) を返す
    const reload = await sendIncompleteWithGatedReload(OLD_MESSAGES, () => SAVED_MESSAGES);

    await reopen(rerender);
    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    await act(async () => {
      reload.release();
    });
    await waitUntilSendEnds();

    expect(screen.getByText(SAVED_REPLY)).toBeTruthy();
    expect(screen.getAllByText(SENT_TEXT)).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
  });

  it('送信の最中に別の相談へ移ってから時間切れになったら、入力欄に戻さず案内も出さないが、確かめていない送信として覚える', async () => {
    await openSheet();
    const sendDone = gate();
    fetchMock.mockImplementationOnce(async () => {
      await sendDone.promise;
      throw abortError();
    });
    await send();
    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    await act(async () => {
      sendDone.release();
    });
    await waitUntilSendEnds();

    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    serverMessages = SAVED_MESSAGES;
    await selectSessionById(SESSION.id, SAVED_REPLY);
    expect(inputValue()).toBe('');
  });

  it('送信の最中にシートを開き直し、そのあと時間切れになったら、同じ相談を出しているので入力欄に戻して案内を出す (打った文を消さない)', async () => {
    const { rerender } = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    const sendDone = gate();
    fetchMock.mockImplementationOnce(async () => {
      await sendDone.promise;
      throw abortError();
    });
    await send();
    await reopen(rerender);
    await waitFor(() => expect(mockGet.mock.calls.filter((call) => call[0] === MESSAGES_PATH)).toHaveLength(2));
    await act(async () => {
      sendDone.release();
    });
    await waitUntilSendEnds();

    expect(inputValue()).toBe(SENT_TEXT);
    expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy();
  });

  it('送信の最中に別の相談へ移って戻り、戻した相談の読み込みの最中に時間切れになっても、その読み込みは送信を忘れず、「最新の会話を読み込む」で届いていたと分かる', async () => {
    await openSheet();
    const sendDone = gate();
    fetchMock.mockImplementationOnce(async () => {
      await sendDone.promise;
      throw abortError();
    });
    await send();
    await selectSessionById(OTHER_SESSION.id, '別の相談の返答です');
    const opened = gate();
    serveMessages({
      reload: () => SAVED_MESSAGES,
      open: async () => {
        await opened.promise;
        return SAVED_MESSAGES;
      },
    });
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${SESSION.id}`));
    });
    // 読み込みを待つ間に時間切れになる (同じ相談を出しているので、入力欄に戻して案内を出す)
    await act(async () => {
      sendDone.release();
    });
    await waitUntilSendEnds();
    expect(inputValue()).toBe(SENT_TEXT);

    // 読み込みの会話は、時間切れより前に始めた GET の写し。この送信はまだ確かめない (忘れない・当てない)
    await act(async () => {
      opened.release();
    });
    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(screen.queryByTestId('ai-timeout-notice')).toBeNull());
    expect(alertSpy).not.toHaveBeenCalled();
    expect(inputValue()).toBe('');
  });

  it.each([
    { name: '届いていれば入力欄の文を消す', opened: SAVED_MESSAGES, shown: SAVED_REPLY, input: '' },
    { name: '届いていなければ入力欄の文を残す', opened: OLD_MESSAGES, shown: '野菜を足しましょう', input: SENT_TEXT },
  ])('時間切れの案内が出たままシートを開き直したら、前の画面の案内を外し、$name', async ({ opened, shown, input }) => {
    const { rerender } = render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    fetchMock.mockRejectedValueOnce(abortError());
    await send();
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
    serverMessages = opened;

    await reopen(rerender);
    await waitFor(() => expect(screen.getByText(shown)).toBeTruthy());

    expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();
    expect(inputValue()).toBe(input);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
