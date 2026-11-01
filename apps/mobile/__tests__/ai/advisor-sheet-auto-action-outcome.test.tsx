/**
 * #2189 W2: AI 相談シート (AIAdvisorSheet) が、サーバーの自動実行の結果を出す
 *
 * サーバーはモバイルの会話でも、AI の提案を自動で実行する (messages route の SSE の経路の executeAndFinalizeAction)。
 * 以前のシートは finalData の aiMessage から id・content・createdAt だけを取り出し、actionResult を読まなかったので、
 * 献立の作成などが成功しても失敗しても無言だった (Web は #2183 Z1 のあと失敗の文を出す)。ここでは次を確かめる。
 *   1. 成功 (actionResult.success === true) なら、AI の返答のすぐ後に『✅ {種類の名前}を実行しました！』を AI 側のメッセージで出し、
 *      データを出すタブに読み込み直しを知らせる (notifyAiConsultationDataChanged)
 *   2. 失敗なら、成功の一文を出さず、result.error の文 (無ければ固定の文) を出す。読み込み直しは知らせない
 *   3. actionResult が無い (提案が無い) ときは何も足さない
 *   4. 本文を流し読みできない (res.body が無い) 環境でも、受け取った本文から同じく結果を出す
 *      (以前はメッセージ一覧を取り直すだけで結果を捨てていた)。本文から何も読めなければ、以前どおり一覧を取り直す
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
import { AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE } from '@homegohan/shared';
import { AIAdvisorSheet } from '../../src/components/ai/AIAdvisorSheet';
import {
  resetAiConsultationDataChangedListenersForTests,
  subscribeAiConsultationDataChanged,
} from '../../src/lib/ai-consultation-data-changed';

const SESSION = { id: 'session-1', title: 'AI相談', messageCount: 2, status: 'active' };
const MESSAGES_PATH = `/api/ai/consultation/sessions/${SESSION.id}/messages`;
const MESSAGES = [
  { id: 'm1', role: 'user', content: '夕飯の相談です', createdAt: '2026-10-08T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-10-08T00:00:01.000Z' },
];
const SENT_TEXT = '今夜の夕食を1食作って';
const AI_REPLY = '鶏むね肉の照り焼きで1食作りますね';

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();
const dataChanged = jest.fn();

/** サーバーの SSE の本文 (本文の断片 → 最後の finalData) */
function sseBody(finalData: Record<string, unknown>): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: AI_REPLY } }] })}`,
    '',
    `data: ${JSON.stringify(finalData)}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function finalDataWith(actionResult: unknown, proposedActions: unknown = { type: 'generate_single_meal', params: {} }) {
  return {
    userMessage: { id: 'u-3', content: SENT_TEXT, createdAt: '2026-11-01T00:00:00.000Z' },
    aiMessage: { id: 'a-4', content: AI_REPLY, proposedActions, createdAt: '2026-11-01T00:00:01.000Z' },
    actionExecuted: false,
    actionResult,
  };
}

/** 本文を流し読みできる応答 (body.getReader)。本文を 2 つに割って届け、行の途中で切れても読めることも見る */
function streamingResponse(body: string) {
  const bytes = new TextEncoder().encode(body);
  const half = Math.floor(bytes.length / 2);
  const chunks = [bytes.slice(0, half), bytes.slice(half)];
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          const value = chunks.shift();
          return value ? { done: false, value } : { done: true, value: undefined };
        },
      }),
    },
    text: async () => body,
  };
}

/** 本文を流し読みできない応答 (body が無く、最後まで受け取った本文を text() で読む) */
function bufferedResponse(body: string) {
  return { ok: true, status: 200, body: null, text: async () => body };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsultationDataChangedListenersForTests();
  subscribeAiConsultationDataChanged(dataChanged);
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  mockGet.mockImplementation(async (requestPath: string) => {
    if (requestPath.startsWith('/api/ai/consultation/sessions?status=all')) return { sessions: [SESSION] };
    if (requestPath === MESSAGES_PATH) return { messages: MESSAGES };
    throw new Error(`unexpected GET ${requestPath}`);
  });
});

afterEach(() => {
  resetAiConsultationDataChangedListenersForTests();
});

