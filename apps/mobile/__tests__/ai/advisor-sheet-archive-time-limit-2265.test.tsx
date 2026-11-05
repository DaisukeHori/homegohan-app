/**
 * #2265 Q1: アーカイブ (POST /api/ai/consultation/sessions/:id/close) に時間の上限が無く、応答が返らないと止めが下りなかった (回帰テスト)。
 *
 * 直す前: アーカイブの POST は素の fetch (signal も時間切れも無い) で、応答が返らない間は closingSessionRef と isClosingSession が
 * 下りず、送信・新しい相談・相談の切り替え・アーカイブが止まったまま、アプリを開き直すまで戻らなかった。
 * いまは Web の『相談を終了』(#2259 P1) と同じ上限 (AI_CHAT_REQUEST_TIME_LIMIT_MS) で待ち、時間切れで打ち切って止めを下ろし、
 * 『失敗しました』と言い切らずに相談の一覧で確かめてもらう一文を出す。上限の値が Web と同じことは
 * tests/mobile-ai-archive-time-limit-2265.test.ts (ルートの vitest) が確かめる。
 *
 * #2265 Q5: 受け付けたあと (ok の応答) の例外 (本文の読み取りの時間切れ・本文が JSON でない など) は、Web の『相談を終了』の
 * closeSession (#2265 Q2) と同じく、時間切れ・失敗の一文を出さず、成功のときと同じ後続 (新しい相談を作って出し、一覧を読み直す)
 * で画面をサーバーの状態に合わせる。直す前は、時間切れでは何もせず、それ以外では『セッションのアーカイブに失敗しました。』と
 * 言い切り、どちらもアーカイブ済みの相談が今の相談のまま残った (一覧の status も open のまま。送ると閉じた相談に保存された)。
 *
 * 上限は本物の値 (AI_CHAT_REQUEST_TIME_LIMIT_MS) のまま、実時間では待たない。アーカイブを押す前に setTimeout を jest の偽のタイマーに
 * して (holdTimeLimit)、止めが立ったことを確かめてから偽の時刻を進めて時間切れを起こす (判定と待ち方は本物の部品)。
 * #2275 T4: 以前は上限を jest.mock で 30ms に差し替えて実時間で待っていたので、止めが立ったことを確かめる waitFor が負荷で問い直し
 * (50ms ごと) に回ると、確かめる前に上限が過ぎて止めが下り、mobile の jest の全件と並走したときに赤になった (単独では緑)。
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
  AI_CHAT_REQUEST_TIME_LIMIT_MS,
  ARCHIVE_SESSION_TIMEOUT_MESSAGE,
  ARCHIVE_SESSION_TIMEOUT_TITLE,
} from '../../src/lib/ai-consultation-request-time-limit';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.timeouts.js は jest.config.js から require される CommonJS
const { resolveMobileJestTimeouts } = require('../../jest.timeouts') as {
  resolveMobileJestTimeouts: (env: Record<string, string | undefined>) => { testTimeout: number; asyncUtilTimeout: number };
};

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
const ARCHIVE_FAILED_MESSAGE = 'セッションのアーカイブに失敗しました。';
const CREATE_SESSION_ARGS = ['/api/ai/consultation/sessions', { title: 'AI相談' }] as const;

const fetchMock = jest.fn();

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string) => {
    if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION, OTHER_SESSION] };
    if (requestPath === MESSAGES_PATH) return { messages: OLD_MESSAGES };
    if (requestPath === OTHER_MESSAGES_PATH) return { messages: OTHER_MESSAGES };
    throw new Error(`unexpected GET ${requestPath}`);
  });
  mockPost.mockResolvedValue({ success: true, session: { id: NEW_SESSION.id } });
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockImplementation(() => ({ eq: mockEq }));
  mockEq.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  // holdTimeLimit で偽にした setTimeout を戻す (部品を外す後始末のあとに走るので、外すときの取り消しも偽のタイマーに効く)
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** holdTimeLimit で偽にしない時計の API (偽にするのは setTimeout と clearTimeout だけ。advisor-sheet-reload-running.test.tsx の holdRecheck と同じ) */
const REAL_TIMER_APIS = [
  'Date',
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
] as const;

/**
 * アーカイブの上限の予約 (withinConsultationRequestTimeLimit の setTimeout) を jest の偽のタイマーにして、advanceFakeTime で進める
 * まで動かさない (#2275 T4)。上限は本物の AI_CHAT_REQUEST_TIME_LIMIT_MS のまま偽の時刻で止めるので、RNTL の waitFor が偽の時刻を
 * 少しずつ進めても (1 回の間隔は既定の 50ms) 上限には届かず、止めが立ったことを確かめる前に止めが下りることはない (負荷に依らない)。
 * シートを開いたあと、アーカイブを押す前に呼ぶ
 */
