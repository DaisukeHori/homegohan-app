/**
 * advisor-sheet-daily-limit.test.tsx
 * AI 相談シート (AIAdvisorSheet。全タブの AIFloatingFab から開く) のメッセージ送信が、「今日の AI の利用回数の上限に
 * 達しました」(429 AI_DAILY_LIMIT。#1149 / T40) で止められたとき
 *
 * 送信はストリーミングで受けるため getApi() を通らない生の fetch で、getApi() の置き換えが効かない。
 * 以前は Alert に `HTTP 429: {...JSON...}` をそのまま出していた (R1 の指摘)。ここでは次を確かめる。
 *   - Alert には固定の文 (aiDailyLimitMessage(limit)) だけが出て、生の文字列 (HTTP 429・JSON) は出ない
 *   - 送らなかったメッセージは消え、入力が戻る。シートは閉じない (同意の案内とは違い、移る先の画面が無い)
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockGetSession = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost, del: jest.fn(), patch: jest.fn() }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

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

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children,
}));

import React from 'react';
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';
import { aiDailyLimitMessage } from '../../src/lib/ai-daily-limit';

const WAIT = { timeout: 5000 };
const LIMIT = 10;
const LIMIT_BODY = JSON.stringify({
  error: aiDailyLimitMessage(LIMIT),
  code: 'AI_DAILY_LIMIT',
  limit: LIMIT,
  retryAfter: 43210,
});
const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION] };
    if (path === `/api/ai/consultation/sessions/${SESSION.id}/messages`) return { messages: MESSAGES };
    throw new Error(`unexpected GET ${path}`);
  });
});

describe('AIAdvisorSheet — 送信が 429 AI_DAILY_LIMIT で止められたとき', () => {
  it('Alert に固定の文を出し、生の文字列は出さない。送らなかったメッセージを消して入力を戻し、シートは閉じない', async () => {
    const onClose = jest.fn();
    render(<AIAdvisorSheet visible onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy(), WAIT);
    fetchMock.mockResolvedValueOnce(new Response(LIMIT_BODY, { status: 429 }));

    fireEvent.changeText(screen.getByTestId('ai-input'), '今日の献立は?');
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1), WAIT);
    expect(alertSpy).toHaveBeenCalledWith('エラー', aiDailyLimitMessage(LIMIT));
    const shown = alertSpy.mock.calls[0][1] as string;
    expect(shown).not.toContain('HTTP 429');
    expect(shown).not.toContain('AI_DAILY_LIMIT');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('今日の献立は?')).toBeNull();
    expect(screen.getByTestId('ai-input').props.value).toBe('今日の献立は?');
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/ai/consultation/sessions/${SESSION.id}/messages?stream=true`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
