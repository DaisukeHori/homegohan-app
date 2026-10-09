/**
 * #1142: 究極モード (UltimateModeToggle / V4GenerateModal) は全員に開放されている
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
 */

// ============================================================
// モック
// ============================================================

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// V4GenerateModal の import が連鎖して読み込む API クライアント (このテストでは呼ばない)
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: jest.fn(), post: jest.fn() }),
}));

// ============================================================
// imports
// ============================================================

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { UltimateModeToggle } from '../../src/components/menu/UltimateModeToggle';
import { V4GenerateModal } from '../../src/components/menu/V4GenerateModal';

// V4GenerateModal の最初の描画は読み込むモジュールが多く、キャッシュの無い CI や負荷の高い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

beforeEach(() => {
  (Alert.alert as jest.Mock).mockClear();
});

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
