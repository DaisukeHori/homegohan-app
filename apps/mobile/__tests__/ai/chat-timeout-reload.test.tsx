/**
 * #1049 F7-18: 全画面の AI 相談 (app/ai/[sessionId].tsx) の送信が時間切れになったとき。
 *
 * 以前は送った文を消し「応答がタイムアウトしました（25秒）。…再度お試しください。」とだけ出していた。
 * サーバーは送った文を先に保存し、返答の作成と保存を続けていることがあるので、AIAdvisorSheet と同じく
 * (src/lib/ai-chat-timeout.ts の扱い) 次を確かめる。
 *   1. 時間切れになったら、送った文 (と添付の画像) を入力欄に戻し、会話を取り直す導線を出す
 *   2. 取り直しで返答まで届いていたら、会話を出し、戻した文と画像を消し、導線を消す
 *   3. 届いているが返答がまだ無ければ、戻した文を消し、返答を待つ案内と導線を残す
 *   4. 届いていなければ、導線を消し、入力欄の文を残して、もう一度送るように知らせる
 *   5. 取り直しに失敗したら、今の会話と導線を残してエラーを出す
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockGet = jest.fn();
const mockGetSession = jest.fn();
const mockLaunchImageLibrary = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: jest.fn(), del: jest.fn() }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'session-1' }),
  router: { back: jest.fn(), push: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibrary(...args),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import React from 'react';
import AiSessionPage from '../../app/ai/[sessionId]';
import {
  TIMEOUT_DELIVERED_NO_REPLY_MESSAGE,
  TIMEOUT_NOTICE_MESSAGE,
  TIMEOUT_NOT_DELIVERED_MESSAGE,
  TIMEOUT_RELOAD_FAILED_MESSAGE,
} from '../../src/lib/ai-chat-timeout';

const MESSAGES_PATH = '/api/ai/consultation/sessions/session-1/messages';
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];
const SENT_TEXT = '鶏むね肉の使い方は?';
const SAVED_REPLY = '鶏むね肉は低温調理がおすすめです';
const SAVED_USER = { id: 'm3', role: 'user', content: SENT_TEXT, createdAt: '2026-10-08T00:01:00.000Z' };
const SAVED_MESSAGES = [
  ...OLD_MESSAGES,
  SAVED_USER,
  { id: 'm4', role: 'assistant', content: SAVED_REPLY, createdAt: '2026-10-08T00:01:30.000Z' },
];

const fetchMock = jest.fn();
let serverMessages: unknown[] = OLD_MESSAGES;

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

beforeEach(() => {
  jest.clearAllMocks();
  serverMessages = OLD_MESSAGES;
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string) => {
    if (requestPath === MESSAGES_PATH) return { messages: serverMessages };
    throw new Error(`unexpected GET ${requestPath}`);
  });
});

const inputValue = () => screen.getByTestId('ai-chat-input').props.value as string;

async function openPage() {
  render(<AiSessionPage />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
}

/** 文を送り、送信が時間切れ (AbortError) で終わるまで待つ */
async function sendAndTimeOut() {
  fetchMock.mockRejectedValueOnce(abortError());
  fireEvent.changeText(screen.getByTestId('ai-chat-input'), SENT_TEXT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-chat-send-button'));
  });
  await waitFor(() => expect(screen.getByTestId('ai-chat-timeout-notice')).toBeTruthy());
}

async function pressReload() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-chat-timeout-reload'));
  });
}

describe('全画面の AI 相談 — 送信が時間切れになったとき (#1049 F7-18)', () => {
  it('送った文を入力欄に戻し、失敗の文ではなく取り直しの導線を出す', async () => {
    await openPage();
    await sendAndTimeOut();

    expect(inputValue()).toBe(SENT_TEXT);
    expect(screen.getByText(TIMEOUT_NOTICE_MESSAGE)).toBeTruthy();
    expect(screen.queryByTestId('ai-chat-error-text')).toBeNull();
    expect(screen.queryByText(/応答がタイムアウトしました/)).toBeNull();
  });

  it('取り直しで返答まで届いていたら、会話を出し、戻した文を消し、導線を消す', async () => {
    await openPage();
    await sendAndTimeOut();

    serverMessages = SAVED_MESSAGES;
    mockGet.mockClear();
    await pressReload();

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH);
    expect(screen.getByText(SENT_TEXT)).toBeTruthy();
    expect(inputValue()).toBe('');
    expect(screen.queryByTestId('ai-chat-timeout-notice')).toBeNull();
  });

  it('届いているが返答がまだ無ければ、戻した文を消し、返答を待つ案内と導線を残す', async () => {
    await openPage();
    await sendAndTimeOut();

    serverMessages = [...OLD_MESSAGES, SAVED_USER];
    await pressReload();

    await waitFor(() => expect(screen.getByText(TIMEOUT_DELIVERED_NO_REPLY_MESSAGE)).toBeTruthy());
    expect(inputValue()).toBe('');
    expect(screen.getByTestId('ai-chat-timeout-reload')).toBeTruthy();
  });

  it('届いていたと分かっても、入力欄を書き換えていれば消さない', async () => {
    await openPage();
    await sendAndTimeOut();

    fireEvent.changeText(screen.getByTestId('ai-chat-input'), 'ささみも教えて');
    serverMessages = SAVED_MESSAGES;
    await pressReload();

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(inputValue()).toBe('ささみも教えて');
  });

  it('届いていなければ、導線を消し、入力欄の文を残して、もう一度送るように知らせる', async () => {
    await openPage();
    await sendAndTimeOut();

    await pressReload();

    await waitFor(() => expect(screen.getByText(TIMEOUT_NOT_DELIVERED_MESSAGE)).toBeTruthy());
    expect(screen.queryByTestId('ai-chat-timeout-notice')).toBeNull();
    expect(inputValue()).toBe(SENT_TEXT);
  });

  it('取り直しに失敗したら、今の会話と導線を残してエラーを出す', async () => {
    await openPage();
    await sendAndTimeOut();

    mockGet.mockImplementation(async () => {
      throw new Error('Network request failed');
    });
    await pressReload();

    await waitFor(() => expect(screen.getByText(TIMEOUT_RELOAD_FAILED_MESSAGE)).toBeTruthy());
    expect(screen.getByText('野菜を足しましょう')).toBeTruthy();
    expect(screen.getByTestId('ai-chat-timeout-notice')).toBeTruthy();
    expect(inputValue()).toBe(SENT_TEXT);
  });

  it('添付の画像も戻し、届いていたと分かったら外す', async () => {
    mockLaunchImageLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///photo.jpg', base64: 'QUJD' }],
    });
    await openPage();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-chat-image-attach-button'));
    });
    await waitFor(() => expect(screen.getByTestId('ai-chat-image-preview')).toBeTruthy());

    await sendAndTimeOut();
    expect(screen.getByTestId('ai-chat-image-preview')).toBeTruthy();

    serverMessages = SAVED_MESSAGES;
    await pressReload();

    await waitFor(() => expect(screen.getByText(SAVED_REPLY)).toBeTruthy());
    expect(screen.queryByTestId('ai-chat-image-preview')).toBeNull();
  });
});
