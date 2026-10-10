/**
 * advisor-sheet-consent.test.tsx
 * AI 相談シート (AIAdvisorSheet) の、外国の AI 事業者への提供の同意まわりの振る舞い (T15 / #1154)
 *
 * 1. 相談を閉じたとき (POST .../close)
 *    - 同意が無くて (または同意の状況を読めなくて) サーバーが要約 (AI) を省いた (aiSkipped) ら、その旨の一文を出す。
 *      閉じたあとに作る新しいセッション (createNewSession) は messages を置き換えるので、一文はその「あと」に足す。
 *      先に足すと、作成を待つ間しか出ずに消える (R2 の指摘)。
 *    - 要約ができたときの要約の表示も、同じ理由で新しいセッションの作成のあとに出す (同じ型の不具合)。
 *    - aiSkipped が無い (要約するほどの会話が無かった) ときは、一文を出さない。
 * 2. メッセージを送って「同意が必要です」(403 AI_CONSENT_REQUIRED) で止められたとき
 *    - エラーの Alert は出さず、シートを閉じてから同意画面への案内を出し、入力を戻す。
 * 3. シートの上に開く「1日献立変更」(AIDayMenuModal) の作成が「同意が必要です」で止められたとき
 *    - 1日献立のモーダルだけでなく、シートも閉じてから案内を出す (シートが開いたままだと、案内から開いた同意画面が
 *      シートの下に隠れる。R4 の指摘)。「エラー」の Alert は出さない。
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
import { router } from 'expo-router';
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';
import { AI_CONSENT_SCREEN_PATH, resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_SUMMARY_CHECK_FAILED_NOTE,
  AI_CONSENT_SUMMARY_SKIPPED_NOTE,
} from '../../../../supabase/functions/_shared/ai-consent';

// 非同期の段数が多く、遅い環境で既定の 1 秒では足りないことがあるため、長めに待つ
const WAIT = { timeout: 5000 };

const OLD_SESSION = { id: 'session-old', title: 'AI相談', messageCount: 2, status: 'active' };
const NEW_SESSION_ID = 'session-new';
const OLD_MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];
const WELCOME_FRAGMENT = 'ほめゴハンのAIアドバイザーです';
const CONSENT_BODY = JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE });

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();

function closeResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsentPromptForTests();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [OLD_SESSION] };
    if (path === `/api/ai/consultation/sessions/${OLD_SESSION.id}/messages`) return { messages: OLD_MESSAGES };
    throw new Error(`unexpected GET ${path}`);
  });
  mockPost.mockImplementation(async (path: string) => {
    if (path === '/api/ai/consultation/sessions') return { success: true, session: { id: NEW_SESSION_ID } };
    throw new Error(`unexpected POST ${path}`);
  });
});

/** シートを開き、前の相談 (OLD_SESSION) が読み込まれるまで待つ */
async function openSheet(onClose: () => void = jest.fn()) {
  render(<AIAdvisorSheet visible onClose={onClose} />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy(), WAIT);
}

/** 相談を閉じる (アーカイブ) ボタンを押し、新しいセッションの作成が終わるまで待つ */
async function archive(body: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce(closeResponse(body));
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-archive-btn'));
  });
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/ai/consultation/sessions', { title: 'AI相談' }), WAIT);
  // 新しいセッションに移った (前の相談のメッセージは消えた)
  await waitFor(() => expect(screen.queryByText('野菜を足しましょう')).toBeNull(), WAIT);
  expect(fetchMock).toHaveBeenCalledWith(
    `http://localhost:3000/api/ai/consultation/sessions/${OLD_SESSION.id}/close`,
    expect.objectContaining({ method: 'POST' }),
  );
}

