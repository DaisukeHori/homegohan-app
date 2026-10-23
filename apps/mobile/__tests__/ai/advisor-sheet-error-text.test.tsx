/**
 * advisor-sheet-error-text.test.tsx
 * AI 相談シート (AIAdvisorSheet) のメッセージ送信が、相談の API の失敗 (404 / 500) で止まったときの Alert の文 (#1917)
 *
 * 送信はストリーミングで受けるため getApi() を通らない生の fetch で、失敗の応答は errorOfFailedResponse が
 * `HTTP <状態>: <本文>` の Error にする。以前は Alert にその message をそのまま出していたので、
 * 『HTTP 404: {"error":"…"}』のような生の文字列が出ていた。ここでは次を確かめる。
 *   - 本文の日本語の文 (error) だけを出し、'HTTP'・本文の JSON・code は出さない
 *   - 本文から文を取り出せない (JSON でない本文) ときは、汎用の文「送信に失敗しました。」を出す
 *   - 送らなかったメッセージは消える
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

async function sendAndFailWith(response: Response) {
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
  fetchMock.mockResolvedValueOnce(response);

  fireEvent.changeText(screen.getByTestId('ai-input'), '今日の献立は?');
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
  return alertSpy.mock.calls[0] as [string, string];
}

describe('AIAdvisorSheet — 送信が相談の API の失敗で止まったとき (#1917)', () => {
  it.each([
    { status: 404, body: { error: '相談が見つかりません', code: 'NOT_FOUND' }, shown: '相談が見つかりません' },
    { status: 500, body: { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }, shown: '処理中にエラーが発生しました' },
  ])('$status の本文の日本語の文だけを Alert に出し、生の文字列・code は出さない', async ({ status, body, shown }) => {
    const [title, text] = await sendAndFailWith(new Response(JSON.stringify(body), { status }));

    expect(title).toBe('エラー');
    expect(text).toBe(shown);
    expect(text).not.toContain('HTTP');
    expect(text).not.toContain(body.code);
    expect(text).not.toContain('{');
    expect(screen.queryByText('今日の献立は?')).toBeNull();
  });

  it('本文が JSON でない (ゲートウェイの HTML など) ときは、汎用の文を出す', async () => {
    const [title, text] = await sendAndFailWith(new Response('<html><body>Bad Gateway</body></html>', { status: 502 }));

    expect(title).toBe('エラー');
    expect(text).toBe('送信に失敗しました。');
  });
});
