/**
 * 比較ランキングのバッジを「どの期間に取ったか」を、獲得済みのバッジの一覧で見せるための決まり (#1528)
 *
 * 比較ランキングのバッジ (1 位・上位 n%・平均超え・改善) は、Edge Function calculate-segment-stats の確定の回
 * (期間が切り替わった直後の回) だけが付け、取った期間を表 user_badge_period_awards に 1 期間 1 行で残す
 * (migration 20261015120000_user_badge_period_awards.sql)。
 * GET /api/badges (src/app/api/badges/route.ts) が、同じ migration の関数 get_my_badge_period_award_summaries で
 * DB の中でバッジごとにまとめた行 (取った期間の数と最新の期間の 1 行) を読み、toBadgePeriodAwardsByBadgeId で一覧に添える形にして返す。
 * (表の行のまま読むと、行が PostgREST の max_rows (既定 1,000) を超えたとき黙って打ち切られ、回数が小さく・最新が古く出るため、
 *  まとめは DB で行う)
 * Web (src/app/(main)/badges/page.tsx) とモバイル (apps/mobile/app/badges/index.tsx) の一覧が formatBadgePeriodAwards で文にする。
 *
 * 同じバッジを複数の期間で取ったときは、最新の期間を 1 つだけ出し、取った回数 (期間の数) を添える
 * (例:「2026年9月（通算 3 回）」)。一覧のカードは狭いので、全部の期間は並べない。
 * 「最新」は付けた時刻 (awarded_at) の新しい方。同じ時刻なら期間の開始日の新しい方、それも同じなら期間の種類の文字の順で後ろの方
 * (関数の ORDER BY が決める)。
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

/**
 * 関数 get_my_badge_period_award_summaries が返す 1 行 (バッジ 1 つぶん)。
 * 生成した型 (database.types.ts) は latest_message を string と書くが、表の message は NULL になりうるので null も受ける
 */
export interface BadgePeriodAwardSummaryRow {
  badge_id: string;
  /** 取った期間の数 (表の主キーで、同じ期間は 1 行) */
  award_count: number;
  /** 最新の期間の種類 */
  latest_period_type: string;
  /** 最新の期間の開始日 (YYYY-MM-DD。JST の暦日) */
  latest_period_start: string;
  /** 最新の期間の判定の文 */
  latest_message: string | null;
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

/**
 * 関数 get_my_badge_period_award_summaries の行を、badge_id ごとの「取った回数」と「最新の期間」にする。
 * 最新の期間の種類・開始日が読めない行、回数が 1 以上の整数でない行は出さない (画面に出せない期間・意味の無い回数を添えないため。
 * 表の CHECK 制約と DATE 型・主キーがあるので、ふつうは起きない)。
 */
export function toBadgePeriodAwardsByBadgeId(rows: readonly BadgePeriodAwardSummaryRow[]): Map<string, BadgePeriodAwards> {
  const summaries = new Map<string, BadgePeriodAwards>();
  for (const row of rows) {
    const periodType = row.latest_period_type;
    if (!isBadgeAwardPeriodType(periodType)) continue;
    const label = formatBadgeAwardPeriodLabel(periodType, row.latest_period_start);
    if (label === null) continue;
    if (!Number.isInteger(row.award_count) || row.award_count < 1) continue;
    summaries.set(row.badge_id, {
      count: row.award_count,
      latest: { periodType, periodStart: row.latest_period_start, label, message: row.latest_message },
    });
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
