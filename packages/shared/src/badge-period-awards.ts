/**
 * 比較ランキングのバッジを「どの期間に取ったか」を、獲得済みのバッジの一覧で見せるための決まり (#1528)
 *
 * 比較ランキングのバッジ (1 位・上位 n%・平均超え・改善) は、Edge Function calculate-segment-stats の確定の回
 * (期間が切り替わった直後の回) だけが付け、取った期間を表 user_badge_period_awards に 1 期間 1 行で残す
 * (migration 20261015120000_user_badge_period_awards.sql)。
 * GET /api/badges (src/app/api/badges/route.ts) が summarizeBadgePeriodAwards でバッジごとにまとめて返し、
 * Web (src/app/(main)/badges/page.tsx) とモバイル (apps/mobile/app/badges/index.tsx) の一覧が formatBadgePeriodAwards で文にする。
 *
 * 同じバッジを複数の期間で取ったときは、最新の期間を 1 つだけ出し、取った回数 (期間の数) を添える
 * (例:「2026年9月（通算 3 回）」)。一覧のカードは狭いので、全部の期間は並べない。
 * 「最新」は付けた時刻 (awarded_at) の新しい方。同じ時刻なら期間の開始日の新しい方。
 *
 * 期間の文は、日付で書く (「先週」「先月」のような今日から数えた言い方はしない)。一覧はいつ開くか分からず、
 * 「先週」は開いた日によって指す週が変わってしまうため。
 */

/** 確定の回がバッジを付ける期間の種類 (segment_stats_finalized_periods.period_type と同じ値) */
export const BADGE_AWARD_PERIOD_TYPES = ['daily', 'weekly', 'monthly'] as const;
export type BadgeAwardPeriodType = (typeof BADGE_AWARD_PERIOD_TYPES)[number];

export function isBadgeAwardPeriodType(value: unknown): value is BadgeAwardPeriodType {
  return typeof value === 'string' && (BADGE_AWARD_PERIOD_TYPES as readonly string[]).includes(value);
}

/** 週の期間の、開始日 (月曜日) から終了日 (日曜日) までの日数。月曜始まりの 7 日間 (calculateJstPeriod の weekly) */
const WEEK_LAST_DAY_OFFSET = 6;

/** user_badge_period_awards の 1 行のうち、まとめるのに使う列 */
export interface BadgePeriodAwardRow {
  badge_id: string;
  period_type: string;
  /** 期間の開始日 (YYYY-MM-DD。JST の暦日) */
  period_start: string;
  message: string | null;
  /** その期間のバッジを付けた時刻 (ISO 8601) */
  awarded_at: string;
}

/** 最新に取った期間 */
export interface BadgeLatestAwardPeriod {
  periodType: BadgeAwardPeriodType;
  /** 期間の開始日 (YYYY-MM-DD) */
  periodStart: string;
  /** 画面に出す期間の文 (例:「2026年9月」「2026年10月5日〜11日の週」「2026年10月14日」) */
  label: string;
  /** その期間の判定の文 (例:「🏆 全体の朝食率で1位！」)。無ければ null */
  message: string | null;
}

/** GET /api/badges が獲得済みのバッジに添える、期間の情報 */
export interface BadgePeriodAwards {
  /** 取った期間の数 (同じ期間は 1 回に数える) */
  count: number;
  latest: BadgeLatestAwardPeriod;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** YYYY-MM-DD を暦の年月日にする。形が違う・存在しない日付 (2月30日など) は null */
function parseCalendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** 暦の日付に days 日を足す (タイムゾーンに左右されないよう、暦の計算は UTC の関数で行う) */
function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/**
 * 期間の種類と開始日から、画面に出す期間の文を作る。分からない種類・日付なら null
 *   - daily  : 2026年10月14日
 *   - weekly : 2026年10月5日〜11日の週 (月をまたぐと 2026年9月28日〜10月4日の週、年をまたぐと 2026年12月28日〜2027年1月3日の週)
 *   - monthly: 2026年9月
 */
export function formatBadgeAwardPeriodLabel(periodType: string, periodStart: string): string | null {
  const start = parseCalendarDate(periodStart);
  if (!start) return null;
  switch (periodType) {
    case 'daily':
      return `${start.year}年${start.month}月${start.day}日`;
    case 'weekly': {
      const end = addCalendarDays(start, WEEK_LAST_DAY_OFFSET);
      const endText =
        end.year !== start.year
          ? `${end.year}年${end.month}月${end.day}日`
          : end.month !== start.month
            ? `${end.month}月${end.day}日`
            : `${end.day}日`;
      return `${start.year}年${start.month}月${start.day}日〜${endText}の週`;
    }
    case 'monthly':
      return `${start.year}年${start.month}月`;
    default:
      return null;
  }
}

/** 付けた時刻を比べられる数にする。読めない値は最も古い扱い */
function awardedAtMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** a の方が新しければ正、古ければ負 (付けた時刻 → 期間の開始日の順に比べる) */
function compareNewer(a: BadgePeriodAwardRow, b: BadgePeriodAwardRow): number {
  const byTime = awardedAtMs(a.awarded_at) - awardedAtMs(b.awarded_at);
  if (byTime !== 0) return byTime;
  return a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : 0;
}

/**
 * user_badge_period_awards の行を、バッジ (badge_id) ごとに「取った回数」と「最新の期間」にまとめる。
 * 期間の種類・開始日が読めない行は数えない (画面に出せない期間を回数にだけ足すと、文と数が合わなくなるため)。
 * 同じ (種類, 開始日) の行が重なっていても 1 回に数える (表の主キーで重ならないが、念のため)。
 */
export function summarizeBadgePeriodAwards(rows: readonly BadgePeriodAwardRow[]): Map<string, BadgePeriodAwards> {
  const byBadge = new Map<string, { periods: Set<string>; latestRow: BadgePeriodAwardRow; latest: BadgeLatestAwardPeriod }>();
  for (const row of rows) {
    const periodType = row.period_type;
    if (!isBadgeAwardPeriodType(periodType)) continue;
    const label = formatBadgeAwardPeriodLabel(periodType, row.period_start);
    if (label === null) continue;
    const latest: BadgeLatestAwardPeriod = { periodType, periodStart: row.period_start, label, message: row.message };
    const periodKey = `${periodType}:${row.period_start}`;
    const current = byBadge.get(row.badge_id);
    if (!current) {
      byBadge.set(row.badge_id, { periods: new Set([periodKey]), latestRow: row, latest });
      continue;
    }
    current.periods.add(periodKey);
    if (compareNewer(row, current.latestRow) > 0) {
      current.latestRow = row;
      current.latest = latest;
    }
  }

  const summaries = new Map<string, BadgePeriodAwards>();
  for (const [badgeId, { periods, latest }] of byBadge) {
    summaries.set(badgeId, { count: periods.size, latest });
  }
  return summaries;
}

/**
 * 一覧に出す期間の文。1 回だけなら期間だけ、2 回以上なら回数を添える。
 *   1 回: 2026年9月
 *   3 回: 2026年9月（通算 3 回）
 */
export function formatBadgePeriodAwards(awards: BadgePeriodAwards): string {
  return awards.count > 1 ? `${awards.latest.label}（通算 ${awards.count} 回）` : awards.latest.label;
}
