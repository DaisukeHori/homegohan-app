/**
 * #2265 Q1: アーカイブ (POST /api/ai/consultation/sessions/:id/close) に時間の上限が無く、応答が返らないと止めが下りなかった (回帰テスト)。
 *
 * 直す前: アーカイブの POST は素の fetch (signal も時間切れも無い) で、応答が返らない間は closingSessionRef と isClosingSession が
 * 下りず、送信・新しい相談・相談の切り替え・アーカイブが止まったまま、アプリを開き直すまで戻らなかった。
 * いまは Web の『相談を終了』(#2259 P1) と同じ上限 (AI_CHAT_REQUEST_TIME_LIMIT_MS) で待ち、時間切れで打ち切って止めを下ろし、
 * 『失敗しました』と言い切らずに相談の一覧で確かめてもらう一文を出す。受け付けたあとの本文の読み取りの時間切れは何も出さない
 * (Web と同じ)。上限の値が Web と同じことは tests/mobile-ai-archive-time-limit-2265.test.ts (ルートの vitest) が確かめる。
 *
 * 上限は本物 (315 秒) を待たず、短い値に差し替える (判定と待ち方は本物の部品)。
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

jest.mock('../../src/lib/ai-consultation-request-time-limit', () => {
  // 本物の上限 (315 秒) はテストで待てないので、短い上限に差し替える。ほか (待ち方・時間切れの判定・文) は本物
  const TIME_LIMIT_FOR_TEST_MS = 30;
  return {
    ...jest.requireActual('../../src/lib/ai-consultation-request-time-limit'),
    AI_CHAT_REQUEST_TIME_LIMIT_MS: TIME_LIMIT_FOR_TEST_MS,
  };
});

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
  AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS,
  AI_CHAT_REQUEST_TIME_LIMIT_MS,
  ARCHIVE_SESSION_TIMEOUT_MESSAGE,
  ARCHIVE_SESSION_TIMEOUT_TITLE,
} from '../../src/lib/ai-consultation-request-time-limit';

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
  jest.restoreAllMocks();
});

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

/** アーカイブを押し、/close が送られて止めが立ったこと (新しい相談・切り替えが止まる) を確かめる */
async function pressArchiveAndExpectLocked() {
  fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-archive-btn'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));
  expect(screen.getByTestId('ai-archive-btn')).toBeDisabled();
  expect(screen.getByTestId('ai-new-session')).toBeDisabled();
  expect(screen.getByTestId(`ai-session-${OTHER_SESSION.id}`)).toBeDisabled();
}

/** 上限を過ぎて止めが下りるのを待つ (アーカイブのボタンがまた押せる) */
async function waitForUnlock() {
  await waitFor(() => expect(screen.getByTestId('ai-archive-btn')).not.toBeDisabled());
}

describe('#2265 Q1 前提', () => {
  it('テストの上限は本物 (Web と同じ既定) より短く差し替えている (本物を待たない)', () => {
    expect(AI_CHAT_REQUEST_TIME_LIMIT_MS).toBeLessThan(AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS);
  });
});

describe('#2265 Q1 アーカイブの応答が返らないと、上限で止めを下ろす', () => {
  it('応答を返さない /close (打ち切りに応じない): 上限で止めが下り、一覧で確かめる一文を出し、新しい相談を始めて送れる', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(() => new Promise<never>(() => {}));
    await pressArchiveAndExpectLocked();

    await waitForUnlock();
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
    await waitForUnlock();

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

    await waitForUnlock();
    expect(alertCalls()).toContainEqual([ARCHIVE_SESSION_TIMEOUT_TITLE, ARCHIVE_SESSION_TIMEOUT_MESSAGE]);
    expect(alertCalls().some(([, message]) => message === ARCHIVE_FAILED_MESSAGE)).toBe(false);
    expect(screen.getByTestId('ai-new-session')).not.toBeDisabled();
  });

  it('トークンの取り出し (getSession) が返らない: 上限で止めを下ろし、/close は送らない', async () => {
    await openSheet();
    mockGetSession.mockImplementationOnce(() => new Promise<never>(() => {}));
    fireEvent.press(screen.getByTestId('ai-toggle-sessions'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    expect(screen.getByTestId('ai-new-session')).toBeDisabled();

    await waitForUnlock();
    expect(alertCalls()).toContainEqual([ARCHIVE_SESSION_TIMEOUT_TITLE, ARCHIVE_SESSION_TIMEOUT_MESSAGE]);
    expect(sentUrls()).not.toContain(CLOSE_URL);
    expect(screen.getByTestId('ai-new-session')).not.toBeDisabled();
  });

  it('受け付けたあと (ok の応答) に本文が返らない: 上限で止めを下ろし、時間切れ・失敗の一文は出さない (Web と同じ)', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: () => new Promise<never>(() => {}) }));
    await pressArchiveAndExpectLocked();

    await waitForUnlock();
    expect(alertCalls().some(([, message]) => message === ARCHIVE_SESSION_TIMEOUT_MESSAGE)).toBe(false);
    expect(alertCalls().some(([, message]) => message === ARCHIVE_FAILED_MESSAGE)).toBe(false);
    expect(createSessionCalls()).toHaveLength(0);
    expect(screen.getByTestId('ai-new-session')).not.toBeDisabled();
  });
});

describe('#2265 Q1 対照: 上限までに返った応答は今までどおり', () => {
  it('成功の応答: 新しい相談を 1 つ作り要約を出す。時間切れの一文は出さず、予約した上限で打ち切らない', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ summary: { summary: SUMMARY_TEXT } }) }));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(screen.getByText(SUMMARY_LINE)).toBeTruthy());
    expect(createSessionCalls()).toHaveLength(1);
    expect(closeSignal()?.aborted).toBe(false);
    expect(alertCalls().some(([, message]) => message === ARCHIVE_SESSION_TIMEOUT_MESSAGE)).toBe(false);
  });

  it('通信の失敗 (時間切れでない例外): 今までどおり『失敗しました』を出し、時間切れの一文は出さない', async () => {
    await openSheet();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Network request failed');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(alertCalls()).toContainEqual(['エラー', ARCHIVE_FAILED_MESSAGE]));
    await waitForUnlock();
    expect(alertCalls().some(([, message]) => message === ARCHIVE_SESSION_TIMEOUT_MESSAGE)).toBe(false);
  });
});
