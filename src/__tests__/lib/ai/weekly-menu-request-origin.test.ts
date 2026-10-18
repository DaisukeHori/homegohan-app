/**
 * #1867 週の献立の生成 (1 週間分の生成: POST /api/ai/menu/weekly/request・v4/generate と v5/generate で対象が 1 週間を覆うとき・AI 相談の 1 週間分の生成) の行の印 (src/lib/ai/weekly-menu-request-origin.ts)
 *
 * 印を書くのは 1 週間分の生成だけ (枠を対象にする生成は、異なる日付が WEEKLY_MENU_GENERATION_MIN_DAYS 日以上のとき)。
 * 印は 4 か所で同じキーを使う (書く: 行を作るときの generated_data / 付ける: 完了で付ける DB のトリガー (付与の本体。突き合わせは
 * tests/planner-badge-weekly-menu-trigger-migration-contract.test.ts) / 読む: 状態の確認の列の指定 (保険) / 絞る: バッジの一覧の絞り込み (保険))。
 * 列の指定と絞り込みは型つきのクライアントが読めるよう文字列の直書きなので、キーが食い違うと、印のある行を読めず保険の経路で planner が付かない。
 */
import { describe, expect, it } from 'vitest';
import { addDaysToDate } from '@/lib/date-utils';
import {
  WEEKLY_MENU_GENERATION_MIN_DAYS,
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_COLUMN,
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_VALUE,
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY,
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT,
  coversWeekOfMenuGeneration,
  isWeeklyMenuRequestWeeklyOrigin,
  weeklyMenuRequestWeeklyOriginData,
  weeklyMenuRequestWeeklyOriginDataForDates,
} from '@/lib/ai/weekly-menu-request-origin';

const FIRST_DAY = '2026-10-19';
/** FIRST_DAY から days 日の日付を、1 日 perDay 回ずつ並べる (枠の日付の並び) */
function slotDates(days: number, perDay = 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) for (let j = 0; j < perDay; j++) out.push(addDaysToDate(FIRST_DAY, i));
  return out;
}

describe('週の献立の生成の行の印 (#1867)', () => {
  it('書く印は、キーに真偽値の true', () => {
    expect(weeklyMenuRequestWeeklyOriginData()).toEqual({ [WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY]: true });
  });

  it('状態の確認の列の指定は、同じキーを -> (JSON のまま) で weekly_request として読む', () => {
    expect(WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT).toBe(`weekly_request:generated_data->${WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY}`);
  });

  it('バッジの一覧の絞り込みは、同じキーを ->> (text) で取り出し、JSON の true の text 表現 "true" と比べる', () => {
    expect(WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_COLUMN).toBe(`generated_data->>${WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY}`);
    expect(WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_VALUE).toBe(JSON.stringify(weeklyMenuRequestWeeklyOriginData()[WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY]));
  });

  it.each([
    [true, true],
    [false, false],
    [null, false],
    [undefined, false],
    ['true', false],
    [1, false],
    [{}, false],
  ])('読んだ印 %j を週の献立の生成の行とみなすか: %s (真偽値の true のときだけ)', (value, expected) => {
    expect(isWeeklyMenuRequestWeeklyOrigin(value)).toBe(expected);
  });

  it('「1 週間」の下限は 7 日 (説明と吹き出しの「1 週間」)', () => {
    expect(WEEKLY_MENU_GENERATION_MIN_DAYS).toBe(7);
  });

  it.each([
    ['7 日 × 3 食', slotDates(7, 3), true],
    ['7 日 × 1 食', slotDates(7, 1), true],
    ['31 日 × 3 食 (期間の上限)', slotDates(31, 3), true],
    ['6 日 × 3 食 (18 枠でも 6 日)', slotDates(6, 3), false],
    ['1 日 × 7 枠 (枠は 7 つでも 1 日)', slotDates(1, 7), false],
    ['1 日 × 3 食', slotDates(1, 3), false],
    ['枠なし', [], false],
  ])('%s: 1 週間を覆うか = %s。覆うときだけ印を書く', (_label, dates, expected) => {
    expect(coversWeekOfMenuGeneration(dates)).toBe(expected);
    expect(weeklyMenuRequestWeeklyOriginDataForDates(dates)).toEqual(expected ? weeklyMenuRequestWeeklyOriginData() : {});
  });

  it('日付の並びが順不同・重複ありでも、異なる日付の数で決まる', () => {
    const dates = [...slotDates(7, 2)].reverse();
    expect(weeklyMenuRequestWeeklyOriginDataForDates(dates)).toEqual({ [WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY]: true });
    expect(weeklyMenuRequestWeeklyOriginDataForDates(dates.filter((d) => d !== FIRST_DAY))).toEqual({});
  });
});
