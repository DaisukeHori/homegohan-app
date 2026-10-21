/**
 * #1142: 究極モード (UltimateModeToggle / V4GenerateModal) を全員に開放した (いまは billing/03 §10.6 で、使えないプラン (無料プラン) には錠を出す。下の 5・6)
 *
 * 以前は Premium プラン向けとして、スイッチが常に OFF・操作不可で、
 * 押すと「究極モードは Premium プラン準備中です」のアラートが出るだけの飾りだった。
 * (プラン自体が未提供で、有効にする方法がコードのどこにも無かった。)
 *
 * ここでは次の点を固定する。
 *  1. スイッチに「Premium」「準備中」の表示が無く、押すと切り替え後の値が onValueChange に渡る (アラートは出ない)
 *  2. 操作できない状態 (disabled) のときは、押しても切り替わらない
 *  3. AI アシスタントのモーダルで ON にして生成すると、onGenerate の ultimateMode が true になる
 *  4. モーダルを開き直すと OFF に戻る (時間がかかるので、使うかどうかを毎回選ぶ)
 *
 * billing/03 §10.6 (有料プランの販売) で、究極モードを使えないプラン (無料プラン) には錠を出す:
 *  5. locked のトグルは押しても ON にならず、有料プランの案内 (Alert) を出す (テスト 57)
 *  6. モーダルは開くたびに契約の要約を読み、究極モードの 1 日の上限が 0 なら錠を渡す。読めなければ錠を出さない
 */

// ============================================================
// モック
// ============================================================

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// V4GenerateModal の import が連鎖して読み込む API クライアント。get はモーダルを開くたびの契約の要約の読み込み (billing/03 §10.6)。
// 既定は undefined を返す (要約の形が違う → 錠を出さない)
const mockApiGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockApiGet, post: jest.fn() }),
}));

// ============================================================
// imports
// ============================================================

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  ULTIMATE_MODE_LOCKED_ALERT_MESSAGE,
  ULTIMATE_MODE_LOCKED_ALERT_TITLE,
  UltimateModeToggle,
} from '../../src/components/menu/UltimateModeToggle';
import { V4GenerateModal } from '../../src/components/menu/V4GenerateModal';

beforeEach(() => {
  (Alert.alert as jest.Mock).mockClear();
  mockApiGet.mockReset();
  mockApiGet.mockResolvedValue(undefined);
});

/** GET /api/billing/subscription の応答 (究極モードの 1 日の上限だけを変える) */
function billingSummaryResponse(ultimateCap: number | null) {
  return {
    data: {
      plan_key: 'free',
      effective_plan_key: 'free',
      status: null,
      source: null,
      manage_in_store: null,
      billing_interval: null,
      current_period_end: null,
      trial_ends_at: null,
      cancel_at_period_end: false,
      cancel_at: null,
      has_customer: false,
      can_purchase: true,
      can_cancel: false,
      can_resume: false,
      features: { ai_daily_limit: 3, ai_feature_caps: { menu_generation_ultimate: ultimateCap } },
    },
  };
}

function isChecked(node: { props: { accessibilityState?: { checked?: boolean } } }): boolean | undefined {
  return node.props.accessibilityState?.checked;
}

// ============================================================
// UltimateModeToggle 単体
// ============================================================

