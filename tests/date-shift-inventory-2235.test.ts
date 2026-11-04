// @vitest-environment node
/**
 * #2235 I3 端末の暦で日付を読み違える 3 つの形の棚卸しの表と、その見張り。
 *   1 つめ: 「端末のローカル時刻で日をずらす」形 (`x.setDate(x.getDate() ± n)`)。表は DATE_SHIFT_SITES (D-1〜D-3)
 *   2 つめ: 「YYYY-MM-DD の暦日を new Date() に渡す」形 (`new Date(dateStr)`)。表は DATE_PARSE_SITES (D-4〜D-6。下の説明)
 *   3 つめ: 「今の時刻 (引数なしの new Date()) を端末の暦 (getDay / getDate / getMonth / getFullYear) で読む」形。
 *           表は NOW_DEVICE_CALENDAR_SITES (D-7〜D-9。下の説明)
 *
 * 1 つめの形 (`x.setDate(x.getDate() ± n)`):
 *
 * この形は端末の暦で日をずらすので、ずらした Date を JST の暦日 (formatLocalDate (Asia/Tokyo)) にすると、ずらす元によって食い違う。
 *   - 元が今の時刻 (new Date()): 端末の夏時間の切り替えの日に 23 / 25 時間しか進まず、JST の日付が 1 日ずれうる。端末の暦 (getDate など) で
 *     日付にしていた画面は、端末のタイムゾーンが日本でないと今日そのものが JST とずれた。I3 で直した /health の週間カレンダー・
 *     /health/streaks の 7 日・ホームの useHomeData・買い物リストの範囲はこれ (今は todayLocal / addDaysToDate の暦の計算)
 *   - 元が端末の 0 時の Date (parseLocalDate・週の始まり): 端末が JST より東 (UTC+10 など) だと端末の 0 時が JST の前の日なので、
 *     いつも 1 日戻る (例: Australia/Sydney で JST の今日 2026-11-05 から「明日」を作ると 2026-11-05)。
 *     AI 相談の 1 日分の献立の明日と日付の欄の上限 (src/components/AIChatBubble.tsx) はこれで、I8 (#2243) が addDaysToDate の
 *     暦の計算に直した (表に行を置かないので、この形が戻ると D-1 で赤になる)
 * I3 の時点で製品コードに残る同じ形の箇所を、下の DATE_SHIFT_SITES に 1 ファイル 1 行で判定つきで載せる (表が正本)。
 *
 *   D-1 製品コードで、この形を書くファイルは、どれも DATE_SHIFT_SITES に行がある (新しく書いたら、行を足して判定を書く)
 *   D-2 各ファイルのこの形の数は、行に書いた数以下 (直して減るのは構わない。増えたら判定を書き直す)
 *   D-3 I3 で直したファイル (FIXED_IN_I3) には、この形が 1 つも無い (元の形に戻っていない)
 *
 * 限界 (見張りであって証明ではない): コメントを除いた本文を `setDate(<名前>.getDate() ± …)` の 1 つの形で数える。
 * ミリ秒の足し算・setMonth・暦日の Date を formatLocalDate に直接渡す形は数えない。I3 の時点のそれらの判定:
 *   - 今の時刻 + n × 1 日のミリ秒を formatLocalDate (src/app/api/org/owner-transfer/propose/route.ts の expires_at・
 *     src/lib/shopping-list/active-list.ts の p_end_date): JST に夏時間は無いので JST の n 日後になる。食い違いは起きない
 *   - src/components/ai-assistant/V4GenerateModal.tsx の getDeviceTodayStr: 選べる日付の下限 (今日) は以前から端末の暦で決めていて、
 *     #1433 で「1日だけ」の初期値もそれにそろえた (同じ関数の注記)。この形 (setDate でずらす) ではない。I3 では変えない
 *   - 週の格子の週の始まりや月の 1 日 (端末の 0 時の Date) を formatLocalDate で読む箇所 (menus/weekly/page.tsx の monthRangeOf・
 *     shoppingRangeDates の「表示中の週」の始まり など): 下の 'week-grid' と同じ根。範囲と格子がそろうよう、格子と一緒に直す
 *
 * 2 つめの形 (`new Date(<暦日らしい名前>)`):
 * new Date('2026-11-05') は UTC の 0 時 (JST の 9 時) の瞬間になる。それを端末のローカル時刻 (getFullYear / getMonth / getDate / getDay、
 * timeZone を付けない toLocaleDateString) で読むと、端末が UTC より西 (America/Los_Angeles など) では前の日 (2026-11-04) になる。
 * I3 で直したホームの週間統計の曜日 (useHomeData の getDayOfWeek) はこれで、/meals/new の保存先の日付・体重の 7 日間の推移の日、
 * 健康の画面 (血液検査・健診の一覧と詳細・分析・目標の期限)・食事の詳細の日付・AI 相談の 1 日分の献立を作るときのチャットの文
 * (「○月○日の献立を作成中...」と生成の依頼の note) も同じ形だった (今は、ホームの曜日は calendarDaysEndingAt (暦の計算)、
 * ほかは parseLocalDate (年月日を端末の 0 時の Date にする) か formatDateJa で読む。ホームは tests/week-days-jst-2235.test.tsx、
 * AI 相談は tests/ai-chat-bubble-locks-dates-2235.test.tsx、ほかは tests/calendar-date-display-jst-2235.test.tsx が描いて確かめる)。
 * 製品コードで、暦日らしい名前 (最後の名前が …date / …Date / …Str) の値を new Date() に 1 つだけ渡す箇所を、下の DATE_PARSE_SITES に
 * 「ファイル → 渡す値 → 判定」で載せる (表が正本)。
 *
 *   D-4 製品コードで、この形を書く (ファイル, 渡す値) は、どれも DATE_PARSE_SITES に行がある (新しく書いたら、行を足して判定を書く)
 *   D-5 (ファイル, 渡す値) ごとのこの形の数は、行に書いた数以下
 *   D-6 I3 で直した (ファイル, 渡す値) (FIXED_PARSE_IN_I3) には、この形が 1 つも無い (元の形に戻っていない)
 *
 * 限界 (見張りであって証明ではない): 値の型は見ず、名前だけで拾う。コメントを除いた本文を数える。
 * 名前で拾わないもの・ほかの書き方の I3 の時点の判定:
 *   - 瞬間 (timestamptz の ISO。…_at・…At・iso など) を端末のタイムゾーンで表示する形 (`new Date(created_at).toLocaleDateString('ja-JP')`):
 *     暦日の文字列ではない (瞬間を端末の暦日で見せる別の型)。この形ではない
 *   - 名前が暦日らしくない値: apps/mobile/src/components/ai/AIDayMenuModal.tsx の `new Date(value)` (YYYY-MM-DD の入力が日付として
 *     読めるかの確かめだけ。暦で読まない)・supabase/functions/calculate-segment-stats の `new Date(periodStart)` など
 *     (Edge Functions は UTC で動き、getTime の差と getUTC* で読む)・週の計算の Date の写し (`new Date(start)`・`new Date(base)` など)
 *   - 時刻を付けて端末のローカル時刻として読む形 (`new Date(day + 'T00:00:00')` など)・Date.UTC で作る形: 端末のタイムゾーンに左右されない
 *   - 名前が暦日らしくない値の残り (I3 の時点): 瞬間の ISO を端末か JST の時刻で表示する箇所 (運営・サポートの画面の日時・
 *     src/lib/admin/format-datetime.ts・請求書の期間 (Stripe の unix 秒を toISOString にした瞬間) など)・保存した時刻との差
 *     (src/components/ProfileReminderBanner.tsx)。どれも暦日の文字列ではない
 *
 * 3 つめの形 (今の時刻を端末の暦で読む):
 * new Date() の getDay / getDate / getMonth / getFullYear は、端末のタイムゾーンの暦で答える。端末が日本でないと、JST の今日
 * (todayLocal / formatLocalDate) と日・曜日が違う。JST の日付と組むと食い違う。I3 で直した /menus/weekly の「今日の栄養」の見出し
 * (src/app/(main)/menus/weekly/_components/modals/StatsModal.tsx) はこれで、日付を JST の今日 (formatLocalDate(today)) で、曜日を
 * 端末の暦 (today.getDay()) で読んでいたので、America/Los_Angeles で JST の 2026-11-05 (木) 10:00 に開くと「11月5日（水）の栄養」、
 * Pacific/Kiritimati で JST の 20:00 に開くと「11月5日（金）の栄養」になった (今は親 (menus/weekly/page.tsx) が 1 回だけ読んだ
 * JST の今日 (todayStr) を受け取り、日付と曜日をその暦日から読む。親はその同じ todayStr で今日の栄養を引き、栄養の詳細を開く日を決める。
 * tests/calendar-date-display-jst-2235.test.tsx が描いて確かめる)。
 * 製品コードで、今の時刻を入れた変数 (`const x = new Date()`・行の頭の `x = new Date()`) を端末の暦の getter で読む箇所と、
 * `new Date().getFullYear()` のように直接読む箇所を、下の NOW_DEVICE_CALENDAR_SITES に「ファイル → 読む変数 → 判定」で載せる (表が正本)。
 *
 *   D-7 製品コードで、この形を書く (ファイル, 読む変数) は、どれも NOW_DEVICE_CALENDAR_SITES に行がある (新しく書いたら、行を足して判定を書く)
 *   D-8 (ファイル, 読む変数) ごとのこの形の数は、行に書いた数以下
 *   D-9 I3 で直した (ファイル, 読んでいた変数) (FIXED_NOW_READ_IN_I3) には、この形が 1 つも無い (元の形に戻っていない)
 *
 * 限界 (見張りであって証明ではない): 変数はファイルの中の名前だけで追う (スコープは区別しない)。コメントを除いた本文を数える。
 * 拾わないもの・ほかの書き方の I3 の時点の判定:
 *   - 関数の引数の既定値 (`date: Date = new Date()`。packages/shared の formatLocalDate・monthLocal など): Asia/Tokyo を
 *     指定して読む (formatLocalDate) か不正な値の確かめで、端末の暦の getter では読まない
 *   - `new Date(Date.now())`・`useState(() => new Date())`・`useMemo(() => new Date())` などで作った今の時刻: I3 の時点で製品コードに無い
 *     (useState の初期値で今の時刻を使う 1 か所 (super-admin の料金の変更の日時) は toISOString の文字列で、端末の暦の getter では読まない)
 *   - 時刻 (getHours) の時間帯で決める箇所 (ホームの挨拶と今の食事の区分・/meals/new の食事の区分の既定・/menus/weekly の次の食事の
 *     自動展開): 暦日を作らない (日付は JST の今日、朝・昼・夜は端末の時刻)。時間帯をどちらの時刻で決めるかは暦日の食い違いではない
 *     別の判断なので、I3 では変えない (以前から)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { rel, ROOT, stripComments } from './helpers/ai-reach';

/** 判定 */
type DateShiftVerdict =
  /** 瞬間 (時刻を持つ値) の足し算で、JST の暦日の文字列にしない (toISOString・期間の起点など)。日付の食い違いは起きない */
  | 'instant'
  /** 暦の Date をずらしてから、同じ端末の暦 (getFullYear / getMonth / getDate) で読む。または呼び出し元が無い。食い違いは起きない */
  | 'device-calendar'
  /**
   * 週の格子 (端末の 0 時の週の始まりを setDate でずらし、formatLocalDate で dateStr にする)。JST より東の端末では、表示の日 (getDate) と
   * dateStr が 1 日ずれる。週の格子ごとの作り直しになるので I3 の範囲の外 (別の Issue の候補)
   */
  | 'week-grid';

