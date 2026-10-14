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
 *
 * #1524: 「1日だけ」の欄は、確定したときに下限 (今日) しか見ていなかった。Web の日付の欄の上限 (今日から 30 日先。
 *   説明「今日から1ヶ月先まで」) と同じ上限を、確定したときにかける (値は @homegohan/shared で Web と共有する)。
 *
 * #1564: テストの今日を、モーダルと同じ todayLocal (日本の暦日) で求める。以前は端末の暦で求めていたので、TZ=UTC で
 *   JST の 0:00〜8:59 に流すと期待値がモーダルより 1 日前になり、9 件が赤になった。時計 (Date) を JST の 0:30 と 9:30 に
 *   固定して (CLOCKS)、全件をどちらの時刻でも流す (固定しないと、その時間帯に流したときしか確かめられない)。
 */

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { addDaysToDate, formatLocalDate, todayLocal } from '@homegohan/shared';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// モーダルは期間の入力では API を呼ばない (送信は親の onGenerate)
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: jest.fn(), get: jest.fn() }),
}));

import { commitSingleDayInput, V4GenerateModal } from '../../src/components/menu/V4GenerateModal';

/** 開始日の上限 (今日から何日先まで)。手で書いた期待値 */
const EXPECTED_START_MAX_DAYS_AHEAD = 30;
/** 期間の長さの上限 (開始日を含む日数)。手で書いた期待値 */
const EXPECTED_RANGE_MAX_DAYS = 31;
/** 上限よりずっと先の日付 (今日からの日数) */
const FAR_FUTURE_DAYS = 3650;

const STORAGE_KEY_RANGE_DAYS = 'v4_range_days';
/** 復元を遅らせるときの待ち (ミリ秒)。初期値を読んでしまう競合を、負荷が無くても毎回起こすための値 (長さに意味は無い) */
const SLOW_RESTORE_MS = 50;

/**
 * 時計 (Date) を固定する時刻 (#1564)。テストは TZ=UTC (local-ci・CI の設定) で流れる。
 * 期待値の暦日は、実装とは別に JST の暦 (UTC + 9 時間) と UTC の暦を手で引いた固定値。
 *   - JST 0:30 : UTC では前日の 15:30。以前のテストの今日 (端末の暦 = TZ=UTC では UTC の暦日) がモーダルの今日 (JST) の
 *                前日になり、期待値が 1 日ずれて 9 件が赤になった時間帯
 *   - JST 9:30 : UTC でも同じ日の 0:30。以前のテストでもたまたま一致していた時間帯 (対照)
 */
const CLOCKS = [
  { label: 'JST 0:30 (UTC の前日の 15:30)', at: '2026-10-13T15:30:00.000Z', jstToday: '2026-10-14', utcDay: '2026-10-13' },
  { label: 'JST 9:30 (UTC の同じ日の 0:30)', at: '2026-10-14T00:30:00.000Z', jstToday: '2026-10-14', utcDay: '2026-10-14' },
] as const;

/** Date 以外の時計の API (setTimeout・Promise の後処理など)。復元の待ち (SLOW_RESTORE_MS) と waitFor は本物の時計で動かす */
const REAL_TIMER_APIS = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const;