describe('UltimateModeToggle (#1142)', () => {
  it('「Premium」「準備中」の表示が無い', () => {
    const { getByText, queryByText } = render(
      <UltimateModeToggle value={false} onValueChange={jest.fn()} />,
    );

    expect(getByText('究極モード')).toBeTruthy();
    expect(queryByText(/Premium/)).toBeNull();
    expect(queryByText(/準備中/)).toBeNull();
  });

  it('OFF のとき押すと onValueChange(true) が呼ばれる。アラートは出ない', () => {
    const onValueChange = jest.fn();
    const { getByTestId } = render(
      <UltimateModeToggle value={false} onValueChange={onValueChange} />,
    );

    fireEvent.press(getByTestId('ultimate-mode-toggle'));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(true);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('ON のとき押すと onValueChange(false) が呼ばれる', () => {
    const onValueChange = jest.fn();
    const { getByTestId } = render(
      <UltimateModeToggle value={true} onValueChange={onValueChange} />,
    );

    fireEvent.press(getByTestId('ultimate-mode-toggle'));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(false);
  });

  it('スイッチとして読み上げられ、ON / OFF の状態が伝わる', () => {
    const { getByTestId, rerender } = render(
      <UltimateModeToggle value={false} onValueChange={jest.fn()} />,
    );
    const toggle = getByTestId('ultimate-mode-toggle');
    expect(toggle.props.accessibilityRole).toBe('switch');
    expect(toggle.props.accessibilityLabel).toBe('究極モード');
    expect(isChecked(toggle)).toBe(false);

    rerender(<UltimateModeToggle value={true} onValueChange={jest.fn()} />);
    expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(true);
  });

  it('disabled のときは押しても onValueChange が呼ばれない', () => {
    const onValueChange = jest.fn();
    const { getByTestId } = render(
      <UltimateModeToggle value={false} onValueChange={onValueChange} disabled />,
    );

    fireEvent.press(getByTestId('ultimate-mode-toggle'));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('locked toggle does not switch on and announces the plan requirement', () => {
    const onValueChange = jest.fn();
    const { getByTestId, getByText } = render(
      <UltimateModeToggle value={false} onValueChange={onValueChange} locked />,
    );
    const toggle = getByTestId('ultimate-mode-toggle');

    fireEvent.press(toggle);

    expect(onValueChange).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(ULTIMATE_MODE_LOCKED_ALERT_TITLE, ULTIMATE_MODE_LOCKED_ALERT_MESSAGE);
    expect(ULTIMATE_MODE_LOCKED_ALERT_TITLE).toBe('プランとお支払い');
    expect(ULTIMATE_MODE_LOCKED_ALERT_MESSAGE).toBe(
      '究極モードは有料プランでお使いいただけます。設定の「プランとお支払い」からお申し込みいただけます。',
    );
    expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(false);
    expect(getByText('有料プランでお使いいただけます')).toBeTruthy();
    // value が true のまま渡されても、錠のあいだは ON に見せない
    const lockedOn = render(<UltimateModeToggle value onValueChange={onValueChange} locked />);
    expect(isChecked(lockedOn.getByTestId('ultimate-mode-toggle'))).toBe(false);
  });

  it('locked でなければ錠の注は出ない', () => {
    const { queryByTestId } = render(<UltimateModeToggle value={false} onValueChange={jest.fn()} />);
    expect(queryByTestId('ultimate-mode-locked-note')).toBeNull();
  });
});

// ============================================================
// V4GenerateModal (AI アシスタント) に組み込まれたスイッチ
// ============================================================

function renderModal(props: { visible?: boolean; onGenerate?: jest.Mock } = {}) {
  const onGenerate = props.onGenerate ?? jest.fn().mockResolvedValue(undefined);
  const element = (visible: boolean) => (
    <V4GenerateModal
      visible={visible}
      onClose={jest.fn()}
      onGenerate={onGenerate}
      mealPlanDays={[]}
      weekStartDate="2026-10-05"
      weekEndDate="2026-10-11"
      isGenerating={false}
    />
  );
  const utils = render(element(props.visible ?? true));
  return { ...utils, onGenerate, element };
}

describe('V4GenerateModal の究極モード (#1142)', () => {
  it('ON にして「献立を生成」すると、onGenerate に ultimateMode: true が渡る', async () => {
    const { getByTestId, onGenerate } = renderModal();

    fireEvent.press(getByTestId('v4-mode-single-day'));
    fireEvent.press(getByTestId('ultimate-mode-toggle'));
    expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(true);

    fireEvent.press(getByTestId('v4-submit-btn'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(onGenerate.mock.calls[0][0].ultimateMode).toBe(true);
  });

  it('触らずに生成すると、ultimateMode: false (既定は OFF)', async () => {
    const { getByTestId, onGenerate } = renderModal();

    fireEvent.press(getByTestId('v4-mode-single-day'));
    fireEvent.press(getByTestId('v4-submit-btn'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(onGenerate.mock.calls[0][0].ultimateMode).toBe(false);
  });

  it('モーダルを閉じて開き直すと OFF に戻る', async () => {
    const { getByTestId, queryByTestId, rerender, element } = renderModal();

    fireEvent.press(getByTestId('ultimate-mode-toggle'));
    expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(true);

    // 閉じる → 開き直す
    rerender(element(false));
    expect(queryByTestId('ultimate-mode-toggle')).toBeNull();
    await act(async () => {
      rerender(element(true));
    });

    expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(false);
  });
});

describe('V4GenerateModal の究極モードの錠 (billing/03 §10.6)', () => {
  it('開くと契約の要約を読み、究極モードの 1 日の上限が 0 なら錠を出し、押しても ON にならず、生成は ultimateMode: false', async () => {
    mockApiGet.mockResolvedValue(billingSummaryResponse(0));
    const { getByTestId, findByTestId, onGenerate } = renderModal();

    await findByTestId('ultimate-mode-locked-note');
    expect(mockApiGet).toHaveBeenCalledWith('/api/billing/subscription');

    fireEvent.press(getByTestId('ultimate-mode-toggle'));
    expect(Alert.alert).toHaveBeenCalledWith(ULTIMATE_MODE_LOCKED_ALERT_TITLE, ULTIMATE_MODE_LOCKED_ALERT_MESSAGE);
    expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(false);

    fireEvent.press(getByTestId('v4-mode-single-day'));
    fireEvent.press(getByTestId('v4-submit-btn'));
    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(onGenerate.mock.calls[0][0].ultimateMode).toBe(false);
  });

  it('読み込みの前に ON にしていても、錠が分かったら OFF に戻す', async () => {
    let resolveSummary: (value: unknown) => void = () => undefined;
    mockApiGet.mockReturnValue(new Promise((resolve) => { resolveSummary = resolve; }));
    const { getByTestId, findByTestId } = renderModal();

    fireEvent.press(getByTestId('ultimate-mode-toggle'));
    expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(true);

    await act(async () => {
      resolveSummary(billingSummaryResponse(0));
    });
    await findByTestId('ultimate-mode-locked-note');
    expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(false);
  });

  it('究極モードを使えるプラン (上限が 0 でない・無制限の null) と、要約を読めないときは錠を出さない', async () => {
    for (const response of [billingSummaryResponse(2), billingSummaryResponse(null), undefined]) {
      mockApiGet.mockReset();
      mockApiGet.mockResolvedValue(response);
      const { queryByTestId, getByTestId, unmount } = renderModal();
      await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1));
      await act(async () => {
        await Promise.resolve();
      });
      expect(queryByTestId('ultimate-mode-locked-note')).toBeNull();
      fireEvent.press(getByTestId('ultimate-mode-toggle'));
      expect(isChecked(getByTestId('ultimate-mode-toggle'))).toBe(true);
      unmount();
    }

    mockApiGet.mockReset();
    mockApiGet.mockRejectedValue(new Error('HTTP 500 Internal Server Error: {}'));
    const { queryByTestId, unmount } = renderModal();
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('ultimate-mode-locked-note')).toBeNull();
    unmount();
  });
});