interface DateShiftSite {
  /** この形の数の上限 (I3 の時点の数) */
  readonly maxCount: number;
  readonly verdict: DateShiftVerdict;
  /** どこで何をずらしているか */
  readonly note: string;
}

/** 製品コードでこの形を書くファイル (リポジトリの根からの相対パス) */
const DATE_SHIFT_SITES: Readonly<Record<string, DateShiftSite>> = {
  'src/app/(main)/meals/new/page.tsx': {
    maxCount: 3,
    verdict: 'week-grid',
    note: 'getWeekDates (週の 7 日の dateStr を formatLocalDate で作る) と前後の週への移動',
  },
  'src/app/(main)/menus/weekly/page.tsx': {
    maxCount: 6,
    verdict: 'week-grid',
    note: 'getWeekDates・getWeekStart・isDateInWeek・献立のある日を読む窓 (shiftDays)・前後の週への移動',
  },
  'src/app/(main)/menus/weekly/_state/reducers/weekViewReducer.ts': {
    maxCount: 1,
    verdict: 'week-grid',
    note: '週の始まりの既定 (端末の今日の週の月曜の 0 時)',
  },
  'src/app/api/admin/users/[id]/freeze/route.ts': {
    maxCount: 1,
    verdict: 'instant',
    note: '一時凍結の解除の時刻 (toISOString で保存)',
  },
  'src/lib/admin/user-ban.ts': {
    maxCount: 1,
    verdict: 'instant',
    note: '一時凍結の解除の時刻 (toISOString で保存)',
  },
  'src/app/api/support/users/[id]/route.ts': {
    maxCount: 1,
    verdict: 'instant',
    note: '最近の AI セッションを数える期間の起点 (瞬間)',
  },
  'packages/shared/src/nutrition-planner.ts': {
    maxCount: 1,
    verdict: 'instant',
    note: '目標体重の到達予想日 (toISOString で返す)',
  },
  'packages/shared/src/date-utils.ts': {
    maxCount: 1,
    verdict: 'device-calendar',
    note: 'addDays (暦の Date をずらすだけ。呼び出し元は getFullYear などで読む)',
  },
  'packages/core/src/utils/week-utils.ts': {
    maxCount: 5,
    verdict: 'device-calendar',
    note: '週の計算の道具。同じファイルの formatLocalDate は getFullYear / getMonth / getDate で読む (Asia/Tokyo の formatLocalDate ではない)',
  },
  'lib/seasonal-events.ts': {
    maxCount: 1,
    verdict: 'device-calendar',
    note: 'getDoyoUshiDays (暦の Date の年月日を比べるだけ。呼び出し元は無い)',
  },
};

