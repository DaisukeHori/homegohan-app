/**
 * 日付セレクタの色ロジックテスト
 *
 * index.tsx の accentColor ロジックを再現して検証する:
 *   - 祝日・日曜日 → colors.danger
 *   - 土曜日       → colors.blue
 *   - 平日          → null (colors.text / colors.textMuted が使われる)
 */

import { colors } from '../../src/theme';

/**
 * index.tsx (L1412) の accentColor 計算を再現するヘルパー
 */
function calcAccentColor(
  dayDateStr: string,
  holidays: Record<string, string>
): string | null {
  const dayOfWeek = new Date(dayDateStr + 'T00:00:00').getDay(); // 0=日,6=土
  const isHolidayDay = !!holidays[dayDateStr];
  const isSunday   = dayOfWeek === 0;
  const isSaturday = dayOfWeek === 6;
  return (isHolidayDay || isSunday) ? colors.danger : isSaturday ? colors.blue : null;
}

describe('日付セレクタ: accentColor ロジック', () => {
  // 2026-05-04 = 月曜(祝日・みどりの日)
  const HOLIDAY_MON   = '2026-05-04';
  // 2026-05-03 = 日曜
  const SUNDAY        = '2026-05-03';
  // 2026-05-02 = 土曜
  const SATURDAY      = '2026-05-02';
  // 2026-04-30 = 木曜
  const WEEKDAY_THU   = '2026-04-30';
  // 2026-05-01 = 金曜
  const WEEKDAY_FRI   = '2026-05-01';

  const holidays: Record<string, string> = {
    [HOLIDAY_MON]: 'みどりの日',
  };

  describe('土曜日', () => {
    it(`${SATURDAY} は colors.blue を返す`, () => {
      const result = calcAccentColor(SATURDAY, {});
      expect(result).toBe(colors.blue);
      expect(colors.blue).toBe('#2196F3');
    });
  });

  describe('日曜日', () => {
    it(`${SUNDAY} は colors.danger を返す`, () => {
      const result = calcAccentColor(SUNDAY, {});
      expect(result).toBe(colors.danger);
      expect(colors.danger).toBe('#D64545');
    });
  });

  describe('祝日（平日）', () => {
    it(`${HOLIDAY_MON} (祝日) は colors.danger を返す`, () => {
      const result = calcAccentColor(HOLIDAY_MON, holidays);
      expect(result).toBe(colors.danger);
    });
  });

  describe('平日', () => {
    it(`${WEEKDAY_THU} (木) は null を返す`, () => {
      const result = calcAccentColor(WEEKDAY_THU, {});
      expect(result).toBeNull();
    });

    it(`${WEEKDAY_FRI} (金) は null を返す`, () => {
      const result = calcAccentColor(WEEKDAY_FRI, {});
      expect(result).toBeNull();
    });
  });

  describe('null の場合は colors.text / colors.textMuted が fallback', () => {
    it('colors.text が定義されている', () => {
      expect(colors.text).toBe('#1A1A1A');
    });

    it('colors.textMuted が定義されている', () => {
      expect(colors.textMuted).toBe('#666666');
    });

    it('平日の accentColor ?? colors.text は colors.text', () => {
      const accent = calcAccentColor(WEEKDAY_THU, {});
      expect(accent ?? colors.text).toBe(colors.text);
    });
  });
});
