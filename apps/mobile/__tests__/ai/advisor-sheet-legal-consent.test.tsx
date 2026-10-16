/**
 * advisor-sheet-legal-consent.test.tsx
 * AI アドバイザーのシート (AIAdvisorSheet) が、規約・プライバシーポリシーへの同意が必要 (403 LEGAL_CONSENT_REQUIRED) で
 * 止められたとき、LegalConsentProvider に知らせて (ゲートが同意画面だけにする)「同意が必要です」の Alert を出す (#1442。T-AS1 / T-AS2)
 *
 * getApi() は本物を使い、その下の @homegohan/core の createHttpClient だけを差し替える
 * (service-unavailable.test.tsx と同じ)。送信と相談を閉じるは生の fetch なので、global.fetch を差し替える。
 * src/lib/legal-consent は本物で、subscribeLegalConsentEvents で知らせを記録する。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { LEGAL_CONSENT_REQUIRED_CODE, LEGAL_CONSENT_REQUIRED_MESSAGE } from '@homegohan/shared';

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
import {
  resetLegalConsentListenersForTests,
  subscribeLegalConsentEvents,
  type LegalConsentEvent,
} from '../../src/lib/legal-consent';

/** サーバーとは違う文を入れた本文の error。画面に出す文は本文の文字列ではなく、固定の文であることを確かめる */
const SERVER_TEXT = 'サーバーが返した別の文';
const LEGAL_BODY = JSON.stringify({ error: SERVER_TEXT, code: LEGAL_CONSENT_REQUIRED_CODE });
const AI_CONSENT_BODY = JSON.stringify({ error: 'AIの同意が必要です', code: 'AI_CONSENT_REQUIRED' });

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CLOSE_URL = 'http://localhost:3000/api/ai/consultation/sessions/session-old/close';
const NEW_SESSION_PATH = '/api/ai/consultation/sessions';

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();
const ORIGINAL_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
let events: LegalConsentEvent[];

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockClient)) fn.mockReset();
  resetLegalConsentListenersForTests();
  events = [];
  subscribeLegalConsentEvents((event) => events.push(event));
  // expo/virtual/env が読み込み時の process.env を握るので、差し替えずに同じオブジェクトを書き換える
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
});

afterEach(() => {
  resetLegalConsentListenersForTests();
});

afterAll(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE_URL;
});

describe('AI アドバイザーのシート — 規約の同意が必要 (403 LEGAL_CONSENT_REQUIRED。#1442)', () => {
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
    mockClient.post.mockResolvedValue({ session: { id: 'session-new' } });
  });

  async function openSheet() {
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
  }

  function alertTitles(): unknown[] {
    return alertSpy.mock.calls.map((call) => call[0]);
  }

  it('T-AS1: 相談を閉じる操作 (ai-archive-btn) の生の fetch が 403 LEGAL_CONSENT_REQUIRED なら、購読者に required を 1 回知らせ、Alert を「同意が必要です」と固定の文で 1 回だけ出す。新しいセッションの作成を呼ばない', async () => {
    await openSheet();
    fetchMock.mockResolvedValueOnce(new Response(LEGAL_BODY, { status: 403, headers: JSON_HEADERS }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('同意が必要です', LEGAL_CONSENT_REQUIRED_MESSAGE));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    // 「エラー」の Alert (本文の文) は出さない
    expect(alertTitles()).toEqual(['同意が必要です']);
    expect(alertSpy.mock.calls.flat()).not.toContain(SERVER_TEXT);
    expect(events).toEqual(['required']);
    expect(fetchMock).toHaveBeenCalledWith(CLOSE_URL, expect.objectContaining({ method: 'POST' }));
    // 新しいセッションは作らない
    expect(mockClient.post.mock.calls.map((call) => call[0])).not.toContain(NEW_SESSION_PATH);
  });

  it('T-AS1: 403 AI_CONSENT_REQUIRED は今までどおり Alert「エラー」で、required を知らせない', async () => {
    await openSheet();
    fetchMock.mockResolvedValueOnce(new Response(AI_CONSENT_BODY, { status: 403, headers: JSON_HEADERS }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('エラー', 'AIの同意が必要です'));
    expect(alertTitles()).toEqual(['エラー']);
    expect(events).toEqual([]);
  });

  it('T-AS1: 500 は今までどおり Alert「エラー」で、required を知らせない', async () => {
    await openSheet();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'archive failed' }), { status: 500, headers: JSON_HEADERS }),
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-archive-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('エラー', 'archive failed'));
    expect(alertTitles()).toEqual(['エラー']);
    expect(events).toEqual([]);
  });

  it('T-AS2: 送信 (ai-send-btn) の生の fetch が 403 LEGAL_CONSENT_REQUIRED なら、購読者に required を 1 回知らせ、Alert を「同意が必要です」と固定の文で 1 回だけ出し、入力を戻す (送らなかったメッセージは消す)', async () => {
    await openSheet();
    fetchMock.mockResolvedValueOnce(new Response(LEGAL_BODY, { status: 403, headers: JSON_HEADERS }));

    fireEvent.changeText(screen.getByTestId('ai-input'), '今日の献立は?');
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('同意が必要です', LEGAL_CONSENT_REQUIRED_MESSAGE));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertTitles()).toEqual(['同意が必要です']);
    expect(events).toEqual(['required']);
    // 入力を戻し、送らなかったメッセージは画面から消す
    expect(screen.getByTestId('ai-input').props.value).toBe('今日の献立は?');
    expect(screen.queryByText('今日の献立は?')).toBeNull();
  });
});