/** I3 で直したファイル。この形が 1 つも無いこと (D-3) */
const FIXED_IN_I3 = [
  'src/app/(main)/health/page.tsx',
  'src/app/(main)/health/streaks/page.tsx',
  'src/hooks/useHomeData.ts',
  'src/app/(main)/menus/weekly/_components/modals/ShoppingRangeModal.tsx',
  'src/app/(main)/menus/weekly/_state/shoppingRangeDates.ts',
] as const;

/** 製品コードの置き場 (テストは除く) */
const SCAN_ROOTS = ['src', 'lib', 'packages', 'apps/mobile/src', 'apps/mobile/app', 'supabase/functions'];
const SKIPPED_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next']);
const isProductionSource = (name: string) => /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name) && !name.endsWith('.d.ts');

/** 端末のローカル時刻で日をずらす形 */
const DATE_SHIFT_PATTERN = /\.setDate\(\s*[A-Za-z_$][\w$.]*\.getDate\(\)\s*[-+]/g;

function listProductionFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listProductionFiles(full));
    else if (isProductionSource(entry.name)) out.push(full);
  }
  return out;
}

function countDateShifts(text: string): number {
  return (stripComments(text).match(DATE_SHIFT_PATTERN) ?? []).length;
}

/** 製品コードの、この形を書くファイルと数 */
function scanDateShifts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of SCAN_ROOTS) {
    for (const file of listProductionFiles(path.join(ROOT, root))) {
      const count = countDateShifts(fs.readFileSync(file, 'utf8'));
      if (count > 0) counts.set(rel(file), count);
    }
  }
  return counts;
}

