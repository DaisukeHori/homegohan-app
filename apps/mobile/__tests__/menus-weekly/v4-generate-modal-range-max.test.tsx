/**
 * V4GenerateModal (モバイル) の「期間を指定」の上限のテスト (#1482)。
 *
 * Web の V4GenerateModal (#1463) と同じ上限を、モバイルの自由入力の欄にも付ける。以前は上限が無く、
 * 遠い未来の日付を打つと、端末の slot-builder が 1 日ずつ大量に回り (32 日以上は例外を投げて押しても何も起きない)、
 * API を直接呼べばサーバーの行事の検索が数千年分を回りえた。
 *   - 開始日: 今日 〜 今日 + 30 日 (「1日だけ」の欄の「今日から1ヶ月先まで」と同じ)
 *   - 終了日: 開始日 〜 開始日 + 30 日 (説明「最大31日」)
 * 上限の値は @homegohan/shared の menu-generation-range でサーバー・Web と共有する。
 */

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { addDaysToDate } from '@homegohan/shared';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// モーダルは期間の入力では API を呼ばない (送信は親の onGenerate)
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: jest.fn(), get: jest.fn() }),
}));

import { V4GenerateModal } from '../../src/components/menu/V4GenerateModal';

/** 開始日の上限 (今日から何日先まで)。手で書いた期待値 */
const EXPECTED_START_MAX_DAYS_AHEAD = 30;
/** 期間の長さの上限 (開始日を含む日数)。手で書いた期待値 */
const EXPECTED_RANGE_MAX_DAYS = 31;
/** 上限よりずっと先の日付 (今日からの日数) */
const FAR_FUTURE_DAYS = 3650;

const STORAGE_KEY_RANGE_DAYS = 'v4_range_days';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 端末の暦での今日 (モーダルと同じ求め方) */
function deviceToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function renderModal(weekEndDate?: string) {
  const today = deviceToday();
  const onGenerate = jest.fn().mockResolvedValue(undefined);
  const utils = render(
    <V4GenerateModal
      visible
      onClose={jest.fn()}
      onGenerate={onGenerate}
      mealPlanDays={[]}
      weekStartDate={today}
      weekEndDate={weekEndDate ?? addDaysToDate(today, 6)}
      isGenerating={false}
    />,
  );
  fireEvent.press(utils.getByTestId('v4-mode-range'));
  const start = () => utils.getByTestId('v4-range-start').props.value as string;
  const end = () => utils.getByTestId('v4-range-end').props.value as string;
  return { ...utils, onGenerate, start, end, today };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('V4GenerateModal (モバイル): 期間の上限 (#1482)', () => {
  it('開始日に上限より先の日付を打つと、今日 + 30 日に収める', async () => {
    const { getByTestId, start, today } = renderModal();
    await waitFor(() => expect(start()).toBe(today));

    fireEvent.changeText(getByTestId('v4-range-start'), addDaysToDate(today, FAR_FUTURE_DAYS));
    expect(start()).toBe(addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD));
  });

  it('終了日に上限より先の日付を打つと、開始日 + 30 日 (最大31日) に収める', async () => {
    const { getByTestId, start, end, today } = renderModal();
    await waitFor(() => expect(start()).toBe(today));

    fireEvent.changeText(getByTestId('v4-range-start'), addDaysToDate(today, 10));
    fireEvent.changeText(getByTestId('v4-range-end'), addDaysToDate(today, FAR_FUTURE_DAYS));
    expect(end()).toBe(addDaysToDate(today, 10 + EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('開始日を前に動かして期間が 31 日を超えると、終了日を縮める。開始日が終了日より後なら終了日を開始日に合わせる', async () => {
    const { getByTestId, start, end, today } = renderModal();
    await waitFor(() => expect(start()).toBe(today));

    fireEvent.changeText(getByTestId('v4-range-start'), addDaysToDate(today, 10));
    fireEvent.changeText(getByTestId('v4-range-end'), addDaysToDate(today, 40));
    expect(end()).toBe(addDaysToDate(today, 40));

    fireEvent.changeText(getByTestId('v4-range-start'), addDaysToDate(today, 5));
    expect(start()).toBe(addDaysToDate(today, 5));
    expect(end()).toBe(addDaysToDate(today, 5 + EXPECTED_RANGE_MAX_DAYS - 1));

    fireEvent.changeText(getByTestId('v4-range-end'), addDaysToDate(today, 12));
    fireEvent.changeText(getByTestId('v4-range-start'), addDaysToDate(today, 20));
    expect(start()).toBe(addDaysToDate(today, 20));
    expect(end()).toBe(addDaysToDate(today, 20));
  });

  it('過去の日付は、以前どおり今日に直す', async () => {
    const { getByTestId, start, end, today } = renderModal();
    await waitFor(() => expect(start()).toBe(today));

    fireEvent.changeText(getByTestId('v4-range-start'), addDaysToDate(today, -3));
    fireEvent.changeText(getByTestId('v4-range-end'), addDaysToDate(today, -3));
    expect(start()).toBe(today);
    expect(end()).toBe(today);
  });

  it('保存してあった期間 (今日からの日数) が上限より先でも、復元するときに上限に収める', async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY_RANGE_DAYS,
      JSON.stringify({ startDays: FAR_FUTURE_DAYS, endDays: FAR_FUTURE_DAYS * 2 }),
    );
    const { start, end, today } = renderModal();
    const expectedStart = addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD);
    await waitFor(() => expect(start()).toBe(expectedStart));
    expect(end()).toBe(addDaysToDate(expectedStart, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('保存が無く、表示中の週が先の週でも、既定の終了日を期間の上限に収める', async () => {
    const today = deviceToday();
    const { start, end } = renderModal(addDaysToDate(today, FAR_FUTURE_DAYS));
    await waitFor(() => expect(start()).toBe(today));
    expect(end()).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('上限まで広げた期間で生成すると、31 日分の slot を親に渡す', async () => {
    const { getByTestId, start, end, today, onGenerate } = renderModal();
    await waitFor(() => expect(start()).toBe(today));

    fireEvent.changeText(getByTestId('v4-range-end'), addDaysToDate(today, FAR_FUTURE_DAYS));
    expect(end()).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));

    fireEvent.press(getByTestId('v4-submit-btn'));
    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    const dates = new Set(onGenerate.mock.calls[0][0].targetSlots.map((slot: { date: string }) => slot.date));
    expect(dates.size).toBe(EXPECTED_RANGE_MAX_DAYS);
    expect([...dates].sort()[EXPECTED_RANGE_MAX_DAYS - 1]).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
  });
});
