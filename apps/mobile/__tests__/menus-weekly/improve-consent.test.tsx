/**
 * 「献立を改善」が「同意が必要です」(403 AI_CONSENT_REQUIRED。T15 / #1154) で止められたとき — 挙動テスト
 *
 * 以前は、生成のフック (useV4MenuGeneration) が案内を出したあとに例外を投げ直し、改善モーダルの catch が
 * 「エラー: 改善に失敗しました。もう一度お試しください。」を案内に重ねて出していた。
 * ここでは、改善モーダル (ImproveMealModal)・改善の確定処理 (submitImprove)・生成のフックを本物のままつなぎ
 * (週の画面 app/menus/weekly/index.tsx の handleImprove / onAiConsentRequired と同じ配線)、API だけを 403 にして、
 *   - 「同意が必要です」の案内が 1 回だけ出る
 *   - 「エラー」の Alert は出ない・画面全体の失敗の表示 (onError) も出ない
 *   - 改善モーダル (と栄養分析の詳細) は閉じる (閉じないと、案内から開いた同意画面がモーダルの下に隠れる)
 * を、改善モーダルの 2 つの置き場 (週の画面・栄養分析の詳細) の両方で確かめる。
 * あわせて、改善モーダルに渡した onSubmit が同意の例外で reject した場合も、失敗を出さずに閉じて案内することを確かめる。
 * (週の画面の配線そのもの = handleImprove と onAiConsentRequired のつながりは improve-wiring.test.ts がソースで固定する)
 */

import React, { useState } from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: mockPost, get: mockGet }),
}));

jest.mock('../../src/lib/supabase', () => {
  const channel: Record<string, jest.Mock> = {};
  channel.on = jest.fn(() => channel);
  channel.subscribe = jest.fn(() => channel);
  channel.unsubscribe = jest.fn();
  return { supabase: { channel: jest.fn(() => channel), from: jest.fn(), removeChannel: jest.fn() } };
});

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

// react-native-svg を使うレーダーチャートと、API を呼ぶキーピッカーは関係ないので差し替える
jest.mock('../../src/components/menu/RadarChart', () => ({ RadarChart: () => null }));
jest.mock('../../src/components/menu/RadarKeyPicker', () => ({ RadarKeyPicker: () => null }));

