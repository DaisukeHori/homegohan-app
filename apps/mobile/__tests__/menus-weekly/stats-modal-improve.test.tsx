/**
 * StatsModal (栄養分析) → 献立を改善 の引き渡しテスト (#1138)
 *
 * 「献立を改善」を押すと、いま画面に表示している AI栄養士の提案 (改善アドバイス) を onOpenImprove に渡す。
 * 親 (weekly 画面) はそれを改善モーダルへ渡し、生成の要望 (LLM に送る note) として使う。
 * 提案がまだ無いとき・分析の失敗 / タイムアウトのメッセージが出ているときは、提案ではないので渡さない (null)。
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

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

// react-native-svg を使うチャートや、API を呼ぶキーピッカーは関係ないので差し替える
jest.mock('../../src/components/menu/RadarChart', () => ({ RadarChart: () => null }));
jest.mock('../../src/components/menu/RadarKeyPicker', () => ({ RadarKeyPicker: () => null }));
jest.mock('../../src/components/menu/DriBar', () => ({ DriBar: () => null }));
jest.mock('../../src/components/menu/BarChart', () => ({ BarChart: () => null }));

import { StatsModal, type StatsModalProps } from '../../src/components/menu/StatsModal';
import { FEEDBACK_ERROR_MESSAGE } from '../../src/lib/nutrition-feedback-watch';

// 最初の描画は読み込むモジュールが多く、キャッシュの無い CI や負荷の高い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

const ADVICE = 'たんぱく質を増やしましょう';
const PRAISE = '野菜をよく食べています';

function renderStats(props: Partial<StatsModalProps> = {}) {
  const onOpenImprove = jest.fn();
  const utils = render(
    <StatsModal
      visible
      onClose={jest.fn()}
      onOpenImprove={onOpenImprove}
      selectedDate="2026-10-08"
      weekRange={{ start: '2026-10-05', end: '2026-10-11' }}
      todayNutrients={{ caloriesKcal: 1800, proteinG: 70, fatG: 55, carbsG: 250, fiberG: 18 }}
      weekNutrients={{
        avgCalories: 1800,
        dailyKcal: [1800, 1900, 1700, 0, 0, 0, 0],
        avgProtein: 70,
        avgFat: 55,
        avgCarbs: 250,
        avgFiber: 18,
      }}
      todayMeals={[
        { dish_name: '鮭の塩焼き定食', calories_kcal: 650 },
        { dish_name: 'カレーライス', calories_kcal: 800 },
      ]}
      {...props}
    />,
  );
  return { ...utils, onOpenImprove };
}

beforeEach(() => {
  mockPost.mockReset();
  mockGet.mockReset();
});

describe('StatsModal: 献立を改善への引き渡し', () => {
  it('提案が表示されているとき、その提案を onOpenImprove に渡す', async () => {
    mockPost.mockResolvedValue({ cached: true, praiseComment: PRAISE, advice: ADVICE });
    const { getByTestId, getByText, onOpenImprove } = renderStats();
    await waitFor(() => expect(getByText(ADVICE)).toBeTruthy());

    fireEvent.press(getByTestId('stats-improve-btn'));

    // 押下イベントなどではなく、表示中の提案の文字列だけが渡る
    expect(onOpenImprove).toHaveBeenCalledTimes(1);
    expect(onOpenImprove).toHaveBeenCalledWith(ADVICE);
  });

  it('生成を待った末に届いた提案は、そのまま渡す (失敗ではない)', async () => {
    mockPost.mockResolvedValue({ status: 'generating', cacheId: 'cache-1' });
    mockGet.mockResolvedValue({
      status: 'completed',
      praiseComment: PRAISE,
      advice: ADVICE,
      feedback: ADVICE,
    });
    const { getByTestId, getByText, onOpenImprove } = renderStats();
    await waitFor(() => expect(getByText(ADVICE)).toBeTruthy());

    fireEvent.press(getByTestId('stats-improve-btn'));

    expect(onOpenImprove).toHaveBeenCalledWith(ADVICE);
  });

  it('提案がまだ無い (分析中) ときは null を渡す', () => {
    mockPost.mockReturnValue(new Promise(() => {})); // 応答が返ってこない
    const { getByTestId, onOpenImprove } = renderStats();

    fireEvent.press(getByTestId('stats-improve-btn'));

    expect(onOpenImprove).toHaveBeenCalledTimes(1);
    expect(onOpenImprove).toHaveBeenCalledWith(null);
  });

  // 失敗 / タイムアウトのメッセージは「改善アドバイス」の欄に表示される。
  // それは AI栄養士の提案ではないので、改善の要望 (LLM に送られる note) には渡さない。
  it('分析の失敗メッセージが出ているときは、それを提案として渡さない (null)', async () => {
    mockPost.mockResolvedValue({ status: 'generating', cacheId: 'cache-1' });
    mockGet.mockResolvedValue({ status: 'error' });
    const { getByTestId, getByText, onOpenImprove } = renderStats();
    await waitFor(() => expect(getByText(FEEDBACK_ERROR_MESSAGE)).toBeTruthy());

    fireEvent.press(getByTestId('stats-improve-btn'));

    expect(onOpenImprove).toHaveBeenCalledTimes(1);
    expect(onOpenImprove).toHaveBeenCalledWith(null);
  });
});