function holdTimeLimit() {
  jest.useFakeTimers({ doNotFake: [...REAL_TIMER_APIS] });
}

/**
 * 上限の途中まで (半分) 偽の時刻を進める長さ。止めを確かめる waitFor が偽の時刻を少し進めていても (1 回 50ms)、上限には届かない長さ
 * にする (届かないことは『前提』の it が確かめる)
 */
const PART_OF_TIME_LIMIT_MS = AI_CHAT_REQUEST_TIME_LIMIT_MS / 2;

/** holdTimeLimit で止めた予約を、偽の時刻を ms だけ進めて動かす */
async function advanceFakeTime(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function openSheet() {
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
}

const alertCalls = () => (Alert.alert as jest.Mock).mock.calls;
const sentUrls = () => fetchMock.mock.calls.map(([url]) => url);
const createSessionCalls = () =>
  mockPost.mock.calls.filter(([path, body]) => path === CREATE_SESSION_ARGS[0] && JSON.stringify(body) === JSON.stringify(CREATE_SESSION_ARGS[1]));
/** /close に渡した signal */
const closeSignal = (): AbortSignal | undefined => {
  const call = fetchMock.mock.calls.find(([url]) => url === CLOSE_URL);
  return (call?.[1] as RequestInit | undefined)?.signal ?? undefined;
};

/** 上限の予約を止めて (holdTimeLimit) アーカイブを押し、/close が送られて止めが立ったこと (新しい相談・切り替えが止まる) を確かめる */
async function pressArchiveAndExpectLocked() {
  holdTimeLimit();
  fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-archive-btn'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));
  expect(screen.getByTestId('ai-archive-btn')).toBeDisabled();
  expect(screen.getByTestId('ai-new-session')).toBeDisabled();
  expect(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`)).toBeDisabled();
}

/** 相談の一覧を読んだ回数 */
const sessionListReads = () =>
  mockGet.mock.calls.filter(([requestPath]) => String(requestPath).startsWith('/api/ai/consultation/sessions?status=all')).length;

/**
 * 受け付けたあとの例外のあと (#2265 Q5): 時間切れ・失敗の一文を出さず、新しい相談を 1 つだけ作り、一覧を読み直して、
 * アーカイブ済みの相談の会話を消し、続けて送ると新しい相談へ送る (閉じた相談へは送らない)
 */
async function expectFreshSessionAfterAcceptedArchive(listReadsBefore: number) {
  await waitFor(() => expect(createSessionCalls()).toHaveLength(1));
  expect(sessionListReads()).toBeGreaterThan(listReadsBefore);
  expect(alertCalls().some(([, message]) => message === ARCHIVE_SESSION_TIMEOUT_MESSAGE)).toBe(false);
  expect(alertCalls().some(([, message]) => message === ARCHIVE_FAILED_MESSAGE)).toBe(false);
  await waitFor(() => expect(screen.queryByText('野菜を足しましょう')).toBeNull());

  await waitFor(() => expect(screen.getByTestId('ai-input').props.editable).toBe(true));
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  fetchMock.mockRejectedValueOnce(new Error('send failed'));
  await waitFor(() => expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled());
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(NEW_SESSION_SEND_URL, expect.anything()));
  expect(sentUrls()).not.toContain(OLD_SESSION_SEND_URL);
  // 新しい相談の作成は 1 回だけ (成功の後続と例外の後続を重ねない)
  expect(createSessionCalls()).toHaveLength(1);
}

/** 止めが下りるのを待つ (アーカイブのボタンがまた押せる) */
async function waitForUnlock() {
  await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
}

/**
 * 上限の途中 (半分) まで偽の時刻を進めても止めは下りず時間切れの一文も出ないことを確かめてから、上限を過ぎるまで進め、止めが
 * 下りるのを待つ (holdTimeLimit のあとに呼ぶ)
 */
async function passTimeLimitAndWaitForUnlock() {
  await advanceFakeTime(PART_OF_TIME_LIMIT_MS);
  expect(screen.getByTestId('ai-archive-btn')).toBeDisabled();
  expect(alertCalls()).not.toContainEqual([ARCHIVE_SESSION_TIMEOUT_TITLE, ARCHIVE_SESSION_TIMEOUT_MESSAGE]);
  await advanceFakeTime(AI_CHAT_REQUEST_TIME_LIMIT_MS);
  await waitForUnlock();
}

describe('#2265 Q1 前提', () => {
  it('上限の途中 (半分) までの偽の時刻は、RNTL の 1 つの waitFor が進めうる偽の時刻 (最大で待ちの既定) より長い (#2275 T4)', () => {
    // 止めを確かめる waitFor が偽の時刻を進めても上限に届かないので、止めが立ったことを確かめる前に時間切れが起きない
    expect(PART_OF_TIME_LIMIT_MS).toBeGreaterThan(resolveMobileJestTimeouts(process.env).asyncUtilTimeout);
  });
});

describe('#2265 Q1 アーカイブの応答が返らないと、上限で止めを下ろす', () => {
  it('応答を返さない /close (打ち切りに応じない): 上限で止めが下り、一覧で確かめる一文を出し、新しい相談を始めて送れる', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(() => new Promise<never>(() => {}));
    await pressArchiveAndExpectLocked();

    await passTimeLimitAndWaitForUnlock();
    // 『失敗しました』と言い切らず、一覧で確かめてもらう
    expect(alertCalls()).toContainEqual([ARCHIVE_SESSION_TIMEOUT_TITLE, ARCHIVE_SESSION_TIMEOUT_MESSAGE]);
    expect(alertCalls().some(([, message]) => message === ARCHIVE_FAILED_MESSAGE)).toBe(false);
    // 通信は打ち切った
    expect(closeSignal()?.aborted).toBe(true);
    // アーカイブは済んでいないので、アーカイブの側で新しい相談を作らない
    expect(createSessionCalls()).toHaveLength(0);

    // 新しい相談・相談の切り替えがまた押せる
    expect(screen.getByTestId('ai-new-session')).not.toBeDisabled();
    expect(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`)).not.toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-new-session'));
    });
    await waitFor(() => expect(createSessionCalls()).toHaveLength(1));

    // 会話の画面で入力欄が使え、新しい相談へ送れる
    await waitFor(() => expect(screen.getByTestId('ai-input').props.editable).toBe(true));
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    fetchMock.mockRejectedValueOnce(new Error('send failed'));
    await waitFor(() => expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled());
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(NEW_SESSION_SEND_URL, expect.anything()));
  });

  it('応答を返さない /close: 上限のあと相談を切り替えられ、今の相談へ送れる', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(() => new Promise<never>(() => {}));
    await pressArchiveAndExpectLocked();
    await passTimeLimitAndWaitForUnlock();

    // 相談の切り替え
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`));
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(OTHER_MESSAGES_PATH));
    await waitFor(() => expect(screen.getByText('前の相談の返答です')).toBeTruthy());

    // 元の相談に戻して送る (アーカイブは済んでいないので、元の相談のまま送れる)
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ai-session-${SESSION.id}`));
    });
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    fetchMock.mockRejectedValueOnce(new Error('send failed'));
    await waitFor(() => expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled());
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(OLD_SESSION_SEND_URL, expect.anything()));
  });

  it('打ち切りに応じる /close (AbortError で終わる): 待ちの結果は時間切れで、同じ一文を出して止めを下ろす', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
        }),
    );
    await pressArchiveAndExpectLocked();

    await passTimeLimitAndWaitForUnlock();
    expect(alertCalls()).toContainEqual([ARCHIVE_SESSION_TIMEOUT_TITLE, ARCHIVE_SESSION_TIMEOUT_MESSAGE]);
    expect(alertCalls().some(([, message]) => message === ARCHIVE_FAILED_MESSAGE)).toBe(false);
    expect(screen.getByTestId('ai-new-session')).not.toBeDisabled();
  });

  it('トークンの取り出し (getSession) が返らない: 上限で止めを下ろし、/close は送らない', async () => {
    await openSheet();
    mockGetSession.mockImplementationOnce(() => new Promise<never>(() => {}));
    holdTimeLimit();
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    expect(screen.getByTestId('ai-new-session')).toBeDisabled();

    await passTimeLimitAndWaitForUnlock();
    expect(alertCalls()).toContainEqual([ARCHIVE_SESSION_TIMEOUT_TITLE, ARCHIVE_SESSION_TIMEOUT_MESSAGE]);
    expect(sentUrls()).not.toContain(CLOSE_URL);
    expect(screen.getByTestId('ai-new-session')).not.toBeDisabled();
  });

  it('時間切れのあと「最新の会話を読み込む」がまた押せる (アーカイブの応答待ちの止めが下りる)', async () => {
    await openSheet();
    // 送信の応答を受け取れずに終わり、「最新の会話を読み込む」の案内が出ている
    fetchMock.mockRejectedValueOnce(abortError());
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());

    // 会話の画面のまま (相談の一覧を開かずに) アーカイブを押す。応答待ちの間は取り直しのボタンを止める
    fetchMock.mockImplementationOnce(() => new Promise<never>(() => {}));
    holdTimeLimit();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));
    expect(screen.getByTestId('ai-timeout-reload')).toBeDisabled();

    // 上限の途中 (半分) までは取り直しのボタンも止めたまま。上限を過ぎると下りる
    await advanceFakeTime(PART_OF_TIME_LIMIT_MS);
    expect(screen.getByTestId('ai-timeout-reload')).toBeDisabled();
    expect(screen.getByTestId('ai-archive-btn')).toBeDisabled();
    await advanceFakeTime(AI_CHAT_REQUEST_TIME_LIMIT_MS);
    await waitForUnlock();
    expect(screen.getByTestId('ai-timeout-reload')).not.toBeDisabled();
  });
});