/** 判定 (2 つめの形) */
type DateParseVerdict =
  /** 渡す値が Date (Date の写し)。文字列を読まない。食い違いは起きない */
  | 'date-object'
  /**
   * 文字列を UTC の 0 時として読み、UTC (getUTCMonth / getUTCDay) か JST (formatLocalDate (Asia/Tokyo)。UTC の 0 時は JST の 9 時) で
   * 暦日に戻す。端末のタイムゾーンに左右されない
   */
  | 'utc-or-jst-read'
  /**
   * 時刻の差 (getTime の引き算) か、日付として読めるかの確かめだけ。暦で読まない。
   * 2 つとも UTC の 0 時どうしの差は整数の日数、今の時刻との差は 9 時間以内の違いしか生まない (月の数・並べ替えなどに使うだけ)
   */
  | 'instant-diff'
  /** 渡す値が暦日でなく瞬間 (toISOString の文字列)。同じ端末の暦で作った瞬間を同じ端末の暦で読むので、食い違いは起きない */
  | 'instant';

interface DateParseSite {
  /** この形の数の上限 (I3 の時点の数) */
  readonly maxCount: number;
  readonly verdict: DateParseVerdict;
  /** 何を読んでいるか */
  readonly note: string;
}

/** 製品コードでこの形を書く (ファイル (リポジトリの根からの相対パス) → new Date() に渡す値 → 判定) */
const DATE_PARSE_SITES: Readonly<Record<string, Readonly<Record<string, DateParseSite>>>> = {
  'src/app/(main)/meals/new/page.tsx': {
    startDate: { maxCount: 1, verdict: 'date-object', note: 'getWeekDates の週の始まり (Date) の写し' },
    date: { maxCount: 1, verdict: 'date-object', note: 'getWeekStart に渡す Date の写し' },
  },
  'src/app/(main)/menus/weekly/page.tsx': {
    startDate: { maxCount: 1, verdict: 'date-object', note: 'getWeekDates の週の始まり (Date) の写し' },
    date: { maxCount: 2, verdict: 'date-object', note: 'getWeekStart・isDateInWeek に渡す Date の写し' },
    weekStartDate: { maxCount: 1, verdict: 'date-object', note: 'isDateInWeek の週の始まり (Date) の写し' },
  },
  'src/app/api/ai/menu/v4/generate/route.ts': {
    startDate: { maxCount: 1, verdict: 'utc-or-jst-read', note: '献立の期間の始まりの月を getUTCMonth で読む' },
  },
  'src/app/api/ai/menu/v5/generate/route.ts': {
    startDate: { maxCount: 1, verdict: 'utc-or-jst-read', note: '献立の期間の始まりの月を getUTCMonth で読む' },
  },
  'src/app/onboarding/questions/page.tsx': {
    'computedAnswers.target_date': {
      maxCount: 1,
      verdict: 'instant-diff',
      note: '目標の日までの月の数 (今の時刻との getTime の差 ÷ 30 日) で体重の変え方の速さを決める',
    },
  },
  'src/components/ai-assistant/V4GenerateModal.tsx': {
    startStr: { maxCount: 1, verdict: 'instant-diff', note: 'daysBetween (2 つの暦日の UTC の 0 時の差の日数)' },
    endStr: { maxCount: 1, verdict: 'instant-diff', note: 'daysBetween (2 つの暦日の UTC の 0 時の差の日数)' },
  },
  'src/components/nutrition/nutrition-target-planner.tsx': {
    isoDate: {
      maxCount: 1,
      verdict: 'instant',
      note: '目標体重の到達予想日 (packages/shared/src/nutrition-planner.ts が端末の暦でずらして toISOString で返す瞬間) の表示',
    },
  },
  'src/hooks/useHomeData.ts': {
    'a.day_date': { maxCount: 1, verdict: 'instant-diff', note: '連続自炊の日を新しい順に並べる (getTime の差)' },
    'b.day_date': { maxCount: 1, verdict: 'instant-diff', note: '連続自炊の日を新しい順に並べる (getTime の差)' },
  },
  'lib/seasonal-events.ts': {
    startDate: { maxCount: 1, verdict: 'date-object', note: 'getDoyoUshiDays の 7 月 19 日 (Date) の写し' },
  },
  'packages/core/src/utils/week-utils.ts': {
    date: { maxCount: 3, verdict: 'date-object', note: '週の計算の道具に渡す Date の写し' },
    weekStartDate: { maxCount: 1, verdict: 'date-object', note: 'isDateInWeek の週の始まり (Date) の写し' },
    weekEndDate: { maxCount: 1, verdict: 'date-object', note: 'isDateInWeek の週の終わり (Date) の写し' },
  },
  'packages/shared/src/date-utils.ts': {
    date: { maxCount: 1, verdict: 'date-object', note: 'addDays に渡す Date の写し' },
  },
  'packages/shared/src/nutrition-planner.ts': {
    baseDate: { maxCount: 1, verdict: 'date-object', note: '到達予想日の起点 (Date) の写し' },
  },
  'apps/mobile/src/components/menu/V4GenerateModal.tsx': {
    startStr: { maxCount: 1, verdict: 'instant-diff', note: 'daysBetween (2 つの暦日の UTC の 0 時の差の日数)' },
    endStr: { maxCount: 1, verdict: 'instant-diff', note: 'daysBetween (2 つの暦日の UTC の 0 時の差の日数)' },
  },
  'apps/mobile/app/health/blood-tests.tsx': {
    dateStr: { maxCount: 1, verdict: 'utc-or-jst-read', note: '検査日を formatLocalDate (Asia/Tokyo) で YYYY-MM-DD に戻して表示する' },
  },
  'apps/mobile/app/onboarding/questions.tsx': {
    'ans.target_date': {
      maxCount: 2,
      verdict: 'instant-diff',
      note: '目標の日までの月の数 (今の時刻との getTime の差) で体重の変え方の速さを決める',
    },
  },
  'supabase/functions/generate-menu-v4/context-utils.ts': {
    'params.targetDate': { maxCount: 1, verdict: 'instant-diff', note: '献立の日どうしの日数の差 (UTC の 0 時どうし)' },
    'menu.date': { maxCount: 1, verdict: 'instant-diff', note: '献立の日どうしの日数の差 (UTC の 0 時どうし)' },
  },
  'supabase/functions/regenerate-shopping-list-v2/index.ts': {
    dateStr: { maxCount: 1, verdict: 'utc-or-jst-read', note: 'getDayOfWeek (曜日を getUTCDay で読む)' },
  },
};