import { ImproveMealModal } from '../../src/components/menu/ImproveMealModal';
import { NutritionDetailModal } from '../../src/components/menu/NutritionDetailModal';
import { useV4MenuGeneration } from '../../src/hooks/useV4MenuGeneration';
import { promptAiConsentRequired, resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { submitImprove, type ImproveMealRequest } from '../../src/lib/improve-meal';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';

// 最初の描画 (RN の Modal の初回描画) は読み込むモジュールが多く、キャッシュの無い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

const alertMock = Alert.alert as jest.Mock;
const TODAY = '2026-10-08';
const V4_GENERATE_PATH = '/api/ai/menu/v4/generate';
/** getApi() が「同意が必要です」で投げるエラー */
const CONSENT_ERROR = () =>
  new Error(`HTTP 403 Forbidden: ${JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE })}`);

const mockOnError = jest.fn();

/**
 * 週の画面と同じ配線: onAiConsentRequired はモーダルを閉じてから案内を出し、handleImprove は submitImprove に v4 生成を渡す。
 * where = 'weekly' は週の画面に置いた改善モーダル、'detail' は栄養分析の詳細の中の改善モーダル
 */
function WeeklyLikeScreen({ where }: { where: 'weekly' | 'detail' }) {
  const [showImprove, setShowImprove] = useState(where === 'weekly');
  const [showDetail, setShowDetail] = useState(where === 'detail');
  const promptAiConsentAfterClosingModals = () => {
    setShowImprove(false);
    setShowDetail(false);
    promptAiConsentRequired();
  };
  const { generate } = useV4MenuGeneration({
    onAiConsentRequired: () => promptAiConsentAfterClosingModals(),
    onError: mockOnError,
  });
  const handleImprove = async (request: ImproveMealRequest) => {
    await submitImprove({ request, today: TODAY, isBusy: false, generate });
    setShowDetail(false);
  };
  return (
    <>
      <ImproveMealModal
        visible={showImprove}
        onClose={() => setShowImprove(false)}
        selectedDate={TODAY}
        onSubmit={handleImprove}
      />
      <NutritionDetailModal
        visible={showDetail}
        onClose={() => setShowDetail(false)}
        date={TODAY}
        dateLabel="10/8"
        totals={{}}
        mealCount={3}
        radarKeys={[]}
        onRadarKeysSaved={jest.fn()}
        onImprove={handleImprove}
      />
    </>
  );
}

beforeEach(() => {
  mockPost.mockReset();
  mockGet.mockReset();
  mockOnError.mockReset();
  alertMock.mockClear();
  resetAiConsentPromptForTests();
  // 栄養分析の詳細が開いたときに取りにいく AI 栄養士のコメントはまだ無い扱い。v4 生成は同意が必要で止められる
  mockPost.mockImplementation((path: string) => {
    if (path === V4_GENERATE_PATH) return Promise.reject(CONSENT_ERROR());
    return Promise.resolve({ status: 'idle' });
  });
});

function alertTitles(): string[] {
  return alertMock.mock.calls.map((call) => call[0] as string);
}

describe('献立を改善が「同意が必要です」で止められたとき', () => {
  it('週の画面の改善モーダル: 案内を 1 回だけ出し、「改善に失敗しました」も画面全体の失敗も出さず、モーダルを閉じる', async () => {
    const { getByTestId, queryByTestId } = render(<WeeklyLikeScreen where="weekly" />);

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(alertTitles()).toEqual(['同意が必要です']));
    expect(alertMock).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array));
    expect(mockPost).toHaveBeenCalledWith(V4_GENERATE_PATH, expect.anything());
    expect(mockOnError).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByTestId('improve-meal-modal')).toBeNull());
    expect(alertTitles()).not.toContain('エラー');
  });

  it('栄養分析の詳細の改善モーダル: 案内を 1 回だけ出し、「改善に失敗しました」を出さず、詳細ごと閉じる', async () => {
    const { getByTestId, queryByTestId } = render(<WeeklyLikeScreen where="detail" />);

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(alertTitles()).toEqual(['同意が必要です']));
    expect(mockOnError).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByTestId('nutrition-detail-improve-btn')).toBeNull());
    expect(queryByTestId('improve-meal-modal')).toBeNull();
    expect(alertTitles()).not.toContain('エラー');
  });

  it('同意以外の失敗は、これまでどおり改善モーダルが「改善に失敗しました」を出し、開いたままにする (上の検査の空振りでないことの確かめ)', async () => {
    mockPost.mockImplementation((path: string) =>
      path === V4_GENERATE_PATH ? Promise.reject(new Error('HTTP 500 Internal Server Error')) : Promise.resolve({ status: 'idle' }),
    );
    const { getByTestId } = render(<WeeklyLikeScreen where="weekly" />);

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(alertTitles()).toEqual(['エラー']));
    expect(alertMock).toHaveBeenCalledWith('エラー', '改善に失敗しました。もう一度お試しください。');
    expect(getByTestId('improve-meal-modal')).toBeTruthy();
  });
});

describe('ImproveMealModal: onSubmit が「同意が必要です」で reject したとき', () => {
  it('「改善に失敗しました」を出さず、モーダルを閉じてから案内を出す', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn().mockRejectedValue(CONSENT_ERROR());
    const { getByTestId } = render(
      <ImproveMealModal visible onClose={onClose} selectedDate={TODAY} onSubmit={onSubmit} />,
    );

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(alertTitles()).toEqual(['同意が必要です']));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alertTitles()).not.toContain('エラー');
  });
});
