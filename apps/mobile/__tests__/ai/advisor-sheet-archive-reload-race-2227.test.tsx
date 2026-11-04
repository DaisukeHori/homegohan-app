/**
 * #2227 H1 (整合ゲートの指摘): アーカイブの応答待ちの間に「最新の会話を読み込む」を押すと、新しい相談が作られなかった (回帰テスト)。
 *
 * 直す前: 取り直しの入口 (reloadAfterTimeout) とボタンの disabled がアーカイブ中を見なかったので、/close の応答を待つ間に
 * 取り直しを押すと取り直しが始まった (reloadingRef が立つ)。そのあと /close が返り、アーカイブが呼ぶ createNewSession が
 * 入口の「取り直しの最中は始めない」で黙って戻り、閉じた相談が今の相談のまま残った (要約の一文もその相談に足され、
 * 続けて送ると閉じた相談へ送った)。いまはアーカイブの最中は取り直しを止める (ボタンの disabled とハンドラの両側)。
 *
 * 同じ型 (await のあとに、reloadingRef / sendingRef の入口で黙って戻る関数を呼ぶ経路) の列挙:
 *   - AIAdvisorSheet の archiveSession → (/close の応答待ち) → createNewSession (入口: reloadingRef) … 本テストで固定する唯一の経路
 *   - それ以外で await のあとに呼ぶのは loadMessages・reloadAfterIncompleteReply・fetchSessions・showSessionId で、どれも入口で
 *     黙って戻らない。黙って戻る入口を持つ sendMessage・reloadAfterTimeout・selectSession は押下からだけ呼ばれる
 *   - Web の AIChatBubble には reloadingRef / sendingRef の入口が無く (取り直しは送信の中で待ち、取り直しのボタンが無い)、
 *     closeSession が await のあとに呼ぶ fetchSessions・createNewSession も入口で黙って戻らない
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
import { AI_CHAT_RELOAD_TIMEOUT_MS } from '../../src/lib/ai-chat-timeout';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const NEW_SESSION = { id: 'session-new', title: 'AI相談', messageCount: 0, status: 'active' };
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const CLOSE_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/close`;
const NEW_SESSION_SEND_URL = `http://localhost:3000/api/ai/consultation/sessions/${NEW_SESSION.id}/messages?stream=true`;
const OLD_SESSION_SEND_URL = `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/messages?stream=true`;
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];
const SENT_TEXT = '今夜の夕食を1食作って';
const NEXT_TEXT = '明日の朝ごはんも1食作って';
const SUMMARY_TEXT = '夕飯に野菜を足す相談でした';

const fetchMock = jest.fn();

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** 取り直しの GET (上限つき) は reload を待ってから返す。開き直しの GET (上限なし) はすぐ返す */
let reloadGate: { promise: Promise<void>; release: () => void } = gate();

beforeEach(() => {
  jest.clearAllMocks();
  reloadGate = gate();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string, init?: unknown) => {
    if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION] };
    if (requestPath === MESSAGES_PATH && init) {
      await reloadGate.promise;
      return { messages: OLD_MESSAGES };
    }
    if (requestPath === MESSAGES_PATH) return { messages: OLD_MESSAGES };
    throw new Error(`unexpected GET ${requestPath}`);
  });
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockImplementation(() => ({ eq: mockEq }));
  mockEq.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  reloadGate.release();
});

const inputValue = () => screen.getByTestId('ai-input').props.value as string;

async function openSheetAndTimeOutSend() {
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
  fetchMock.mockRejectedValueOnce(abortError());
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy());
}

/** /close の応答を close が解けるまで返さない (要約の LLM を待つあいだ) */
function holdCloseResponse() {
  const close = gate();
  fetchMock.mockImplementationOnce(async () => {
    await close.promise;
    return { ok: true, status: 200, json: async () => ({ summary: { summary: SUMMARY_TEXT } }) };
  });
  mockPost.mockResolvedValueOnce({ success: true, session: { id: NEW_SESSION.id } });
  return close;
}

const reloadStarted = () =>
  mockGet.mock.calls.some(([path, init]) => path === MESSAGES_PATH && init !== undefined && JSON.stringify(init) === JSON.stringify({ timeoutMs: AI_CHAT_RELOAD_TIMEOUT_MS }));

/** アーカイブの応答が返ったあと、新しい相談が作られ、そこが今の相談になったことを確かめる */
async function expectNewSessionAfterArchive(close: { release: () => void }) {
  await act(async () => {
    close.release();
  });
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/ai/consultation/sessions', { title: 'AI相談' }));
  await waitFor(() => expect(screen.getByText(`📝 相談を要約しました：\n\n${SUMMARY_TEXT}`)).toBeTruthy());
  // 閉じた相談の会話は消え、案内も外れる
  expect(screen.queryByText('野菜を足しましょう')).toBeNull();
  expect(screen.queryByTestId('ai-timeout-notice')).toBeNull();

  // 続けて送ると、新しい相談へ送る (閉じた相談へは送らない)
  reloadGate.release();
  fetchMock.mockRejectedValueOnce(abortError());
  fireEvent.changeText(screen.getByTestId('ai-input'), NEXT_TEXT);
  await waitFor(() => expect(screen.getByTestId('ai-send-btn')).not.toBeDisabled());
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(NEW_SESSION_SEND_URL, expect.anything()));
  const sentUrls = fetchMock.mock.calls.map(([url]) => url);
  expect(sentUrls.filter((url) => url === OLD_SESSION_SEND_URL)).toHaveLength(1);
}

describe('#2227 H1 アーカイブの応答待ちの間は「最新の会話を読み込む」を始めない', () => {
  it('アーカイブの最中は取り直しのボタンを止め、押しても取り直さず、応答のあと新しい相談が今の相談になる', async () => {
    await openSheetAndTimeOutSend();
    const close = holdCloseResponse();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));

    // 描画の側: 案内は出たままだが、取り直しのボタンは押せない
    expect(screen.getByTestId('ai-timeout-notice')).toBeTruthy();
    expect(screen.getByTestId('ai-timeout-reload')).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    expect(reloadStarted()).toBe(false);

    await expectNewSessionAfterArchive(close);
    expect(reloadStarted()).toBe(false);
    expect(inputValue()).toBe('');
  });

  it('アーカイブと同じ描画のうちに取り直しを押しても (ボタンを止める描画の前)、取り直さず、応答のあと新しい相談が今の相談になる', async () => {
    await openSheetAndTimeOutSend();
    const close = holdCloseResponse();
    // ハンドラの側: アーカイブを押した直後、ボタンを止める描画を待たずに取り直しを押す
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' })));
    expect(reloadStarted()).toBe(false);

    await expectNewSessionAfterArchive(close);
    expect(reloadStarted()).toBe(false);
  });

  it('アーカイブが終われば、取り直しのボタンをまた押せる (失敗したアーカイブのあと。止めたままにしない対照)', async () => {
    await openSheetAndTimeOutSend();
    const close = gate();
    fetchMock.mockImplementationOnce(async () => {
      await close.promise;
      return { ok: false, status: 500, json: async () => ({ error: 'failed' }) };
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });
    expect(screen.getByTestId('ai-timeout-reload')).toBeDisabled();
    await act(async () => {
      close.release();
    });
    await waitFor(() => expect(screen.getByTestId('ai-timeout-reload')).not.toBeDisabled());
    expect(mockPost).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-timeout-reload'));
    });
    await waitFor(() => expect(reloadStarted()).toBe(true));
  });
});
