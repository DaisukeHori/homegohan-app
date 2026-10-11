/**
 * V4GenerateModal (モバイル) の「期間を指定」の上限のテスト (#1482)。
 *
 * Web の V4GenerateModal (#1463) と同じ上限を、モバイルの自由入力の欄にも付ける。以前は上限が無く、
 * 遠い未来の日付を打つと、端末の slot-builder が 1 日ずつ大量に回り (32 日以上は例外を投げて押しても何も起きない)、
 * API を直接呼べばサーバーの行事の検索が数千年分を回りえた。
 *   - 開始日: 今日 〜 今日 + 30 日 (「1日だけ」の欄の「今日から1ヶ月先まで」と同じ)
 *   - 終了日: 開始日 〜 開始日 + 30 日 (説明「最大31日」)
 * 上限の値は @homegohan/shared の menu-generation-range でサーバー・Web と共有する。
 *
 * #1498: 上限・下限は、打つたびではなく確定したとき (欄を離れたとき・キーボードの確定・生成を押したとき) にかける。
 *   以前は打つたびにかけていたので、途中の入力 (2026-10-1 など) が今日に戻され、手で打ちにくかった。
 *   日付になっていない値で確定したら、確定していた値に戻す。
 *   保存した期間の復元は非同期 (AsyncStorage)。復元が終わる前に欄を読むと、初期値 (表示中の週) を読んでしまう
 *   (負荷の高いときに 1 回赤になった。#1486 の実走) ので、復元が終わるのを待ってから読む (waitForRestore)。
 */

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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
/** 復元を遅らせるときの待ち (ミリ秒)。初期値を読んでしまう競合を、負荷が無くても毎回起こすための値 (長さに意味は無い) */
const SLOW_RESTORE_MS = 50;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 端末の暦での今日 (モーダルと同じ求め方) */
function deviceToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 保存した期間の復元 (モーダルを開いたときの AsyncStorage.getItem) が終わるまで待つ。
 * モーダルは getItem の結果を待ってから期間を入れるので、同じ Promise を待ち、そのあとの画面の更新を act で流しきる
 * (欄の値が初期値と同じかどうかで待つと、復元の前に抜けることがある)
 */
async function waitForRestore() {
  const getItem = AsyncStorage.getItem as jest.Mock;
  await waitFor(() => expect(getItem).toHaveBeenCalledWith(STORAGE_KEY_RANGE_DAYS));
  const index = getItem.mock.calls.map((call) => call[0]).lastIndexOf(STORAGE_KEY_RANGE_DAYS);
  await act(async () => {
    await getItem.mock.results[index].value;
  });
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
  /** 欄に打つ (確定はしない) */
  const type = (testID: string, value: string) => fireEvent.changeText(utils.getByTestId(testID), value);
  /** 欄に打って、欄を離れる (確定する) */
  const enter = (testID: string, value: string) => {
    type(testID, value);
    fireEvent(utils.getByTestId(testID), 'blur');
  };
  return { ...utils, onGenerate, start, end, today, type, enter };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  (AsyncStorage.getItem as jest.Mock).mockClear();
});