async function openAndSend(response: unknown) {
  render(<AIAdvisorSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
  // 開いたときの読み込みの呼び出しを数えないよう、送る前に消す
  mockGet.mockClear();
  fetchMock.mockResolvedValueOnce(response);
  fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
  await act(async () => {
    fireEvent.press(screen.getByTestId('ai-send-btn'));
  });
  await waitFor(() => expect(screen.getByText(AI_REPLY)).toBeTruthy());
}

/** 画面に出ている文を上から順に (ネイティブの Text の部品 (host) で、子が文字列のものだけ) */
function renderedTexts(): string[] {
  return screen.UNSAFE_root
    .findAll((node) => node.type === 'Text' && typeof node.props.children === 'string')
    .map((node) => String(node.props.children));
}

describe('AIAdvisorSheet — 自動実行の結果 (#2189 W2)', () => {
  it.each([
    ['流し読みできる応答', streamingResponse],
    ['流し読みできない応答 (res.body が無い)', bufferedResponse],
  ])('%s: 成功なら AI の返答のすぐ後に『✅ …を実行しました！』を出し、読み込み直しを 1 回知らせる', async (_label, respond) => {
    await openAndSend(respond(sseBody(finalDataWith({ success: true, result: { mealId: 'meal-1' } }))));

    const executed = '✅ 1食を作成を実行しました！';
    await waitFor(() => expect(screen.getByText(executed)).toBeTruthy());
    const texts = renderedTexts();
    expect(texts.indexOf(executed)).toBe(texts.indexOf(AI_REPLY) + 1);
    expect(texts.indexOf(SENT_TEXT)).toBeLessThan(texts.indexOf(AI_REPLY));
    expect(dataChanged).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
    // 取り直しはしない (finalData で会話を確定させた)
    expect(mockGet).not.toHaveBeenCalledWith(MESSAGES_PATH);
  });

  it.each([
    ['流し読みできる応答', streamingResponse],
    ['流し読みできない応答 (res.body が無い)', bufferedResponse],
  ])('%s: 失敗なら result.error の文を出し、成功の一文も読み込み直しも出さない', async (_label, respond) => {
    const failure = '献立を保存できませんでした';
    await openAndSend(respond(sseBody(finalDataWith({ success: false, result: { error: failure } }))));

    await waitFor(() => expect(screen.getByText(failure)).toBeTruthy());
    const texts = renderedTexts();
    expect(texts.indexOf(failure)).toBe(texts.indexOf(AI_REPLY) + 1);
    expect(texts.some((text) => text.startsWith('✅'))).toBe(false);
    expect(dataChanged).not.toHaveBeenCalled();
  });

  it('失敗で result.error が無い (自動実行の例外で result が null) なら固定の文', async () => {
    await openAndSend(streamingResponse(sseBody(finalDataWith({ success: false, result: null }))));

    await waitFor(() => expect(screen.getByText(AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE)).toBeTruthy());
    expect(dataChanged).not.toHaveBeenCalled();
  });

  it('actionResult が無い (提案が無く実行していない) ときは、AI の返答だけで何も足さない', async () => {
    await openAndSend(streamingResponse(sseBody(finalDataWith(null, null))));

    const texts = renderedTexts();
    expect(texts).toContain(AI_REPLY);
    expect(texts.some((text) => text.startsWith('✅'))).toBe(false);
    expect(texts).not.toContain(AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE);
    expect(dataChanged).not.toHaveBeenCalled();
  });

  it('流し読みできない応答で本文から何も読めなければ、以前どおりメッセージ一覧を取り直す', async () => {
    render(<AIAdvisorSheet visible onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('野菜を足しましょう')).toBeTruthy());
    const saved = [
      ...MESSAGES,
      { id: 'u-3', role: 'user', content: SENT_TEXT, createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'a-4', role: 'assistant', content: AI_REPLY, createdAt: '2026-11-01T00:00:01.000Z' },
    ];
    mockGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === MESSAGES_PATH) return { messages: saved };
      throw new Error(`unexpected GET ${requestPath}`);
    });
    fetchMock.mockResolvedValueOnce(bufferedResponse(''));
    fireEvent.changeText(screen.getByTestId('ai-input'), SENT_TEXT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-send-btn'));
    });

    await waitFor(() => expect(screen.getByText(AI_REPLY)).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith(MESSAGES_PATH);
    expect(dataChanged).not.toHaveBeenCalled();
  });
});
