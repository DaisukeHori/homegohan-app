// tests/health-trend-chart-a11y.test.ts
// #1119: 推移グラフ (/health/graphs) の <svg> を支援技術に伝えるための純関数のテスト。
// 画面に組み込まれた状態の検証は src/app/(main)/health/graphs/__tests__/page.a11y.test.ts で行う。

import { describe, it, expect } from 'vitest';
import {
  buildTrendChartA11y,
  estimateSvgTextWidth,
  formatTrendAxisDate,
  formatTrendDateJa,
  getTrendAxisIndexes,
  TREND_PERIOD_LABELS,
  type TrendChartA11yInput,
} from '../src/lib/health-trend-chart-a11y';

const baseInput: TrendChartA11yInput = {
  chartTitle: '体重の推移',
  periodLabel: '1ヶ月',
  unit: 'kg',
  isBloodPressure: false,
  latest: 64.2,
  latestDiastolic: null,
  min: 64.2,
  max: 66,
  change: -1.8,
  startDate: '2026-09-09',
  endDate: '2026-10-08',
  recordedDays: 3,
  checkupDays: 0,
};

describe('TREND_PERIOD_LABELS', () => {
  it('期間ボタンと同じ表示名を持つ', () => {
    expect(TREND_PERIOD_LABELS).toEqual({
      week: '1週間',
      month: '1ヶ月',
      '3months': '3ヶ月',
      year: '1年',
    });
  });
});

describe('getTrendAxisIndexes: X 軸ラベルを出す点', () => {
  it('先頭・中央・末尾の 3 点を返す', () => {
    expect(getTrendAxisIndexes(7)).toEqual([0, 3, 6]);
    expect(getTrendAxisIndexes(30)).toEqual([0, 14, 29]);
    expect(getTrendAxisIndexes(90)).toEqual([0, 44, 89]);
    expect(getTrendAxisIndexes(365)).toEqual([0, 182, 364]);
  });

  it('点が少ないときは重複を除く', () => {
    expect(getTrendAxisIndexes(2)).toEqual([0, 1]);
    expect(getTrendAxisIndexes(1)).toEqual([0]);
    expect(getTrendAxisIndexes(0)).toEqual([]);
  });
});

describe('formatTrendAxisDate: X 軸の日付表記', () => {
  it('1 週間・1 ヶ月・3 ヶ月は「月/日」(ゼロ埋めなし)', () => {
    expect(formatTrendAxisDate('2026-10-08', 'week')).toBe('10/8');
    expect(formatTrendAxisDate('2026-10-08', 'month')).toBe('10/8');
    expect(formatTrendAxisDate('2026-01-05', '3months')).toBe('1/5');
  });

  it('1 年は一年前と今日を区別できるよう年も付ける', () => {
    expect(formatTrendAxisDate('2025-10-09', 'year')).toBe('2025/10/9');
    expect(formatTrendAxisDate('2026-10-08', 'year')).toBe('2026/10/8');
  });
});

describe('formatTrendDateJa: 読み上げ用の日付', () => {
  it('YYYY-MM-DD を「年月日」にする (月日のゼロ埋めは外す。「ハイフン」と読まれない)', () => {
    expect(formatTrendDateJa('2026-10-08')).toBe('2026年10月8日');
    expect(formatTrendDateJa('2026-01-05')).toBe('2026年1月5日');
    expect(formatTrendDateJa('2025-12-31')).toBe('2025年12月31日');
  });
});

describe('estimateSvgTextWidth: Y 軸ラベルの左余白を決めるための概算幅', () => {
  it('全角は 1em、数字は全角より狭い', () => {
    expect(estimateSvgTextWidth('時間', 12)).toBe(24);
    expect(estimateSvgTextWidth('8.5', 12)).toBeLessThan(estimateSvgTextWidth('時間', 12));
  });

  it('単位が長い血圧 (mmHg) は体重 (kg) より広く見積もる', () => {
    expect(estimateSvgTextWidth('140.0mmHg', 12)).toBeGreaterThan(estimateSvgTextWidth('70.5kg', 12));
  });

  it('フォントサイズに比例する', () => {
    expect(estimateSvgTextWidth('70.5kg', 24)).toBeCloseTo(estimateSvgTextWidth('70.5kg', 12) * 2, 5);
  });

  it('空文字は 0', () => {
    expect(estimateSvgTextWidth('', 12)).toBe(0);
  });
});

