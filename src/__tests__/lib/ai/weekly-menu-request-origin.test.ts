/**
 * #1867 週の献立の生成 (POST /api/ai/menu/weekly/request) の行の印 (src/lib/ai/weekly-menu-request-origin.ts)
 *
 * 印は 3 か所で同じキーを使う (書く: 行を作るときの generated_data / 読む: 状態の確認の列の指定 / 絞る: バッジの一覧の絞り込み)。
 * 列の指定と絞り込みは型つきのクライアントが読めるよう文字列の直書きなので、キーが食い違うと、印のある行を読めず planner が付かない。
 */
import { describe, expect, it } from 'vitest';
import {
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_COLUMN,
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_VALUE,
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY,
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT,
  isWeeklyMenuRequestWeeklyOrigin,
  weeklyMenuRequestWeeklyOriginData,
} from '@/lib/ai/weekly-menu-request-origin';

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
});