/**
 * I3 で直した (ファイル, new Date() に渡していた値)。この形が 1 つも無いこと (D-6)。
 * useHomeData の曜日は calendarDaysEndingAt の dayOfWeek、ほかは parseLocalDate / formatDateJa で読む
 */
const FIXED_PARSE_IN_I3: readonly (readonly [file: string, arg: string])[] = [
  ['src/hooks/useHomeData.ts', 'dateStr'],
  ['src/app/(main)/meals/new/page.tsx', 'selectedDate'],
  ['src/app/(main)/meals/new/page.tsx', 'h.record_date'],
  ['src/app/(main)/health/blood-tests/page.tsx', 'dateStr'],
  ['src/app/(main)/health/checkups/page.tsx', 'dateStr'],
  ['src/app/(main)/health/checkups/[id]/CheckupDetailClient.tsx', 'dateStr'],
  ['src/app/(main)/health/insights/page.tsx', 'dateStr'],
  ['src/app/(main)/health/goals/page.tsx', 'goal.target_date'],
  ['src/app/(main)/meals/[id]/page.tsx', 'meal.dayDate'],
  ['src/components/AIChatBubble.tsx', 'selectedDate'],
];

/** 暦日らしい名前の値を 1 つだけ new Date() に渡す形 (1 つめの組が渡す値。末尾の ! は外す) */
const DATE_PARSE_PATTERN = /new Date\(\s*((?:[A-Za-z_$][\w$]*\??\.)*[A-Za-z_$]?[\w$]*(?:date|Date|Str))\s*!?\s*\)/g;

