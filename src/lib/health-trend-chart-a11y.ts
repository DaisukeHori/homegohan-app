// src/lib/health-trend-chart-a11y.ts
// 推移グラフ (/health/graphs) のアクセシビリティ用の純関数 (#1119)。
// page.tsx は Next.js の制約で default 以外を export できないため、ここに切り出して単体テストする。

export type TrendPeriod = 'week' | 'month' | '3months' | 'year';

/** 期間ボタンとグラフの読み上げで共通に使う表示名 */
export const TREND_PERIOD_LABELS: Record<TrendPeriod, string> = {
  week: '1週間',
  month: '1ヶ月',
  '3months': '3ヶ月',
  year: '1年',
};

/**
 * X 軸に日付ラベルを出す点の添字 (先頭・中央・末尾の 3 点)。
 * 点が 3 つ未満のときは重複を除いて返す。
 */
export function getTrendAxisIndexes(length: number): number[] {
  if (length <= 0) return [];
  const indexes = [0, Math.floor((length - 1) / 2), length - 1];
  return indexes.filter((value, i) => indexes.indexOf(value) === i);
}

/**
 * X 軸ラベルの日付表記 (YYYY-MM-DD → M/D)。
 * 1 年表示は「一年前」と「今日」が同じ M/D になり区別できないため年も付ける。
 */
export function formatTrendAxisDate(dateStr: string, period: TrendPeriod): string {
  const [year, month, day] = dateStr.split('-');
  const monthDay = `${Number(month)}/${Number(day)}`;
  return period === 'year' ? `${year}/${monthDay}` : monthDay;
}

/**
 * 読み上げ用の日付 (YYYY-MM-DD → 2026年10月8日)。
 * 「2026-10-08」のままだと、読み上げが「ハイフン」と読んだり数字を並べて読んだりすることがあるため。
 */
export function formatTrendDateJa(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${Number(year)}年${Number(month)}月${Number(day)}日`;
}

/**
 * SVG <text> の概算幅 (viewBox 単位)。Y 軸ラベルの左余白を決めるのに使う。
 * フォントによって幅が違うため、実測より少し大きめに見積もる
 * (全角は 1em、m / w は 0.9em、数字は 0.6em、小数点は 0.3em、その他の半角は 0.62em)。
 */
export function estimateSvgTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x7f) em += 1;
    else if (/[mwMW]/.test(ch)) em += 0.9;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else if (ch === '.') em += 0.3;
    else em += 0.62;
  }
  return em * fontSize;
}

export interface TrendChartA11yInput {
  /** グラフの見出し (例: 「体重の推移」「血圧(収縮期/拡張期)の推移」) */
  chartTitle: string;
  periodLabel: string;
  unit: string;
  isBloodPressure: boolean;
  /** 最新値 (血圧は収縮期) */
  latest: number | null;
  /** 最新の拡張期血圧 (血圧のみ) */
  latestDiastolic: number | null;
  /** 最小値 (血圧は拡張期側を含めた最小) */
  min: number | null;
  /** 最大値 (血圧は収縮期側を含めた最大) */
  max: number | null;
  /** 期間中の変化 (最初の値 → 最新値)。比較できないときは null */
  change: number | null;
  /** グラフの最初の日・最後の日 (YYYY-MM-DD) */
  startDate: string;
  endDate: string;
  /** 値のある日数 */
  recordedDays: number;
  /** そのうち健診 (health_checkups) 由来の日数 */
  checkupDays: number;
}

export interface TrendChartA11y {
  /** <svg aria-label>: 指標・期間・最新値・最小/最大・変化 */
  ariaLabel: string;
  /** <svg><title>: ホバー時のツールチップにもなる短い題名 */
  title: string;
  /** <svg><desc>: ariaLabel を繰り返さず、対象期間・データ数・マーカーの意味を補う */
  desc: string;
}

const fmt = (value: number): string => value.toFixed(1);

function describeChange(change: number | null, unit: string, subject: string): string {
  if (change === null) return `${subject}期間中の変化は、記録が2件未満のため算出できません。`;
  if (change === 0) return `${subject}期間中の変化はありません。`;
  return `${subject}期間中の変化は${Math.abs(change)}${unit}${change > 0 ? '増加' : '減少'}です。`;
}

/**
 * 推移グラフの <svg> に付ける読み上げ用テキストを組み立てる。
 * 数字は「-0.8」と書くと読み上げが「ハイフン0.8」になることがあるため、増加/減少の語で表す。
 */
export function buildTrendChartA11y(input: TrendChartA11yInput): TrendChartA11y {
  const {
    chartTitle, periodLabel, unit, isBloodPressure,
    latest, latestDiastolic, min, max, change,
    startDate, endDate, recordedDays, checkupDays,
  } = input;

  const sentences: string[] = [`${chartTitle}グラフ。期間は${periodLabel}。`];

  if (isBloodPressure) {
    if (latest !== null) {
      const diastolic = latestDiastolic !== null ? `、拡張期${fmt(latestDiastolic)}` : '';
      sentences.push(`最新値は収縮期${fmt(latest)}${diastolic}${unit}。`);
    }
    if (min !== null && max !== null) {
      sentences.push(`最小は拡張期の${fmt(min)}${unit}、最大は収縮期の${fmt(max)}${unit}。`);
    }
    sentences.push(describeChange(change, unit, '収縮期の'));
  } else {
    if (latest !== null) sentences.push(`最新値は${fmt(latest)}${unit}。`);
    if (min !== null && max !== null) {
      sentences.push(`最小${fmt(min)}${unit}、最大${fmt(max)}${unit}。`);
    }
    sentences.push(describeChange(change, unit, ''));
  }

  const checkupNote = checkupDays > 0 ? `（うち健診の値は${checkupDays}日）` : '';
  return {
    ariaLabel: sentences.join(''),
    title: `${chartTitle}（${periodLabel}）`,
    desc: `${formatTrendDateJa(startDate)}から${formatTrendDateJa(endDate)}までの日ごとの値です。値がある日は${recordedDays}日${checkupNote}。` +
      (checkupDays > 0 ? '丸は日々の記録、菱形は健診の値です。' : ''),
  };
}
