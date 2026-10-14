/**
 * chat-daily-limit.test.tsx
 * AI 相談のチャット画面 (app/ai/[sessionId].tsx) のメッセージ送信が、「今日の AI の利用回数の上限に達しました」
 * (429 AI_DAILY_LIMIT。#1149 / T40) で止められたとき
 *
 * 送信はストリーミングで受けるため getApi() を通らない生の fetch で、getApi() の置き換え (src/lib/api.ts の
 * withFriendlyErrors) が効かない。以前は `HTTP 429: {"error":...,"code":"AI_DAILY_LIMIT",...}` をそのまま画面に出していた
 * (R1 の指摘)。ここでは次を確かめる。
 *   - 画面には固定の文 (aiDailyLimitMessage(limit)) だけが出て、生の文字列 (HTTP 429・JSON) は出ない
 *   - 送らなかったメッセージは消え、入力 (と添付した画像) が戻る
 *   - Alert は出さない (この画面はエラーを画面の中の一行で出す)
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockGet = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: jest.fn(), del: jest.fn() }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'test-session-id' }),
  router: { back: jest.fn(), push: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import React from 'react';
import { Alert, Pressable } from 'react-native';
import AiSessionPage from '../../app/ai/[sessionId]';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../../src/lib/supabase';
import { aiDailyLimitMessage } from '../../src/lib/ai-daily-limit';

const LIMIT = 10;
const LIMIT_BODY = JSON.stringify({
  error: aiDailyLimitMessage(LIMIT),
  code: 'AI_DAILY_LIMIT',
  limit: LIMIT,
  retryAfter: 43210,
});
const INPUT_PLACEHOLDER = '相談内容を入力...';
const alertSpy = Alert.alert as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (supabase.auth.getSession as jest.Mock).mockResolvedValue({ data: { session: { access_token: 'test-token' } } });
  mockGet.mockResolvedValue({ messages: [] });
  global.fetch = jest.fn().mockResolvedValue(new Response(LIMIT_BODY, { status: 429 })) as unknown as typeof fetch;
});

describe('AiSessionPage — 送信が 429 AI_DAILY_LIMIT で止められたとき', () => {
  it('固定の文を出し、生の文字列は出さない。送らなかったメッセージを消して入力を戻す', async () => {
    render(<AiSessionPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(INPUT_PLACEHOLDER)).toBeTruthy());

    fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), '今日の献立は?');
    const pressables = screen.UNSAFE_getAllByType(Pressable);
    await act(async () => {
      fireEvent.press(pressables[pressables.length - 1]);
    });

    await waitFor(() => expect(screen.getByTestId('ai-chat-error-text')).toBeTruthy());
    const shown = screen.getByTestId('ai-chat-error-text').props.children;
    expect(shown).toBe(aiDailyLimitMessage(LIMIT));
    expect(shown).not.toContain('HTTP 429');
    expect(shown).not.toContain('AI_DAILY_LIMIT');
    // 送らなかったメッセージ (楽観的に足した吹き出し) は消え、入力が戻る
    expect(screen.queryByText('今日の献立は?')).toBeNull();
    expect(screen.getByPlaceholderText(INPUT_PLACEHOLDER).props.value).toBe('今日の献立は?');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/ai/consultation/sessions/test-session-id/messages?stream=true',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('画像を添付して送ったときも、添付した画像が戻る (選び直さずに済む)', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///photo.jpg', base64: 'aGVsbG8=' }],
    });
    render(<AiSessionPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(INPUT_PLACEHOLDER)).toBeTruthy());

    // 入力バーの最後から 2 番目の Pressable が画像の添付 (image-attach.test.tsx と同じ)
    const before = screen.UNSAFE_getAllByType(Pressable);
    await act(async () => {
      fireEvent.press(before[before.length - 2]);
    });
    await waitFor(() => expect(screen.getByTestId('ai-chat-image-preview')).toBeTruthy());

    fireEvent.changeText(screen.getByPlaceholderText(INPUT_PLACEHOLDER), 'この料理は?');
    const pressables = screen.UNSAFE_getAllByType(Pressable);
    await act(async () => {
      fireEvent.press(pressables[pressables.length - 1]);
    });

    await waitFor(() => expect(screen.getByTestId('ai-chat-error-text').props.children).toBe(aiDailyLimitMessage(LIMIT)));
    expect(screen.getByTestId('ai-chat-image-preview')).toBeTruthy();
    expect(screen.getByPlaceholderText(INPUT_PLACEHOLDER).props.value).toBe('この料理は?');
  });
});
