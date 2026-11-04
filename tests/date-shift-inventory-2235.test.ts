// @vitest-environment node
/**
 * #2235 I3 「端末のローカル時刻で日をずらす」形 (`x.setDate(x.getDate() ± n)`) の棚卸しの表と、その見張り。
 *
 * この形は端末の暦で日をずらすので、ずらした Date を JST の暦日 (formatLocalDate (Asia/Tokyo)) にすると、ずらす元によって食い違う。
 *   - 元が今の時刻 (new Date()): 端末の夏時間の切り替えの日に 23 / 25 時間しか進まず、JST の日付が 1 日ずれうる。端末の暦 (getDate など) で
 *     日付にしていた画面は、端末のタイムゾーンが日本でないと今日そのものが JST とずれた。I3 で直した /health の週間カレンダー・
 *     /health/streaks の 7 日・ホームの useHomeData・買い物リストの範囲はこれ (今は todayLocal / addDaysToDate の暦の計算)
 *   - 元が端末の 0 時の Date (parseLocalDate・週の始まり): 端末が JST より東 (UTC+10 など) だと端末の 0 時が JST の前の日なので、
 *     いつも 1 日戻る (例: Australia/Sydney で JST の今日 2026-11-05 から「明日」を作ると 2026-11-05)
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
  | 'week-grid'
  /**
   * 起きる。並行の枝 fix/g-1104e-i1 が触っているファイルなので I3 では直さず、i1 の着地の後に回す
   * (直し方: todayLocal() からの暦の計算 addDaysToDate(todayLocal(), n) にする)
   */
  | 'deferred-after-i1';

interface DateShiftSite {
  /** この形の数の上限 (I3 の時点の数) */
  readonly maxCount: number;
  readonly verdict: DateShiftVerdict;
  /** どこで何をずらしているか */
  readonly note: string;
}

/** 製品コードでこの形を書くファイル (リポジトリの根からの相対パス) */
const DATE_SHIFT_SITES: Readonly<Record<string, DateShiftSite>> = {
  'src/components/AIChatBubble.tsx': {
    maxCount: 2,
    verdict: 'deferred-after-i1',
    note:
      '1 日分の献立の既定の日 (明日 = parseLocalDate(todayLocal()) + 1 日) と日付の欄の上限 (+14 日) を formatLocalDate で読む。' +
      'Australia/Sydney で JST の今日 2026-11-05 のとき、明日 = 2026-11-05 (今日と同じ)・上限 = 2026-11-18 (+13 日)',
  },
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
