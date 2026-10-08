/**
 * NutritionDetailModal → 献立を改善 の配線テスト (#1138)
 *
 * 栄養分析の詳細モーダルにある「献立を改善」ボタンは ImproveMealModal を開く。
 * 以前は ImproveMealModal が存在しない API を直接呼んでいたため、ここから押しても必ず失敗していた。
 * 今は親 (weekly 画面) から渡される onImprove に、分析した日・選んだ食事・
 * このモーダルで表示中の AI 栄養士の提案 (advice) を渡す。
 */

import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: mockPost, get: mockGet }),
}));

// AI 栄養フィードバックの待ち受け (useNutritionFeedbackWatch) が使う Realtime 購読 (channel().on().subscribe()) は何もしない。
// 結果はポーリング (getApi().get) で受け取る
jest.mock('../../src/lib/supabase', () => {
  const channel: any = {};
  channel.on = jest.fn(() => channel);
  channel.subscribe = jest.fn(() => channel);
  return { supabase: { channel: jest.fn(() => channel), removeChannel: jest.fn() } };
});

// react-native-svg を使うレーダーチャートと、API を呼ぶキーピッカーは関係ないので差し替える
jest.mock('../../src/components/menu/RadarChart', () => ({ RadarChart: () => null }));
jest.mock('../../src/components/menu/RadarKeyPicker', () => ({ RadarKeyPicker: () => null }));

import { NutritionDetailModal } from '../../src/components/menu/NutritionDetailModal';
import { FEEDBACK_ERROR_MESSAGE } from '../../src/lib/nutrition-feedback-watch';

// 最初の描画は読み込むモジュールが多く、キャッシュの無い CI や負荷の高い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

const ADVICE = 'たんぱく質を増やしましょう';

function renderDetail(props: Partial<React.ComponentProps<typeof NutritionDetailModal>> = {}) {
  const onClose = jest.fn();
  const onImprove = jest.fn().mockResolvedValue(undefined);
  const utils = render(
    <NutritionDetailModal
      visible
      onClose={onClose}
      date="2026-10-08"
      dateLabel="10/8"
      totals={{}}
      mealCount={3}
      radarKeys={[]}
      onRadarKeysSaved={jest.fn()}
      onImprove={onImprove}
      {...props}
    />,
  );
  return { ...utils, onClose, onImprove };
}

beforeEach(() => {
  mockPost.mockReset();
  mockGet.mockReset();
  mockPost.mockResolvedValue({
    cached: true,
    praiseComment: '野菜をよく食べています',
    advice: ADVICE,
    nutritionTip: null,
  });
});

describe('NutritionDetailModal: 献立を改善', () => {
  it('改善ボタンで改善モーダルが開き、送信すると分析日・選択内容・AI 栄養士の提案を onImprove に渡す', async () => {
    const { getByTestId, getByText, onImprove } = renderDetail();
    await waitFor(() => expect(getByText(ADVICE)).toBeTruthy());

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));
    expect(getByTestId('improve-meal-modal')).toBeTruthy();

    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onImprove).toHaveBeenCalledTimes(1));
    expect(onImprove).toHaveBeenCalledWith({
      date: '2026-10-08',
      mealTypes: ['breakfast', 'lunch', 'dinner'],
      nextDay: false,
      advice: ADVICE,
    });
  });

  it('昼・夕を外して翌日にした選択もそのまま渡す', async () => {
    const { getByTestId, getByText, onImprove } = renderDetail();
    await waitFor(() => expect(getByText(ADVICE)).toBeTruthy());

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));
    fireEvent.press(getByTestId('improve-meal-type-lunch'));
    fireEvent.press(getByTestId('improve-meal-type-dinner'));
    fireEvent.press(getByTestId('improve-meal-next-day-toggle'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onImprove).toHaveBeenCalledTimes(1));
    expect(onImprove).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-10-08', mealTypes: ['breakfast'], nextDay: true, advice: ADVICE }),
    );
  });

  it('AI 栄養士の提案がまだ無いときは advice なし (null) で渡す', async () => {
    mockPost.mockResolvedValue({ status: 'idle' });
    const { getByTestId, onImprove } = renderDetail();

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onImprove).toHaveBeenCalledTimes(1));
    expect(onImprove.mock.calls[0][0].advice).toBeNull();
  });

  it('改善の依頼に失敗したらエラーを表示して改善モーダルを開いたままにする (栄養分析も閉じない)', async () => {
    const { Alert } = require('react-native');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onImprove = jest.fn().mockRejectedValue(new Error('HTTP 500'));
    const { getByTestId, getByText, onClose } = renderDetail({ onImprove });
    await waitFor(() => expect(getByText(ADVICE)).toBeTruthy());

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('エラー', '改善に失敗しました。もう一度お試しください。'));
    expect(getByTestId('improve-meal-modal')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('献立が 0 件のときは改善ボタンを出さない', () => {
    const { queryByTestId } = renderDetail({ mealCount: 0 });
    expect(queryByTestId('nutrition-detail-improve-btn')).toBeNull();
  });

  it('改善モーダルは栄養分析モーダルの内側に置く (iOS は兄弟の Modal を重ねて表示できないため)', async () => {
    const { getByTestId, getByText } = renderDetail();
    await waitFor(() => expect(getByText(ADVICE)).toBeTruthy());

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));

    const detailModal = getByTestId('nutrition-detail-modal');
    expect(within(detailModal).getByTestId('improve-meal-modal')).toBeTruthy();
  });
});

