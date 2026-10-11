/**
 * service-unavailable.test.tsx
 * AI 相談の画面が、緊急停止中 (503 AI_CHAT_DISABLED)・メンテナンス中 (503 MAINTENANCE_MODE) に、
 * 生の文字列「HTTP 503 …: {"error":…}」ではなく固定の文を出す (#1457)
 *
 * getApi() は本物を使い、その下の @homegohan/core の createHttpClient だけを差し替える
 * (本物の createHttpClient と同じ `HTTP 503 Service Unavailable: <本文>` の Error を投げさせる)。
 * 生の fetch で送る AI 相談の送信 (相談の画面・AI アドバイザーのシート) は、global.fetch を差し替える。
 *
 * 1. 相談の一覧 (app/ai/index.tsx): 読み込み・新しい相談の作成が 503 なら、固定の文を出す
 * 2. 相談の画面 (app/ai/[sessionId].tsx): 送信が 503 なら、固定の文を出し、送らなかったメッセージを消して入力を戻す
 * 3. AI アドバイザーのシート: 送信・相談を閉じる操作が 503 なら、固定の文の Alert を出す
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import {
  AI_CHAT_DISABLED_CODE,
  AI_CHAT_DISABLED_MESSAGE,
  MAINTENANCE_API_CODE,
  MAINTENANCE_MESSAGE,
} from '@homegohan/shared';

const mockClient = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  del: jest.fn(),
};
jest.mock('@homegohan/core', () => ({
  ...jest.requireActual('@homegohan/core'),
  createHttpClient: jest.fn(() => mockClient),
}));

const mockGetSession = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
    channel: jest.fn(),
    from: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'session-1' }),
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  Link: ({ children }: { children?: React.ReactNode }) => children,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import React from 'react';
import { Pressable } from 'react-native';
import AiSessionsPage from '../../app/ai/index';
import AiSessionPage from '../../app/ai/[sessionId]';
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';

// 非同期の段数が多く、遅い環境で既定の 1 秒では足りないことがあるため、長めに待つ
const WAIT = { timeout: 5000 };

/** サーバーとは違う文を入れた本文。画面に出す文は本文の文字列ではなく、code から決めた固定の文であることを確かめる */
const SERVER_TEXT = 'サーバーが返した別の文';
const AI_CHAT_DISABLED_BODY = JSON.stringify({ error: SERVER_TEXT, code: AI_CHAT_DISABLED_CODE, retryAfter: 60 });
const MAINTENANCE_BODY = JSON.stringify({ error: { code: MAINTENANCE_API_CODE, message: SERVER_TEXT } });

const CASES = [
  ['AI 相談の緊急停止中', AI_CHAT_DISABLED_BODY, AI_CHAT_DISABLED_MESSAGE],
  ['メンテナンス中', MAINTENANCE_BODY, MAINTENANCE_MESSAGE],
] as const;

/** 本物の createHttpClient が 503 で投げる Error と同じ形 */
function clientError503(body: string): Error {
  return new Error(`HTTP 503 Service Unavailable: ${body}`);
}

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();
const ORIGINAL_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockClient)) fn.mockReset();
  // expo/virtual/env が読み込み時の process.env を握るので、差し替えずに同じオブジェクトを書き換える
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
});

afterAll(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE_URL;
});

describe('相談の一覧 (app/ai/index.tsx)', () => {
  it.each(CASES)('%s: 読み込みが 503 なら、固定の文を出す (生の文字列を出さない)', async (_label, body, expected) => {
    mockClient.get.mockRejectedValue(clientError503(body));
    render(<AiSessionsPage />);

    await waitFor(() => expect(screen.getByTestId('ai-sessions-error-text')).toBeTruthy(), WAIT);
    const text = screen.getByTestId('ai-sessions-error-text').props.children;
    expect(text).toBe(expected);
    expect(String(text)).not.toContain('HTTP');
    expect(String(text)).not.toContain(SERVER_TEXT);
  });

  it.each(CASES)('%s: 新しい相談の作成が 503 なら、固定の文を出す', async (_label, body, expected) => {
    mockClient.get.mockResolvedValue({ sessions: [] });
    mockClient.post.mockRejectedValue(clientError503(body));
    render(<AiSessionsPage />);
    await waitFor(() => expect(screen.getByTestId('ai-sessions-empty')).toBeTruthy(), WAIT);

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-new-session-button'));
    });

    await waitFor(() => expect(screen.getByTestId('ai-sessions-error-text').props.children).toBe(expected), WAIT);
  });
});

