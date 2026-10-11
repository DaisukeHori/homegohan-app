/**
 * stopped-by-server-raw-fetch.test.tsx
 * 生の fetch で AI 相談に送る 2 画面が、上限 (429 AI_DAILY_LIMIT。#1149) と緊急停止・メンテナンス中
 * (503 AI_CHAT_DISABLED / MAINTENANCE_MODE。#1457) の両方を、同じ 1 つの読み取り口 (src/lib/failed-response.ts の
 * errorOfFailedResponse) で固定の文にする — 2 つの変更を合わせたときの回帰テスト
 *
 * 2 つの変更は、同じ `if (!res.ok)` の分岐と catch の分岐をそれぞれ書き換えていた。片方の判定だけが残ると、
 * もう片方の応答で生の文字列 (`HTTP 429: {...}` / `HTTP 503: {...}`) が出る。ここでは 1 つのテストで 3 つの応答を順に流し、
 * どれも固定の文になること、送らなかったメッセージを消して入力を戻すこと、同意の 403 の見分けが壊れていないことを確かめる。
 *
 * 1. 相談の画面 (app/ai/[sessionId].tsx): 画面の中の一行で固定の文を出す (Alert は出さない)
 * 2. AI アドバイザーのシート (AIAdvisorSheet): Alert で固定の文を出す
 *    (見出しは、緊急停止・メンテナンス中は「ご利用いただけません」、上限は「エラー」)
 *
 * getApi() は本物を使い、その下の @homegohan/core の createHttpClient だけを差し替える。送信は global.fetch を差し替える。
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
import AiSessionPage from '../../app/ai/[sessionId]';
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';
import { aiDailyLimitMessage } from '../../src/lib/ai-daily-limit';
import { resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';

/** サーバーとは違う文を入れた本文。画面に出す文は本文の文字列ではなく、code (と limit) から決めた固定の文であることを確かめる */
const SERVER_TEXT = 'サーバーが返した別の文';
/** 上限の回数 (本文の limit)。固定の文はこの値から作る */
const LIMIT = 7;

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_FORBIDDEN = 403;

/** [見出しのラベル, 状態, 本文, 画面に出る固定の文, シートの Alert の見出し] */
const CASES = [
  [
    '上限 (429 AI_DAILY_LIMIT)',
    HTTP_TOO_MANY_REQUESTS,
    JSON.stringify({ error: SERVER_TEXT, code: 'AI_DAILY_LIMIT', limit: LIMIT, retryAfter: 3600 }),
    aiDailyLimitMessage(LIMIT),
    'エラー',
  ],
  [
    'AI 相談の緊急停止 (503 AI_CHAT_DISABLED)',
    HTTP_SERVICE_UNAVAILABLE,
    JSON.stringify({ error: SERVER_TEXT, code: AI_CHAT_DISABLED_CODE, retryAfter: 60 }),
    AI_CHAT_DISABLED_MESSAGE,
    'ご利用いただけません',
  ],
  [
    'メンテナンス中 (503 MAINTENANCE_MODE)',
    HTTP_SERVICE_UNAVAILABLE,
    JSON.stringify({ error: { code: MAINTENANCE_API_CODE, message: SERVER_TEXT } }),
    MAINTENANCE_MESSAGE,
    'ご利用いただけません',
  ],
] as const;

const CONSENT_BODY = JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE });

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();
const ORIGINAL_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsentPromptForTests();
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

describe('相談の画面 (app/ai/[sessionId].tsx) の送信 (生の fetch)', () => {
  const PLACEHOLDER = '相談内容を入力...';

  async function renderAndSend(text: string) {
    mockClient.get.mockResolvedValue({ messages: [] });
    render(<AiSessionPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeTruthy());
    fireEvent.changeText(screen.getByPlaceholderText(PLACEHOLDER), text);
    const pressables = screen.UNSAFE_getAllByType(Pressable);
    await act(async () => {
      fireEvent.press(pressables[pressables.length - 1]);
    });
  }

  it.each(CASES)('%s: 固定の文を画面に出し、メッセージを消して入力を戻す (生の文字列・Alert は出さない)', async (_label, status, body, expected) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));
    await renderAndSend('今日の夕飯は?');

    await waitFor(() => expect(screen.getByTestId('ai-chat-error-text').props.children).toBe(expected));
    const shown = String(screen.getByTestId('ai-chat-error-text').props.children);
    expect(shown).not.toContain('HTTP');
    expect(shown).not.toContain(SERVER_TEXT);
    expect(screen.queryByText('今日の夕飯は?')).toBeNull();
    expect(screen.getByPlaceholderText(PLACEHOLDER).props.value).toBe('今日の夕飯は?');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('同意の 403 は、これまでどおり同意の案内を出す (上限・停止の判定に吸い込まれない)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(CONSENT_BODY, { status: HTTP_FORBIDDEN }));
    await renderAndSend('こんにちは');

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array)));
    expect(screen.queryByTestId('ai-chat-error-text')).toBeNull();
    expect(screen.getByPlaceholderText(PLACEHOLDER).props.value).toBe('こんにちは');
  });
});

describe('AI アドバイザーのシート (AIAdvisorSheet) の送信 (生の fetch)', () => {
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

  async function openSheetAndSend(text: string) {
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('ai-input'), text);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });
  }

  it.each(CASES)('%s: 固定の文の Alert を 1 回だけ出し、入力を戻す (生の文字列は出さない)', async (_label, status, body, expected, title) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));
    await openSheetAndSend('今日の献立は?');

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(title, expected));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const shown = String(alertSpy.mock.calls[0][1]);
    expect(shown).not.toContain('HTTP');
    expect(shown).not.toContain(SERVER_TEXT);
    expect(screen.queryByText('今日の献立は?')).toBeNull();
    expect(screen.getByTestId('ai-input').props.value).toBe('今日の献立は?');
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/ai/consultation/sessions/${OLD_SESSION.id}/messages?stream=true`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