/** Date だけを時刻 at に固定する (ほかの時計の API は本物のまま) */
function fixDateOnly(at: string): void {
  jest.useFakeTimers({ now: new Date(at), doNotFake: [...REAL_TIMER_APIS] });
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
  // テストの今日は、モーダルの今日 (getTodayStr = todayLocal。日本の暦日で、端末のタイムゾーンに左右されない) と同じ関数で求める (#1564。
  // 以前は端末の暦 (getFullYear / getMonth / getDate) で求めていたので、TZ=UTC の JST 0:00〜8:59 はモーダルの今日の前日になった)
  const today = todayLocal();
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

for (const clock of CLOCKS) {
  describe(`時計を ${clock.label} に固定`, () => {
    beforeEach(() => fixDateOnly(clock.at));
    afterEach(() => jest.useRealTimers());

    it('前提: テストの今日 (todayLocal) は、モーダルの今日 (開いた直後の開始日と「1日だけ」の日付) と同じ JST の暦日。この時刻の UTC の暦日 (TZ=UTC の端末の暦。以前のテストの今日) とは限らない', async () => {
      expect(todayLocal()).toBe(clock.jstToday);
      expect(formatLocalDate(new Date(), 'UTC')).toBe(clock.utcDay);
      const { start, getByTestId, today } = renderModal();
      await waitForRestore();
      expect(today).toBe(clock.jstToday);
      expect(start()).toBe(clock.jstToday);
      fireEvent.press(getByTestId('v4-mode-single-day'));
      expect(getByTestId('v4-date-picker-single').props.value).toBe(clock.jstToday);
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
        const today = todayLocal();
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

    describe('V4GenerateModal (モバイル): 「1日だけ」の上限 (#1524)', () => {
      /** 「1日だけ」の上限 (今日から何日先まで)。画面の説明「今日から1ヶ月先まで」の手で書いた期待値 */
      const EXPECTED_SINGLE_DAY_MAX_DAYS_AHEAD = 30;
      /** 端末の暦に左右されない固定の今日 (純粋な関数のテスト用) */
      const FIXED_TODAY = '2026-10-14';

      it('commitSingleDayInput: 上限より先は今日 + 30 日に収める。上限ちょうどは残す。下限 (過去は今日) と日付でないときは以前どおり', () => {
        const max = addDaysToDate(FIXED_TODAY, EXPECTED_SINGLE_DAY_MAX_DAYS_AHEAD);
        expect(max).toBe('2026-11-13');
        expect(commitSingleDayInput(addDaysToDate(FIXED_TODAY, FAR_FUTURE_DAYS), FIXED_TODAY, FIXED_TODAY)).toBe(max);
        expect(commitSingleDayInput(addDaysToDate(max, 1), FIXED_TODAY, FIXED_TODAY)).toBe(max);
        expect(commitSingleDayInput(max, FIXED_TODAY, FIXED_TODAY)).toBe(max);
        expect(commitSingleDayInput(` ${addDaysToDate(FIXED_TODAY, 5)} `, FIXED_TODAY, FIXED_TODAY)).toBe('2026-10-19');
        // 下限は今のまま (過去は今日に直す)
        expect(commitSingleDayInput('2026-10-13', FIXED_TODAY, FIXED_TODAY)).toBe(FIXED_TODAY);
        expect(commitSingleDayInput(FIXED_TODAY, '2026-10-20', FIXED_TODAY)).toBe(FIXED_TODAY);
        // 日付でなければ、確定していた日付のまま
        expect(commitSingleDayInput('2026-10-1', '2026-10-20', FIXED_TODAY)).toBe('2026-10-20');
        expect(commitSingleDayInput('2026-02-30', '2026-10-20', FIXED_TODAY)).toBe('2026-10-20');
      });

      it('欄に上限より先の日付を打って確定すると、今日 + 30 日に収める (上限ちょうどはそのまま)', async () => {
        const { getByTestId, today } = renderModal();
        await waitForRestore();
        fireEvent.press(getByTestId('v4-mode-single-day'));
        const single = () => getByTestId('v4-date-picker-single').props.value as string;
        const max = addDaysToDate(today, EXPECTED_SINGLE_DAY_MAX_DAYS_AHEAD);

        fireEvent.changeText(getByTestId('v4-date-picker-single'), addDaysToDate(today, FAR_FUTURE_DAYS));
        fireEvent(getByTestId('v4-date-picker-single'), 'blur');
        expect(single()).toBe(max);

        fireEvent.changeText(getByTestId('v4-date-picker-single'), addDaysToDate(max, 1));
        fireEvent(getByTestId('v4-date-picker-single'), 'submitEditing');
        expect(single()).toBe(max);

        fireEvent.changeText(getByTestId('v4-date-picker-single'), max);
        fireEvent(getByTestId('v4-date-picker-single'), 'blur');
        expect(single()).toBe(max);
      });

      it('欄を離れずに生成を押しても、上限をかけてから使う (上限の日の slot だけを親に渡す)', async () => {
        const { getByTestId, today, onGenerate } = renderModal();
        await waitForRestore();
        fireEvent.press(getByTestId('v4-mode-single-day'));
        const max = addDaysToDate(today, EXPECTED_SINGLE_DAY_MAX_DAYS_AHEAD);

        fireEvent.changeText(getByTestId('v4-date-picker-single'), addDaysToDate(today, FAR_FUTURE_DAYS));
        fireEvent.press(getByTestId('v4-submit-btn'));

        await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
        const dates = [...new Set(onGenerate.mock.calls[0][0].targetSlots.map((slot: { date: string }) => slot.date))];
        expect(dates).toEqual([max]);
        expect(getByTestId('v4-date-picker-single').props.value).toBe(max);
      });
    });
  });
}
