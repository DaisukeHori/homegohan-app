/**
 * service-unavailable.test.tsx
 * AI アドバイザーのシート (AIAdvisorSheet) が、緊急停止中 (503 AI_CHAT_DISABLED)・メンテナンス中 (503 MAINTENANCE_MODE) に、
 * 生の文字列「HTTP 503 …: {"error":…}」ではなく固定の文を出す (#1457)
 *
 * getApi() は本物を使い、その下の @homegohan/core の createHttpClient だけを差し替える
 * (本物の createHttpClient と同じ `HTTP 503 Service Unavailable: <本文>` の Error を投げさせる)。
 * 生の fetch で送る AI 相談の送信は、global.fetch を差し替える。
 *
 * AI アドバイザーのシート: 送信・相談を閉じる操作が 503 なら、固定の文の Alert を出す
 * (相談の一覧・相談の画面 (app/ai/) は、通常の操作で届かないネイティブの画面として消した。#1598)
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
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
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
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';

/** サーバーとは違う文を入れた本文。画面に出す文は本文の文字列ではなく、code から決めた固定の文であることを確かめる */
const SERVER_TEXT = 'サーバーが返した別の文';
const AI_CHAT_DISABLED_BODY = JSON.stringify({ error: SERVER_TEXT, code: AI_CHAT_DISABLED_CODE, retryAfter: 60 });
// サーバーのメンテナンス中の 503 の本文 (#1486 から AI 相談の緊急停止と同じ平らな形)
const MAINTENANCE_BODY = JSON.stringify({ error: SERVER_TEXT, code: MAINTENANCE_API_CODE, retryAfter: 300 });

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
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
  }

  it.each(CASES)('%s: 送信 (生の fetch) が 503 なら、固定の文の Alert を出し、入力を戻す', async (_label, body, expected) => {
    await openSheet();
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 503 }));

    fireEvent.changeText(screen.getByTestId('ai-input'), '今日の献立は?');
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ご利用いただけません', expected));
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

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ご利用いただけません', expected));
    expect(alertSpy.mock.calls.map((c) => c[0])).toEqual(['ご利用いただけません']);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/ai/consultation/sessions/${OLD_SESSION.id}/close`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