/** 本文の、この形の渡す値ごとの数 */
function countDateParses(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of stripComments(text).matchAll(DATE_PARSE_PATTERN)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  return counts;
}

/** 製品コードの、この形を書くファイル → 渡す値 → 数 */
function scanDateParses(): Map<string, Map<string, number>> {
  const found = new Map<string, Map<string, number>>();
  for (const root of SCAN_ROOTS) {
    for (const file of listProductionFiles(path.join(ROOT, root))) {
      const counts = countDateParses(fs.readFileSync(file, 'utf8'));
      if (counts.size > 0) found.set(rel(file), counts);
    }
  }
  return found;
}

/** 判定 (3 つめの形) */
type NowReadVerdict =
  /** 今の時刻を端末の暦でずらし、瞬間 (toISOString・期間の起点) として使う (1 つめの表の 'instant' と同じ箇所)。暦日にしない */
  | 'instant'
  /** 週の格子 (端末の今日の週の始まり)。1 つめの表の 'week-grid' と同じ根 (格子と一緒に直す。I3 の範囲の外) */
  | 'week-grid'
  /**
   * 端末の暦の今日・年を、JST の今日 (todayLocal / formatLocalDate(new Date())) とは組まない。比べる相手は利用者が選ぶ日付か
   * 週の格子の日付 (端末の 0 時の週の始まりから作る。JST より東の端末とのずれは 'week-grid' の根)。または画面の飾り (著作権表示の年)
   */
  | 'device-calendar';

interface NowReadSite {
  /** この形の数の上限 (I3 の時点の数) */
  readonly maxCount: number;
  readonly verdict: NowReadVerdict;
  /** 何を読んでいるか */
  readonly note: string;
}

/** `new Date().getFullYear()` のように、今の時刻を変数に入れずに直接読む形の表のキー */
const DIRECT_NOW_READ = 'new Date()';

/** 製品コードでこの形を書く (ファイル (リポジトリの根からの相対パス) → 読む変数 (直接読む形は DIRECT_NOW_READ) → 判定) */
const NOW_DEVICE_CALENDAR_SITES: Readonly<Record<string, Readonly<Record<string, NowReadSite>>>> = {
  'src/app/(main)/settings/page.tsx': {
    [DIRECT_NOW_READ]: { maxCount: 1, verdict: 'device-calendar', note: '画面下の著作権表示の年 (© 2026)。日付の判定に使わない' },
  },
  'src/app/(main)/menus/weekly/_state/reducers/weekViewReducer.ts': {
    d: { maxCount: 2, verdict: 'week-grid', note: 'getDefaultWeekStart (端末の今日の週の月曜の 0 時)。1 つめの表の同じファイルの行と同じ箇所' },
  },
  'src/components/ai-assistant/V4GenerateModal.tsx': {
    now: {
      maxCount: 3,
      verdict: 'device-calendar',
      note:
        'getDeviceTodayStr (このモーダルの今日 = 選べる日付の下限と「1日だけ」の初期値)。以前から端末の暦で決めていて、' +
        '#1433 で初期値もそれにそろえた (同じ関数の注記)。比べる相手は利用者が選ぶ日付と週の格子の日付 (weekStartDate / weekEndDate) で、' +
        'JST の今日とは組まない。I3 では変えない',
    },
  },
  'lib/slot-builder.ts': {
    now: {
      maxCount: 3,
      verdict: 'device-calendar',
      note:
        'getTodayStr (献立の生成の対象を作る関数の startDate の既定)。呼び出し元 (Web とモバイルの V4GenerateModal) はどれも ' +
        'startDate を渡すので既定は使われず、使われてもモーダルの今日 (端末の暦) と同じ',
    },
  },
  'src/app/api/support/users/[id]/route.ts': {
    thirtyDaysAgo: { maxCount: 1, verdict: 'instant', note: '最近の AI セッションを数える期間の起点 (30 日前の今の時刻。toISOString で絞る)' },
  },
  'src/lib/admin/user-ban.ts': {
    unbanDate: { maxCount: 1, verdict: 'instant', note: '一時凍結の解除の時刻 (toISOString で保存)' },
  },
};