describe('#2265 Q5 受け付けたあとの例外は、成功と同じく新しい相談を出して一覧を読み直す (Web の #2265 Q2 と同じ)', () => {
  it('受け付けたあと (ok の応答) に本文が返らない: 上限で止めを下ろし、時間切れ・失敗の一文は出さず、新しい相談を出して一覧を読み直す', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: () => new Promise<never>(() => {}) }));
    const listReadsBefore = sessionListReads();
    await pressArchiveAndExpectLocked();

    await passTimeLimitAndWaitForUnlock();
    // 本文の読み取りは上限で打ち切った
    expect(closeSignal()?.aborted).toBe(true);
    await expectFreshSessionAfterAcceptedArchive(listReadsBefore);
  });

  it('受け付けたあと (ok の応答) に本文が JSON でない: 失敗の一文は出さず、新しい相談を出して一覧を読み直す', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }));
    const listReadsBefore = sessionListReads();
    // 上限の予約は止めたまま進めない (止めが下りるのは応答による。時間切れによらない)
    holdTimeLimit();
    // 応答はすぐ返る (応答待ちの止めは同じ act のうちに下りる) ので、止めが立ったことは確かめない
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));

    await waitForUnlock();
    await expectFreshSessionAfterAcceptedArchive(listReadsBefore);
  });

  it('新しい相談を出したあとに要約の応答の形が崩れていた (本文が null): 新しい相談を作り直さず、失敗の一文も出さない', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => null }));
    const listReadsBefore = sessionListReads();
    // 上限の予約は止めたまま進めない (止めが下りるのは応答による。時間切れによらない)
    holdTimeLimit();
    // 応答はすぐ返る (応答待ちの止めは同じ act のうちに下りる) ので、止めが立ったことは確かめない
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));

    await waitForUnlock();
    await expectFreshSessionAfterAcceptedArchive(listReadsBefore);
  });
});