describe('V4GenerateModal (モバイル): 期間の上限 (#1482)', () => {
  it('開始日に上限より先の日付を打って確定すると、今日 + 30 日に収める', async () => {
    const { enter, start, today } = renderModal();
    await waitForRestore();
    expect(start()).toBe(today);

    enter('v4-range-start', addDaysToDate(today, FAR_FUTURE_DAYS));
    expect(start()).toBe(addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD));
  });

  it('終了日に上限より先の日付を打って確定すると、開始日 + 30 日 (最大31日) に収める', async () => {
    const { enter, end, today } = renderModal();
    await waitForRestore();

    enter('v4-range-start', addDaysToDate(today, 10));
    enter('v4-range-end', addDaysToDate(today, FAR_FUTURE_DAYS));
    expect(end()).toBe(addDaysToDate(today, 10 + EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('開始日を前に動かして期間が 31 日を超えると、終了日を縮める。開始日が終了日より後なら終了日を開始日に合わせる', async () => {
    const { enter, start, end, today } = renderModal();
    await waitForRestore();

    enter('v4-range-start', addDaysToDate(today, 10));
    enter('v4-range-end', addDaysToDate(today, 40));
    expect(end()).toBe(addDaysToDate(today, 40));

    enter('v4-range-start', addDaysToDate(today, 5));
    expect(start()).toBe(addDaysToDate(today, 5));
    expect(end()).toBe(addDaysToDate(today, 5 + EXPECTED_RANGE_MAX_DAYS - 1));

    enter('v4-range-end', addDaysToDate(today, 12));
    enter('v4-range-start', addDaysToDate(today, 20));
    expect(start()).toBe(addDaysToDate(today, 20));
    expect(end()).toBe(addDaysToDate(today, 20));
  });

  it('過去の日付は、確定したときに今日に直す (以前どおり)', async () => {
    const { enter, start, end, today } = renderModal();
    await waitForRestore();

    enter('v4-range-start', addDaysToDate(today, -3));
    enter('v4-range-end', addDaysToDate(today, -3));
    expect(start()).toBe(today);
    expect(end()).toBe(today);
  });

  it('保存してあった期間 (今日からの日数) が上限より先でも、復元するときに上限に収める', async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY_RANGE_DAYS,
      JSON.stringify({ startDays: FAR_FUTURE_DAYS, endDays: FAR_FUTURE_DAYS * 2 }),
    );
    const { start, end, today } = renderModal();
    await waitForRestore();

    const expectedStart = addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD);
    expect(start()).toBe(expectedStart);
    expect(end()).toBe(addDaysToDate(expectedStart, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('保存が無く、表示中の週が先の週でも、既定の終了日を期間の上限に収める', async () => {
    const today = deviceToday();
    // 負荷の高いときのように、復元 (AsyncStorage の読み取り) を遅らせても、復元が終わってから読む
    (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_RESTORE_MS));
      return null;
    });
    const { start, end } = renderModal(addDaysToDate(today, FAR_FUTURE_DAYS));
    // 初期値の開始日は今日 (weekStartDate) なので、開始日が今日になったことでは復元の終わりを判定できない (#1486 の実走で 1 回赤:
    // 期待 今日 + 30 日・実際 今日 + 3650 日 = 初期値の終了日)。復元が終わるのを待つ
    await waitForRestore();

    expect(start()).toBe(today);
    expect(end()).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('上限まで広げた期間で生成すると、31 日分の slot を親に渡す', async () => {
    const { enter, getByTestId, end, today, onGenerate } = renderModal();
    await waitForRestore();

    enter('v4-range-end', addDaysToDate(today, FAR_FUTURE_DAYS));
    expect(end()).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));

    fireEvent.press(getByTestId('v4-submit-btn'));
    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    const dates = new Set(onGenerate.mock.calls[0][0].targetSlots.map((slot: { date: string }) => slot.date));
    expect(dates.size).toBe(EXPECTED_RANGE_MAX_DAYS);
    expect([...dates].sort()[EXPECTED_RANGE_MAX_DAYS - 1]).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
  });
});

describe('V4GenerateModal (モバイル): 日付の欄は確定したときに直す (#1498)', () => {
  /**
   * 今日の日付を途中まで打った形 (YYYY-MM-D。日の 1 桁目まで。今日が 2026-10-12 なら 2026-10-1)。
   * 文字列として今日より前になるので、打つたびに直していたころは、ここで今日に戻されていた
   */
  function partialOfToday(today: string): string {
    return today.slice(0, -1);
  }

  it('打っている途中の値 (2026-10-1 など) は、そのまま欄に残す (今日に戻さない)', async () => {
    const { type, start, end, today } = renderModal();
    await waitForRestore();

    type('v4-range-start', partialOfToday(today));
    expect(start()).toBe(partialOfToday(today));
    type('v4-range-end', partialOfToday(today));
    expect(end()).toBe(partialOfToday(today));
  });

  it('最後まで打って確定すると、その日付になる', async () => {
    const { type, getByTestId, start, today } = renderModal();
    await waitForRestore();
    const target = addDaysToDate(today, 10);

    type('v4-range-start', partialOfToday(today));
    type('v4-range-start', target);
    fireEvent(getByTestId('v4-range-start'), 'blur');
    expect(start()).toBe(target);
    // キーボードの確定 (onSubmitEditing) でも確定する
    fireEvent(getByTestId('v4-range-start'), 'submitEditing');
    expect(start()).toBe(target);
  });

  it('日付になっていない値で確定すると、確定していた値に戻す', async () => {
    const { enter, start, end, today } = renderModal();
    await waitForRestore();
    enter('v4-range-start', addDaysToDate(today, 3));

    enter('v4-range-start', partialOfToday(today));
    expect(start()).toBe(addDaysToDate(today, 3));
    enter('v4-range-end', '2026-02-30');
    expect(end()).toBe(addDaysToDate(today, 6));
  });

  it('欄を離れずに生成を押しても、打った値を確定してから使う (上限・下限もかける)', async () => {
    const { type, getByTestId, start, end, today, onGenerate } = renderModal();
    await waitForRestore();

    type('v4-range-start', addDaysToDate(today, 2));
    type('v4-range-end', addDaysToDate(today, FAR_FUTURE_DAYS));
    fireEvent.press(getByTestId('v4-submit-btn'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    const dates = [...new Set(onGenerate.mock.calls[0][0].targetSlots.map((slot: { date: string }) => slot.date))].sort();
    expect(dates[0]).toBe(addDaysToDate(today, 2));
    expect(dates[dates.length - 1]).toBe(addDaysToDate(today, 2 + EXPECTED_RANGE_MAX_DAYS - 1));
    expect(start()).toBe(addDaysToDate(today, 2));
    expect(end()).toBe(addDaysToDate(today, 2 + EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('欄を離れずに押したとき、打った欄だけを確定する (終了日より後の開始日を打つと、終了日を開始日に合わせる。開始日を引き戻さない)', async () => {
    const { type, getByTestId, start, end, today, onGenerate } = renderModal();
    await waitForRestore();
    // 終了日は既定の今日 + 6 日のまま、開始日に今日 + 20 日を打って、欄を離れずに押す
    expect(end()).toBe(addDaysToDate(today, 6));
    type('v4-range-start', addDaysToDate(today, 20));
    fireEvent.press(getByTestId('v4-submit-btn'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    const dates = [...new Set(onGenerate.mock.calls[0][0].targetSlots.map((slot: { date: string }) => slot.date))];
    expect(dates).toEqual([addDaysToDate(today, 20)]);
    expect(start()).toBe(addDaysToDate(today, 20));
    expect(end()).toBe(addDaysToDate(today, 20));
  });

  it('打っている途中の値は保存しない (保存するのは確定した期間だけ)', async () => {
    const { type, enter, today } = renderModal();
    await waitForRestore();
    enter('v4-range-start', addDaysToDate(today, 4));

    type('v4-range-start', '2026-1');
    await waitFor(async () =>
      expect(JSON.parse((await AsyncStorage.getItem(STORAGE_KEY_RANGE_DAYS)) ?? 'null')).toMatchObject({ startDays: 4 }),
    );
  });

  it('「1日だけ」の欄も、打っている途中は残し、確定したときに過去を今日に直す。日付でなければ戻す', async () => {
    const { getByTestId, today } = renderModal();
    await waitForRestore();
    fireEvent.press(getByTestId('v4-mode-single-day'));
    const single = () => getByTestId('v4-date-picker-single').props.value as string;
    const target = addDaysToDate(today, 10);

    fireEvent.changeText(getByTestId('v4-date-picker-single'), partialOfToday(today));
    expect(single()).toBe(partialOfToday(today));
    fireEvent.changeText(getByTestId('v4-date-picker-single'), target);
    fireEvent(getByTestId('v4-date-picker-single'), 'blur');
    expect(single()).toBe(target);

    fireEvent.changeText(getByTestId('v4-date-picker-single'), addDaysToDate(today, -2));
    fireEvent(getByTestId('v4-date-picker-single'), 'blur');
    expect(single()).toBe(today);

    fireEvent.changeText(getByTestId('v4-date-picker-single'), 'abc');
    fireEvent(getByTestId('v4-date-picker-single'), 'blur');
    expect(single()).toBe(today);
  });
});
