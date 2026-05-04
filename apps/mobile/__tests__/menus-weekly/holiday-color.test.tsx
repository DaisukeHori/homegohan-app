/**
 * 祝日カラー表示テスト
 *
 * index.tsx のカレンダーグリッド (L1331-1344) では
 * isHoliday が true のとき colors.danger (#D64545) でテキスト色を設定する。
 * このロジックを独立した単体テストで検証する。
 */

import { colors } from '../../src/theme';

/**
 * index.tsx (L1331) の日付テキスト color 選択を再現するヘルパー
 * (isSelected = false の前提で holiday / weekend / today / normal を判定)
 */
function getCalendarDateTextColor(params: {
  isSelected: boolean;
  isHoliday: boolean;
  isToday: boolean;
  isWeekend: boolean;
}): string {
  const { isSelected, isHoliday, isToday, isWeekend } = params;
  if (isSelected) return '#fff';
  if (isHoliday)  return colors.danger;
  if (isToday)    return colors.accent;
  if (isWeekend)  return colors.accent;
  return colors.text;
}

describe('holiday-color: 祝日カレンダーセルの色', () => {
  it('祝日は colors.danger (#D64545) を返す', () => {
    const color = getCalendarDateTextColor({
      isSelected: false,
      isHoliday:  true,
      isToday:    false,
      isWeekend:  false,
    });
    expect(color).toBe(colors.danger);
    expect(colors.danger).toBe('#D64545');
  });

  it('祝日かつ土曜でも isHoliday が優先されて colors.danger', () => {
    const color = getCalendarDateTextColor({
      isSelected: false,
      isHoliday:  true,
      isToday:    false,
      isWeekend:  true,
    });
    expect(color).toBe(colors.danger);
  });

  it('選択中セルは isHoliday でも #fff を返す', () => {
    const color = getCalendarDateTextColor({
      isSelected: true,
      isHoliday:  true,
      isToday:    false,
      isWeekend:  false,
    });
    expect(color).toBe('#fff');
  });

  it('通常の平日は colors.text', () => {
    const color = getCalendarDateTextColor({
      isSelected: false,
      isHoliday:  false,
      isToday:    false,
      isWeekend:  false,
    });
    expect(color).toBe(colors.text);
  });

  it('土日は colors.accent', () => {
    const color = getCalendarDateTextColor({
      isSelected: false,
      isHoliday:  false,
      isToday:    false,
      isWeekend:  true,
    });
    expect(color).toBe(colors.accent);
  });

  it('今日は colors.accent', () => {
    const color = getCalendarDateTextColor({
      isSelected: false,
      isHoliday:  false,
      isToday:    true,
      isWeekend:  false,
    });
    expect(color).toBe(colors.accent);
  });
});