describe('NutritionDetailModal: 分析が失敗したときの献立を改善', () => {
  // 失敗 / タイムアウトのメッセージは「改善アドバイス」の欄に表示される (再分析ボタンで再試行できる)。
  // それは AI 栄養士の提案ではないので、改善の要望 (LLM に送られる note) には渡さない。
  it('分析の失敗メッセージが出ているときは、それを提案として渡さない (advice: null)', async () => {
    mockPost.mockResolvedValue({ status: 'generating', cacheId: 'cache-1' });
    mockGet.mockResolvedValue({ status: 'error' });
    const { getByTestId, getByText, onImprove } = renderDetail();
    await waitFor(() => expect(getByText(FEEDBACK_ERROR_MESSAGE)).toBeTruthy());

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onImprove).toHaveBeenCalledTimes(1));
    expect(onImprove.mock.calls[0][0].advice).toBeNull();
  });

  it('失敗のあとに再分析で提案が取れたら、その提案を渡す', async () => {
    mockPost.mockResolvedValueOnce({ status: 'generating', cacheId: 'cache-1' });
    mockGet.mockResolvedValue({ status: 'error' });
    const { getByTestId, getByText, onImprove } = renderDetail();
    await waitFor(() => expect(getByText(FEEDBACK_ERROR_MESSAGE)).toBeTruthy());

    mockPost.mockResolvedValueOnce({
      cached: true,
      praiseComment: '野菜をよく食べています',
      advice: ADVICE,
      nutritionTip: null,
    });
    fireEvent.press(getByText('再分析'));
    await waitFor(() => expect(getByText(ADVICE)).toBeTruthy());

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onImprove).toHaveBeenCalledTimes(1));
    expect(onImprove.mock.calls[0][0].advice).toBe(ADVICE);
  });

  it('失敗のあとに再分析して、生成を待った末に提案が届いたら、その提案を渡す', async () => {
    mockPost.mockResolvedValueOnce({ status: 'generating', cacheId: 'cache-1' });
    mockGet.mockResolvedValue({ status: 'error' });
    const { getByTestId, getByText, onImprove } = renderDetail();
    await waitFor(() => expect(getByText(FEEDBACK_ERROR_MESSAGE)).toBeTruthy());

    // 再分析 → 今度は生成が完了する
    mockPost.mockResolvedValueOnce({ status: 'generating', cacheId: 'cache-2' });
    mockGet.mockResolvedValue({
      status: 'completed',
      praiseComment: '野菜をよく食べています',
      advice: ADVICE,
      feedback: ADVICE,
      nutritionTip: null,
    });
    fireEvent.press(getByText('再分析'));
    await waitFor(() => expect(getByText(ADVICE)).toBeTruthy());

    fireEvent.press(getByTestId('nutrition-detail-improve-btn'));
    fireEvent.press(getByTestId('improve-meal-submit'));

    await waitFor(() => expect(onImprove).toHaveBeenCalledTimes(1));
    expect(onImprove.mock.calls[0][0].advice).toBe(ADVICE);
  });
});