describe('#2265 Q1 対照: 上限までに返った応答は今までどおり', () => {
  it('成功の応答: 新しい相談を 1 つ作り要約を出す。時間切れの一文は出さず、予約した上限で打ち切らない', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ summary: { summary: SUMMARY_TEXT } }) }));
    holdTimeLimit();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(screen.getByText(SUMMARY_LINE)).toBeTruthy());
    expect(createSessionCalls()).toHaveLength(1);
    // 上限を過ぎるまで偽の時刻を進めても、予約は取り消してあるので打ち切らず、時間切れの一文も出さない
    await advanceFakeTime(AI_CHAT_REQUEST_TIME_LIMIT_MS);
    expect(closeSignal()?.aborted).toBe(false);
    expect(alertCalls().some(([, message]) => message === ARCHIVE_SESSION_TIMEOUT_MESSAGE)).toBe(false);
  });

  it('通信の失敗 (時間切れでない例外): 今までどおり『失敗しました』を出し、時間切れの一文は出さない', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Network request failed');
    });
    holdTimeLimit();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(alertCalls()).toContainEqual(['エラー', ARCHIVE_FAILED_MESSAGE]));
    // 止めは失敗の応答で下りる (上限の予約は進めていない)
    await waitForUnlock();
    // 上限を過ぎるまで偽の時刻を進めても、予約は取り消してあるので時間切れの一文は出さない
    await advanceFakeTime(AI_CHAT_REQUEST_TIME_LIMIT_MS);
    expect(alertCalls().some(([, message]) => message === ARCHIVE_SESSION_TIMEOUT_MESSAGE)).toBe(false);
  });
});