describe('AIAdvisorSheet — 相談を閉じたとき (要約・要約を省いた旨)', () => {
  it('同意が無くて要約を省いた (aiSkipped: AI_CONSENT_REQUIRED) ら、新しいセッションの作成のあとも一文が残る', async () => {
    await openSheet();
    await archive({ success: true, summary: null, aiSkipped: AI_CONSENT_REQUIRED_CODE });

    await waitFor(() => expect(screen.getByText(AI_CONSENT_SUMMARY_SKIPPED_NOTE)).toBeTruthy(), WAIT);
    expect(screen.queryByText(AI_CONSENT_SUMMARY_CHECK_FAILED_NOTE)).toBeNull();
    // 新しいセッションの最初のあいさつも出ている (置き換えのあとに足した)
    expect(screen.getByText(new RegExp(WELCOME_FRAGMENT))).toBeTruthy();
    // 要約を省いたことは失敗ではないので、エラーの Alert は出さない
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('同意の状況を読めなくて省いた (aiSkipped: AI_CONSENT_CHECK_FAILED) ら、「一時的に」の一文が残る', async () => {
    await openSheet();
    await archive({ success: true, summary: null, aiSkipped: AI_CONSENT_CHECK_FAILED_CODE });

    await waitFor(() => expect(screen.getByText(AI_CONSENT_SUMMARY_CHECK_FAILED_NOTE)).toBeTruthy(), WAIT);
    expect(screen.queryByText(AI_CONSENT_SUMMARY_SKIPPED_NOTE)).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('aiSkipped が無い (要約するほどの会話が無かった) ときは、一文を出さない', async () => {
    await openSheet();
    await archive({ success: true, summary: null });

    await waitFor(() => expect(screen.getByText(new RegExp(WELCOME_FRAGMENT))).toBeTruthy(), WAIT);
    expect(screen.queryByText(AI_CONSENT_SUMMARY_SKIPPED_NOTE)).toBeNull();
    expect(screen.queryByText(AI_CONSENT_SUMMARY_CHECK_FAILED_NOTE)).toBeNull();
  });

  it('要約ができたときも、新しいセッションの作成のあとに要約が残る (同じ型: 先に足すと置き換えで消える)', async () => {
    await openSheet();
    await archive({ success: true, summary: { summary: '野菜を増やす方針になりました' } });

    await waitFor(() => expect(screen.getByText(/野菜を増やす方針になりました/)).toBeTruthy(), WAIT);
    expect(screen.queryByText(AI_CONSENT_SUMMARY_SKIPPED_NOTE)).toBeNull();
  });
});

describe('AIAdvisorSheet — メッセージの送信が「同意が必要です」で止められたとき', () => {
  it('エラーの Alert を出さず、シートを閉じてから同意画面への案内を出し、入力を戻す', async () => {
    const onClose = jest.fn();
    await openSheet(onClose);
    fetchMock.mockResolvedValueOnce(new Response(CONSENT_BODY, { status: 403 }));

    fireEvent.changeText(screen.getByTestId('ai-input'), '今日の献立は?');
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array)), WAIT);
    expect(onClose).toHaveBeenCalledTimes(1);
    // シートを閉じたあとに案内を出す (先に出すと、案内から開いた同意画面がシートの下に隠れる)
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(alertSpy.mock.invocationCallOrder[0]);
    // 「エラー」「タイムアウト」の Alert は出さない
    expect(alertSpy.mock.calls.map((c) => c[0])).toEqual(['同意が必要です']);
    // 送らなかったメッセージは消え、入力が戻る
    expect(screen.getByTestId('ai-input').props.value).toBe('今日の献立は?');
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/ai/consultation/sessions/${OLD_SESSION.id}/messages?stream=true`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('AIAdvisorSheet — 1日献立の作成が「同意が必要です」で止められたとき', () => {
  const V4_GENERATE_PATH = '/api/ai/menu/v4/generate';
  const DAY_MENU_TITLE = '1日献立を作成';

  type AlertButton = { text?: string; onPress?: () => void };

  it('1日献立のモーダルとシートの両方を閉じてから案内を出し、「エラー」は出さない。「同意画面を開く」で同意画面へ移る', async () => {
    const onClose = jest.fn();
    await openSheet(onClose);
    mockPost.mockImplementation(async (path: string) => {
      if (path === V4_GENERATE_PATH) throw new Error(`HTTP 403 Forbidden: ${CONSENT_BODY}`);
      if (path === '/api/ai/consultation/sessions') return { success: true, session: { id: NEW_SESSION_ID } };
      throw new Error(`unexpected POST ${path}`);
    });

    // メッセージは何も送らずに「1日献立変更」を押す (未同意の利用者が 1 回の操作で着く経路)
    fireEvent.press(screen.getByTestId('ai-day-menu-btn'));
    expect(screen.getByText(DAY_MENU_TITLE)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('作成する'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array)), WAIT);
    expect(mockPost).toHaveBeenCalledWith(V4_GENERATE_PATH, expect.anything());
    // シートを閉じたあとに案内を出す (先に出すと、案内から開いた同意画面がシートの下に隠れる)
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(alertSpy.mock.invocationCallOrder[0]);
    // 1日献立のモーダルも閉じている
    await waitFor(() => expect(screen.queryByText(DAY_MENU_TITLE)).toBeNull(), WAIT);
    // 「エラー」の Alert は出さない
    expect(alertSpy.mock.calls.map((c) => c[0])).toEqual(['同意が必要です']);

    // 案内の「同意画面を開く」で同意画面へ移る
    const buttons = alertSpy.mock.calls[0][2] as AlertButton[];
    buttons.find((b) => b.text === '同意画面を開く')?.onPress?.();
    expect(router.push).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
  });
});