describe('buildTrendChartA11y: 体重などの 1 系列', () => {
  const result = buildTrendChartA11y(baseInput);

  it('aria-label に 指標・期間・最新値・最小/最大・変化 が入る', () => {
    expect(result.ariaLabel).toContain('体重の推移グラフ');
    expect(result.ariaLabel).toContain('期間は1ヶ月');
    expect(result.ariaLabel).toContain('最新値は64.2kg');
    expect(result.ariaLabel).toContain('最小64.2kg、最大66.0kg');
    expect(result.ariaLabel).toContain('期間中の変化は1.8kg減少');
  });

  it('変化は「-1.8」のような符号ではなく増加/減少の語で表す (読み上げ対策)', () => {
    expect(result.ariaLabel).not.toMatch(/-\d/);
    const up = buildTrendChartA11y({ ...baseInput, change: 0.5, unit: '時間' });
    expect(up.ariaLabel).toContain('期間中の変化は0.5時間増加');
  });

  it('変化が 0 のとき / 算出できないときの文言', () => {
    expect(buildTrendChartA11y({ ...baseInput, change: 0 }).ariaLabel).toContain('期間中の変化はありません');
    expect(buildTrendChartA11y({ ...baseInput, change: null }).ariaLabel).toContain('記録が2件未満のため算出できません');
  });

  it('title は見出し+期間、desc は対象期間と値のある日数 (aria-label を繰り返さない)', () => {
    expect(result.title).toBe('体重の推移（1ヶ月）');
    expect(result.desc).toContain('2026年9月9日から2026年10月8日まで');
    expect(result.desc).not.toMatch(/\d{4}-\d{2}-\d{2}/); // 「2026-09-09」のままの日付を残さない
    expect(result.desc).toContain('値がある日は3日');
    expect(result.desc).not.toContain('最新値');
  });

  it('健診由来の日が無いときは、菱形の説明を desc に入れない', () => {
    expect(result.desc).not.toContain('健診');
    expect(result.desc).not.toContain('菱形');
  });

  it('健診由来の日があるときは、日数と丸/菱形の意味を desc に入れる', () => {
    const withCheckup = buildTrendChartA11y({ ...baseInput, checkupDays: 2 });
    expect(withCheckup.desc).toContain('うち健診の値は2日');
    expect(withCheckup.desc).toContain('丸は日々の記録、菱形は健診の値');
  });
});

describe('buildTrendChartA11y: 血圧 (収縮期と拡張期の 2 系列)', () => {
  const bp = buildTrendChartA11y({
    ...baseInput,
    chartTitle: '血圧(収縮期/拡張期)の推移',
    unit: 'mmHg',
    isBloodPressure: true,
    latest: 128,
    latestDiastolic: 82,
    min: 70,
    max: 140,
    change: 2,
  });

  it('最新値は収縮期と拡張期の両方、最小は拡張期・最大は収縮期と明示する', () => {
    expect(bp.ariaLabel).toContain('血圧(収縮期/拡張期)の推移グラフ');
    expect(bp.ariaLabel).toContain('最新値は収縮期128.0、拡張期82.0mmHg');
    expect(bp.ariaLabel).toContain('最小は拡張期の70.0mmHg、最大は収縮期の140.0mmHg');
  });

  it('変化は収縮期の変化であることを明示する', () => {
    expect(bp.ariaLabel).toContain('収縮期の期間中の変化は2mmHg増加');
  });

  it('拡張期の最新値が無いときは収縮期だけを読み上げる', () => {
    const onlySystolic = buildTrendChartA11y({
      ...baseInput,
      chartTitle: '血圧(収縮期/拡張期)の推移',
      unit: 'mmHg',
      isBloodPressure: true,
      latest: 128,
      latestDiastolic: null,
    });
    expect(onlySystolic.ariaLabel).toContain('最新値は収縮期128.0mmHg');
    expect(onlySystolic.ariaLabel).not.toContain('拡張期82');
  });
});