/** I3 で直した (ファイル, 読んでいた変数)。この形が 1 つも無いこと (D-9) */
const FIXED_NOW_READ_IN_I3: readonly (readonly [file: string, name: string])[] = [
  ['src/app/(main)/menus/weekly/_components/modals/StatsModal.tsx', 'today'],
];

/** 端末の暦で年・月・日・曜日を読む Date の getter */
const DEVICE_CALENDAR_GETTERS = '(?:getDay|getDate|getMonth|getFullYear)';

/**
 * 今の時刻 (引数なしの new Date()) を入れる変数 (1 つめの組)。const / let / var の宣言と、行の頭の代入。
 * 関数の引数の既定値 (`(date: Date = new Date())`) は、行の頭でも宣言でもないので拾わない
 */
const NOW_BINDING_PATTERN = /(?:\b(?:const|let|var)\s+|^[ \t]*)([A-Za-z_$][\w$]*)\s*(?::\s*Date(?:\s*\|\s*null)?\s*)?=\s*new Date\(\s*\)/gm;

/** 今の時刻を変数に入れずに、端末の暦の getter で直接読む形 */
const NOW_DIRECT_READ_PATTERN = new RegExp(`new Date\\(\\s*\\)\\s*\\.\\s*${DEVICE_CALENDAR_GETTERS}\\(\\)`, 'g');

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 本文の、この形の読む変数ごとの数 (直接読む形は DIRECT_NOW_READ) */
function countNowReads(text: string): Map<string, number> {
  const body = stripComments(text);
  const counts = new Map<string, number>();
  const direct = (body.match(NOW_DIRECT_READ_PATTERN) ?? []).length;
  if (direct > 0) counts.set(DIRECT_NOW_READ, direct);
  const names = new Set([...body.matchAll(NOW_BINDING_PATTERN)].map((match) => match[1]));
  for (const name of names) {
    // 名前の前が識別子の文字か . (別のオブジェクトのプロパティ) なら、その変数ではない
    const reads = body.match(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\.\\s*${DEVICE_CALENDAR_GETTERS}\\(\\)`, 'g')) ?? [];
    if (reads.length > 0) counts.set(name, reads.length);
  }
  return counts;
}

/** 製品コードの、この形を書くファイル → 読む変数 → 数 */
function scanNowReads(): Map<string, Map<string, number>> {
  const found = new Map<string, Map<string, number>>();
  for (const root of SCAN_ROOTS) {
    for (const file of listProductionFiles(path.join(ROOT, root))) {
      const counts = countNowReads(fs.readFileSync(file, 'utf8'));
      if (counts.size > 0) found.set(rel(file), counts);
    }
  }
  return found;
}

describe('端末のローカル時刻で日をずらす形の棚卸し (#2235 I3)', () => {
  const found = scanDateShifts();

  it('検出器は、ずらす形を数え、コメントの中と瞬間のミリ秒の足し算は数えない', () => {
    expect(countDateShifts('d.setDate(d.getDate() + 1);\nnewStart.setDate(weekStart.getDate() - 7);')).toBe(2);
    expect(countDateShifts('// x.setDate(x.getDate() - 6)\n/* y.setDate(y.getDate() + 1) */')).toBe(0);
    expect(countDateShifts('new Date(Date.now() + DAYS * MS_PER_DAY)')).toBe(0);
  });

  it('D-1 この形を書く製品コードのファイルは、どれも表に行がある', () => {
    const unlisted = [...found.keys()].filter((file) => !(file in DATE_SHIFT_SITES));
    expect(unlisted).toEqual([]);
  });

  it('D-2 各ファイルのこの形の数は、表に書いた数以下', () => {
    const over = [...found.entries()]
      .filter(([file, count]) => file in DATE_SHIFT_SITES && count > DATE_SHIFT_SITES[file].maxCount)
      .map(([file, count]) => `${file}: ${count} > ${DATE_SHIFT_SITES[file].maxCount}`);
    expect(over).toEqual([]);
  });

  it('D-3 I3 で直したファイルには、この形が無い', () => {
    for (const file of FIXED_IN_I3) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(found.get(file) ?? 0, file).toBe(0);
    }
  });
});

describe('YYYY-MM-DD の暦日を new Date() に渡す形の棚卸し (#2235 I3)', () => {
  const found = scanDateParses();
  const entries = [...found.entries()].flatMap(([file, counts]) => [...counts.entries()].map(([arg, count]) => ({ file, arg, count })));

  it('検出器は、暦日らしい名前を 1 つ渡す形を渡す値ごとに数え、コメントの中・瞬間・引数なし・時刻つきの文字列は数えない', () => {
    const counts = countDateParses(
      [
        '{new Date(selectedDate).getMonth() + 1}月{new Date(selectedDate).getDate()}日',
        "date: new Date(h.record_date).getDate() + '日',",
        'const d = new Date( dateStr );',
        "期限: {new Date(goal.target_date!).toLocaleDateString('ja-JP')}",
      ].join('\n'),
    );
    expect(Object.fromEntries(counts)).toEqual({ selectedDate: 2, 'h.record_date': 1, dateStr: 1, 'goal.target_date': 1 });
    expect(
      countDateParses(
        [
          '// new Date(dateStr)',
          '/* new Date(selectedDate) */',
          "new Date(created_at).toLocaleDateString('ja-JP')",
          'new Date()',
          'new Date(`${dateStr}T00:00:00`)',
          'parseLocalDate(dateStr)',
        ].join('\n'),
      ).size,
    ).toBe(0);
  });

  it('D-4 この形を書く製品コードの (ファイル, 渡す値) は、どれも表に行がある', () => {
    const unlisted = entries.filter(({ file, arg }) => DATE_PARSE_SITES[file]?.[arg] === undefined).map(({ file, arg }) => `${file}: ${arg}`);
    expect(unlisted).toEqual([]);
  });

  it('D-5 (ファイル, 渡す値) ごとのこの形の数は、表に書いた数以下', () => {
    const over = entries
      .filter(({ file, arg, count }) => DATE_PARSE_SITES[file]?.[arg] !== undefined && count > DATE_PARSE_SITES[file][arg].maxCount)
      .map(({ file, arg, count }) => `${file}: ${arg} ${count} > ${DATE_PARSE_SITES[file][arg].maxCount}`);
    expect(over).toEqual([]);
  });

  it('D-6 I3 で直した (ファイル, 渡していた値) には、この形が無い', () => {
    for (const [file, arg] of FIXED_PARSE_IN_I3) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(found.get(file)?.get(arg) ?? 0, `${file}: ${arg}`).toBe(0);
    }
  });
});

describe('今の時刻を端末の暦で読む形の棚卸し (#2235 I3)', () => {
  const found = scanNowReads();
  const entries = [...found.entries()].flatMap(([file, counts]) => [...counts.entries()].map(([name, count]) => ({ file, name, count })));

  it('検出器は、今の時刻を入れた変数と直接読む形を数え、コメントの中・引数の既定値・ほかの Date・時刻 (getHours)・プロパティは数えない', () => {
    const counts = countNowReads(
      [
        'const today = new Date();',
        '{formatDateJa(formatLocalDate(today))}（{dayNames[today.getDay()]}）の栄養',
        'let unbanDate: Date | null = null;',
        '  unbanDate = new Date();',
        'unbanDate.setDate(unbanDate.getDate() + 1);',
        '&copy; {new Date().getFullYear()} ほめゴハン',
      ].join('\n'),
    );
    expect(Object.fromEntries(counts)).toEqual({ today: 1, unbanDate: 1, [DIRECT_NOW_READ]: 1 });
    expect(
      countNowReads(
        [
          '// const a = new Date(); a.getDay();',
          '/* new Date().getMonth() */',
          'export function formatLocalDate(date: Date = new Date()) { return date.getDate(); }',
          'const b = parseLocalDate(day); b.getDay();',
          'const c = new Date(dateStr); c.getDate();',
          'const hour = new Date().getHours();',
          'const now = new Date(); const t = now.getTime(); other.now.getDay();',
        ].join('\n'),
      ).size,
    ).toBe(0);
  });

  it('D-7 この形を書く製品コードの (ファイル, 読む変数) は、どれも表に行がある', () => {
    const unlisted = entries
      .filter(({ file, name }) => NOW_DEVICE_CALENDAR_SITES[file]?.[name] === undefined)
      .map(({ file, name }) => `${file}: ${name}`);
    expect(unlisted).toEqual([]);
  });

  it('D-8 (ファイル, 読む変数) ごとのこの形の数は、表に書いた数以下', () => {
    const over = entries
      .filter(({ file, name, count }) => NOW_DEVICE_CALENDAR_SITES[file]?.[name] !== undefined && count > NOW_DEVICE_CALENDAR_SITES[file][name].maxCount)
      .map(({ file, name, count }) => `${file}: ${name} ${count} > ${NOW_DEVICE_CALENDAR_SITES[file][name].maxCount}`);
    expect(over).toEqual([]);
  });

  it('D-9 I3 で直した (ファイル, 読んでいた変数) には、この形が無い', () => {
    for (const [file, name] of FIXED_NOW_READ_IN_I3) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(found.get(file)?.get(name) ?? 0, `${file}: ${name}`).toBe(0);
    }
  });
});