describe('相談の画面 (app/ai/[sessionId].tsx)', () => {
  async function typeAndSend(text: string) {
    fireEvent.changeText(screen.getByPlaceholderText('相談内容を入力...'), text);
    const pressables = screen.UNSAFE_getAllByType(Pressable);
    await act(async () => {
      fireEvent.press(pressables[pressables.length - 1]);
    });
  }

  it.each(CASES)('%s: 送信 (生の fetch) が 503 なら、固定の文を出し、メッセージを消して入力を戻す', async (_label, body, expected) => {
    mockClient.get.mockResolvedValue({ messages: [] });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 503 }));
    render(<AiSessionPage />);
    await waitFor(() => expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy(), WAIT);

    await typeAndSend('今日の夕飯は?');

    await waitFor(() => expect(screen.getByTestId('ai-chat-error-text').props.children).toBe(expected), WAIT);
    expect(String(screen.getByTestId('ai-chat-error-text').props.children)).not.toContain('HTTP');
    // 送らなかったメッセージは消え、入力が戻る
    expect(screen.queryByText('今日の夕飯は?')).toBeNull();
    expect(screen.getByPlaceholderText('相談内容を入力...').props.value).toBe('今日の夕飯は?');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/ai/consultation/sessions/session-1/messages?stream=true',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it.each(CASES)('%s: メッセージの読み込み (getApi) が 503 なら、固定の文を出す', async (_label, body, expected) => {
    mockClient.get.mockRejectedValue(clientError503(body));
    render(<AiSessionPage />);

    await waitFor(() => expect(screen.getByTestId('ai-chat-error-text').props.children).toBe(expected), WAIT);
  });

  it('503 でも緊急停止・メンテナンス中でない本文は、これまでどおりの表示 (固定の文に置き換えない)', async () => {
    mockClient.get.mockResolvedValue({ messages: [] });
    const otherBody = JSON.stringify({ error: '同意の状況を確認できませんでした', code: 'AI_CONSENT_CHECK_FAILED' });
    fetchMock.mockResolvedValueOnce(new Response(otherBody, { status: 503 }));
    render(<AiSessionPage />);
    await waitFor(() => expect(screen.getByPlaceholderText('相談内容を入力...')).toBeTruthy(), WAIT);

    await typeAndSend('こんにちは');

    await waitFor(() => expect(screen.getByTestId('ai-chat-error-text')).toBeTruthy(), WAIT);
    const text = screen.getByTestId('ai-chat-error-text').props.children;
    expect(text).not.toBe(AI_CHAT_DISABLED_MESSAGE);
    expect(text).not.toBe(MAINTENANCE_MESSAGE);
  });
});

describe('AI アドバイザーのシート (AIAdvisorSheet)', () => {
  const OLD_SESSION = { id: 'session-old', title: 'AI相談', messageCount: 2, status: 'active' };
  const OLD_MESSAGES = [
    { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
  ];

  beforeEach(() => {
    mockClient.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [OLD_SESSION] };
      if (path === `/api/ai/consultation/sessions/${OLD_SESSION.id}/messages`) return { messages: OLD_MESSAGES };
      throw new Error(`unexpected GET ${path}`);
    });
  });

  async function openSheet() {
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy(), WAIT);
  }

  it.each(CASES)('%s: 送信 (生の fetch) が 503 なら、固定の文の Alert を出し、入力を戻す', async (_label, body, expected) => {
    await openSheet();
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 503 }));

    fireEvent.changeText(screen.getByTestId('ai-input'), '今日の献立は?');
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ご利用いただけません', expected), WAIT);
    // 「エラー」の Alert (生の文字列) は出さない
    expect(alertSpy.mock.calls.map((c) => c[0])).toEqual(['ご利用いただけません']);
    expect(screen.getByTestId('ai-input').props.value).toBe('今日の献立は?');
  });

  it.each(CASES)('%s: 相談を閉じる操作が 503 なら、固定の文の Alert を出す', async (_label, body, expected) => {
    await openSheet();
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 503, headers: { 'Content-Type': 'application/json' } }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ご利用いただけません', expected), WAIT);
    expect(alertSpy.mock.calls.map((c) => c[0])).toEqual(['ご利用いただけません']);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/ai/consultation/sessions/${OLD_SESSION.id}/close`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
