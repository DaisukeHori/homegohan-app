/**
 * insights-consent.test.tsx
 * 健康のインサイトの生成が「同意が必要です」(403 AI_CONSENT_REQUIRED。T15 / #1154) で止められたとき
 *
 * 生成を待つ間に、利用者はインサイトの詳細 (モーダル) を開けるので、案内が出た時点で詳細が開いていることがある。
 * 開いたままだと、案内の「同意画面を開く」で移った同意画面が、詳細のモーダルの下に隠れる (R4 の指摘と同じ型)。
 *   - 「生成失敗」は出さず、「同意が必要です」の案内を 1 回だけ出す
 *   - 「閉じる」を選んだら、詳細は開いたまま (同意画面へは移らない)
 *   - 「同意画面を開く」を押したら、詳細を閉じてから同意画面へ移る
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost, del: jest.fn(), patch: jest.fn() }),
}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import React from 'react';
import { router } from 'expo-router';
import HealthInsightsPage from '../../app/health/insights';
import { AI_CONSENT_SCREEN_PATH, resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';

// 最初の描画は読み込むモジュールが多く、キャッシュの無い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

// 非同期の段数が多く、遅い環境で既定の 1 秒では足りないことがあるため、長めに待つ
const WAIT = { timeout: 5000 };

const INSIGHTS_PATH = '/api/health/insights';
const INSIGHT = {
  id: 'insight-1',
  title: '睡眠が短めです',
  // 本文の列は summary (health_insights に content 列は無い。#1432)
  summary: 'この 1 週間は平均の睡眠が短めです。',
  is_read: true,
  is_alert: false,
  created_at: '2026-10-08T00:00:00.000Z',
};
const CONSENT_ERROR = () =>
  new Error(`HTTP 403 Forbidden: ${JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE })}`);

type AlertButton = { text?: string; style?: string; onPress?: () => void };

const alertMock = Alert.alert as jest.Mock;

function alertTitles(): string[] {
  return alertMock.mock.calls.map((call) => call[0] as string);
}

/** インサイトの詳細 (モーダル) が開いているか。本文は一覧のカードにも出るので、モーダルが開くと 2 つになる */
function detailOpen(): boolean {
  return screen.getAllByText(INSIGHT.summary).length === 2;
}

function consentButton(text: string): AlertButton | undefined {
  const call = alertMock.mock.calls.find((c) => c[0] === '同意が必要です');
  expect(call).toBeDefined();
  return (call![2] as AlertButton[]).find((b) => b.text === text);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAiConsentPromptForTests();
  mockGet.mockResolvedValue({ insights: [INSIGHT], unreadCount: 0, alertCount: 0 });
});

/** 生成を押し、その応答を待つ間にインサイトの詳細を開いてから、生成を「同意が必要です」で止める */
async function openDetailWhileGeneratingThenStop() {
  let rejectGenerate: (e: Error) => void = () => {};
  mockPost.mockImplementation(
    (path: string) =>
      new Promise((_, reject) => {
        if (path !== INSIGHTS_PATH) throw new Error(`unexpected POST ${path}`);
        rejectGenerate = reject;
      }),
  );
  render(<HealthInsightsPage />);
  await waitFor(() => expect(screen.getByTestId(`health-insights-item-${INSIGHT.id}`)).toBeTruthy(), WAIT);

  await act(async () => {
    fireEvent.press(screen.getByText('AIインサイトを生成'));
  });
  expect(mockPost).toHaveBeenCalledWith(INSIGHTS_PATH, {});
  expect(detailOpen()).toBe(false);
  fireEvent.press(screen.getByTestId(`health-insights-item-${INSIGHT.id}`));
  expect(detailOpen()).toBe(true);

  await act(async () => {
    rejectGenerate(CONSENT_ERROR());
  });
  await waitFor(() => expect(alertTitles()).toEqual(['同意が必要です']), WAIT);
}

describe('インサイトの生成が「同意が必要です」で止められたとき', () => {
  it('「生成失敗」は出さず案内を 1 回だけ出す。「閉じる」なら詳細は開いたまま', async () => {
    await openDetailWhileGeneratingThenStop();
    expect(alertMock).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array));

    const close = consentButton('閉じる');
    expect(close?.style).toBe('cancel');
    await act(async () => {
      close?.onPress?.();
    });
    expect(detailOpen()).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('「同意画面を開く」を押したら、詳細のモーダルを閉じてから同意画面へ移る', async () => {
    await openDetailWhileGeneratingThenStop();

    await act(async () => {
      consentButton('同意画面を開く')?.onPress?.();
    });

    expect(router.push).toHaveBeenCalledWith(AI_CONSENT_SCREEN_PATH);
    // 詳細のモーダルは閉じている (同意画面がその下に隠れない)
    expect(detailOpen()).toBe(false);
  });
});
