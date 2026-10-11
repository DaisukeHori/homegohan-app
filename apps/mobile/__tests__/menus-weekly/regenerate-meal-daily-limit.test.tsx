/**
 * regenerate-meal-daily-limit.test.tsx
 * 1 食の作り直し (RegenerateMealModal) が、「今日の AI の利用回数の上限に達しました」(429 AI_DAILY_LIMIT。#1149 / T40)
 * で止められたとき
 *
 * 作り直しは getApi() を通らない生の fetch (POST /api/ai/menu/meal/regenerate)。以前は失敗をすべて catch で握りつぶし、
 * 上限に達しても押して何も起きなかった (R1 の指摘)。ここでは次を確かめる。
 *   - 429 AI_DAILY_LIMIT: Alert に固定の文を出す (生の文字列は出さない)。モーダルは閉じず、生成中の印も保存しない
 *   - 503 MAINTENANCE_MODE (メンテナンス中。#1457。ミドルウェアがこの API も止める): 同じく固定の文の Alert
 *     (見出しは「ご利用いただけません」)。以前は何も出さなかった
 *   - ほかの失敗 (500): これまでどおり何も出さず、モーダルも閉じない (上限の対応で、ほかの失敗の扱いを変えていない)
 *   - 同意が必要 (403 AI_CONSENT_REQUIRED): これまでどおりモーダルを閉じて同意の案内を出す (上限の判定より先に見分ける)
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('../../src/lib/api', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }) } },
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useNavigation: () => ({ goBack: jest.fn(), canGoBack: () => false }),
}));

jest.mock('lucide-react-native', () => ({ Sparkles: () => null, X: () => null }));

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RegenerateMealModal } from '../../src/components/menu/RegenerateMealModal';
import { aiDailyLimitMessage } from '../../src/lib/ai-daily-limit';
import { MAINTENANCE_API_CODE, MAINTENANCE_MESSAGE } from '@homegohan/shared';
import { resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';

const WAIT = { timeout: 5000 };
const LIMIT = 10;
const LIMIT_BODY = JSON.stringify({
  error: aiDailyLimitMessage(LIMIT),
  code: 'AI_DAILY_LIMIT',
  limit: LIMIT,
  retryAfter: 43210,
});
const MEAL = { id: 'meal-1', dish_name: 'カレー', meal_type: 'dinner' };
const REGENERATE_URL = 'http://localhost:3000/api/ai/menu/meal/regenerate';

const alertSpy = Alert.alert as jest.Mock;
const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsentPromptForTests();
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function pressSubmit(response: Response, onClose: jest.Mock) {
  fetchMock.mockResolvedValueOnce(response);
  render(<RegenerateMealModal visible meal={MEAL} onClose={onClose} />);
  await act(async () => {
    fireEvent.press(screen.getByTestId('regenerate-meal-submit'));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(REGENERATE_URL, expect.objectContaining({ method: 'POST' })), WAIT);
  // 送信中の表示が戻る (ボタンの文が戻る) まで待つ
  await waitFor(() => expect(screen.getByText('AIで別の献立に変更')).toBeTruthy(), WAIT);
}

describe('RegenerateMealModal — 作り直しが止められたとき', () => {
  it('429 AI_DAILY_LIMIT: Alert に固定の文を出す。生の文字列は出さず、モーダルを閉じず、生成中の印も保存しない', async () => {
    const onClose = jest.fn();
    await pressSubmit(new Response(LIMIT_BODY, { status: 429 }), onClose);

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1), WAIT);
    expect(alertSpy).toHaveBeenCalledWith('エラー', aiDailyLimitMessage(LIMIT));
    expect(alertSpy.mock.calls[0][1]).not.toContain('HTTP 429');
    expect(onClose).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith('singleMealGenerating', expect.anything());
  });

  it('503 MAINTENANCE_MODE: Alert に固定の文を出す。生の文字列は出さず、モーダルを閉じず、生成中の印も保存しない', async () => {
    const onClose = jest.fn();
    const body = JSON.stringify({ error: { code: MAINTENANCE_API_CODE, message: 'サーバーが返した別の文' } });
    await pressSubmit(new Response(body, { status: 503 }), onClose);

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1), WAIT);
    expect(alertSpy).toHaveBeenCalledWith('ご利用いただけません', MAINTENANCE_MESSAGE);
    expect(alertSpy.mock.calls[0][1]).not.toContain('HTTP 503');
    expect(onClose).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith('singleMealGenerating', expect.anything());
  });

  it('ほかの失敗 (500): これまでどおり何も出さず、モーダルを閉じない', async () => {
    const onClose = jest.fn();
    await pressSubmit(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }), onClose);

    expect(alertSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('同意が必要 (403): これまでどおりモーダルを閉じて同意の案内を出す (「エラー」は出さない)', async () => {
    const onClose = jest.fn();
    await pressSubmit(
      new Response(JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE }), { status: 403 }),
      onClose,
    );

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array)), WAIT);
    expect(alertSpy.mock.calls.map((c) => c[0])).toEqual(['同意が必要です']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
