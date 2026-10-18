/**
 * #1867 (設計 marketing/01 §24 Q-13) アプリの中のバッジの説明を、実際に付く条件に合わせる migration の静的な検査
 * (migration 20261018040000_badges_description_matches_award.sql。DB を使わない)。実 DB での動きは
 * tests/integration/security/badges-description-matches-award.test.ts が確かめる。
 *
 * バッジの一覧 (src/app/(main)/badges/page.tsx) は、未獲得のバッジの説明を「取り方」として見せる。説明が付く条件と違うと、
 * 書いてあるとおりにしても付かない。そこで、説明を書き換えた 5 つについて、付ける処理のソースから条件を読み、説明と突き合わせる。
 *
 * 確かめること:
 *   1. migration は 5 つのバッジの description だけを書き換える (ほかの列・ほかの文が無い)。rollback は同じ 5 つを元の文に戻す
 *   2. 書き換えた説明が、付ける処理の条件と合う
 *      - first_bite / photo_10 / streak_3 / streak_7: GET /api/badges の判定のしきい値 (完了した食事の数・連続日数) を言い、「完了」と書く。
 *        「記録」「写真」「撮影」とは書かない (食事の記録の画面で写真から保存した食事は未完了で、数えない)
 *      - planner: (20261018040000 の時点) 付けるのは POST /api/menu-plans/add の awardBadge だけで、それを呼ぶのは使い方ガイド
 *        (ハンズオンツアー) のお試しの献立の追加だけ。説明は使い方ガイドのお試しを言い、「1週間の献立を作成」とは書かない
 *   3. 付ける処理のあるバッジ (AWARDABLE_BADGE_CODES) は、この migration で書き換えたか、説明が条件と合うと確かめたものか、のどちらか
 *      (新しく付ける処理を足したら、説明が条件と合うかを確かめてから下の一覧に足す)
 *
 * #1867 の続き (オーナーの選択 2026-10-18 17 時台「取れる条件を足す」): planner は AI の週の献立の生成でも付くようにし、
 * migration 20261018050000_planner_badge_description_weekly_menu.sql で planner の説明だけをもう一度書き換えた。
 *   4. 20261018050000 は planner の description だけを書き換え、rollback は 20261018040000 の文に戻す
 *   5. planner のいまの説明 (後の migration の文) が、付ける処理の条件と合う。付ける処理は次の 3 つだけ:
 *      - POST /api/menu-plans/add の awardBadge (呼ぶのは使い方ガイドのお試しの献立の追加だけ)
 *      - GET /api/ai/menu/weekly/status の awardBadge (週の献立の生成の行 (印あり) の完了を読んだとき)
 *      - GET /api/badges の判定 (完了した週の献立の生成の行があるとき)
 *      週の献立の生成の行の印を書くのは、利用者が AI で週の献立を作る経路 (行を作るとき) だけ:
 *        - POST /api/ai/menu/weekly/request (いつも 7 日分): いつも書く
 *        - POST /api/ai/menu/v4/generate・/v5/generate (Web の AI献立アシスタント・AI のチャット・モバイルの主経路):
 *          対象の枠が 1 週間を覆うときだけ書く
 *        - AI 相談のアクションの 1 週間分の生成 (generate_week_menu): 書く (1 日分・1 食には書かない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AWARDABLE_BADGE_CODES } from '@/lib/badges/awardable';
import {
  BADGE_DESCRIPTION_MIGRATION,
  BADGE_DESCRIPTION_ROLLBACK,
  PLANNER_DESCRIPTION_MIGRATION,
  PLANNER_DESCRIPTION_ROLLBACK,
  REPO_ROOT,
  currentBadgeDescriptions,
  parseDescriptionUpdates,
  readOriginalBadgeRows,
  readRepoFile,
} from './helpers/badge-description-migration';

const BADGES_ROUTE = 'src/app/api/badges/route.ts';
const MENU_PLANS_ADD_ROUTE = 'src/app/api/menu-plans/add/route.ts';
/** 週の献立の生成の状態の確認 (完了を読んだとき planner を付ける。#1867) */
const WEEKLY_STATUS_ROUTE = 'src/app/api/ai/menu/weekly/status/route.ts';
/** 週の献立の生成 (行を作るときに印を書く。#1867) */
const WEEKLY_REQUEST_ROUTE = 'src/app/api/ai/menu/weekly/request/route.ts';
/** 週の献立の生成の行の印 (#1867) */
const WEEKLY_ORIGIN_LIB = 'src/lib/ai/weekly-menu-request-origin.ts';
/** 枠を対象にする献立の生成 (Web の AI献立アシスタント・AI のチャット・モバイルが使う。1 週間を覆うときに印を書く。#1867) */
const V4_GENERATE_ROUTE = 'src/app/api/ai/menu/v4/generate/route.ts';
const V5_GENERATE_ROUTE = 'src/app/api/ai/menu/v5/generate/route.ts';
/** AI 相談のアクション (1 週間分の生成 generate_week_menu で印を書く。#1867) */
const CONSULTATION_EXECUTOR = 'src/lib/ai/consultation-action-executor.ts';
/** POST /api/menu-plans/add を呼ぶ文字列 (引用符か `${...}` の直後に来るパス) */
const MENU_PLANS_ADD_CALL = /[`'"}]\/api\/menu-plans\/add(?![\w-])/;

/** この migration で説明を書き換えたバッジ */
const REWRITTEN_CODES = ['first_bite', 'streak_3', 'streak_7', 'photo_10', 'planner'] as const;

/**
 * 付ける処理はあるが、説明が付く条件と合っていたので書き換えなかったバッジ (#1867 で 1 つずつ確かめた)。
 *   tutorial_complete: complete_handson_tour() が使い方ガイドの卒業の画面でだけ付け、説明は「使い方ガイド完走」
 *   segment_* / improved_* / *_champion: calculate-segment-stats の順位・上位の割合・平均との差・改善率の判定と、説明の数字が合う
 */
const VERIFIED_UNCHANGED_CODES = [
  'tutorial_complete',
  'segment_rank_1',
  'segment_rank_top3',
  'segment_top_5',
  'segment_top_10',
  'segment_top_25',
  'segment_above_avg',
  'segment_above_avg_20',
  'segment_above_avg_50',
  'improved_10',
  'improved_20',
  'improved_50',
  'breakfast_champion',
  'veggie_champion',
  'streak_champion',
] as const;

/** 完了した食事を数えるバッジ。説明に書いてはいけない語 (「記録」は写真から保存した未完了の食事と読み違える) */
const COMPLETION_BADGE_FORBIDDEN_WORDS = ['記録', '写真', '撮影'] as const;
const COMPLETION_WORD = '「完了」';
/** 7 日 = 1 週間 (streak_7 の説明は「1週間連続」と書く) */
const DAYS_PER_WEEK = 7;

const updates = parseDescriptionUpdates(readRepoFile(BADGE_DESCRIPTION_MIGRATION));
const rollback = parseDescriptionUpdates(readRepoFile(BADGE_DESCRIPTION_ROLLBACK));
const plannerUpdates = parseDescriptionUpdates(readRepoFile(PLANNER_DESCRIPTION_MIGRATION));
const plannerRollback = parseDescriptionUpdates(readRepoFile(PLANNER_DESCRIPTION_ROLLBACK));
/** 説明を書き換える migration を全部当てたあとの説明 (いまの DB の説明) */
const current = currentBadgeDescriptions();
const original = readOriginalBadgeRows();
const routeSource = readRepoFile(BADGES_ROUTE);

/** GET /api/badges の `badge.code === '<code>' && <変数> >= <数>` のしきい値 */
function routeThreshold(code: string, variable: 'mealCount' | 'streak'): number {
  const match = new RegExp(`badge\\.code === '${code}' && ${variable} >= (\\d+)`).exec(routeSource);
  if (!match) throw new Error(`${BADGES_ROUTE} に ${code} の判定 (${variable} >= n) が見つかりません`);
  return Number(match[1]);
}

function description(code: string): string {
  const text = updates.get(code);
  if (text === undefined) throw new Error(`${code} の説明の UPDATE がありません`);
  return text;
}

/** dir 配下の、テストを除く .ts / .tsx (プロジェクトルートからの相対パス) */
function sourceFiles(dir: string): string[] {
  const full = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(full)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...sourceFiles(rel));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(rel);
    }
  }
  return files;
}

describe('#1867 バッジの説明の migration: 書き換える範囲', () => {
  it('migration は 5 つのバッジの description だけを書き換え、rollback は同じ 5 つを元の migration の文に戻す', () => {
    expect([...updates.keys()].sort()).toEqual([...REWRITTEN_CODES].sort());
    expect([...rollback.keys()].sort()).toEqual([...REWRITTEN_CODES].sort());
    for (const code of REWRITTEN_CODES) {
      const row = original.get(code);
      expect(row, `${code} の行が元の migration に無い`).toBeDefined();
      expect(rollback.get(code), `${code} の rollback は元の説明に戻す`).toBe(row?.description);
      expect(updates.get(code), `${code} の説明が変わっていない`).not.toBe(row?.description);
    }
  });

  it('書き換えた 5 つは、どれも付ける処理のあるバッジ (AWARDABLE_BADGE_CODES) にある', () => {
    for (const code of REWRITTEN_CODES) {
      expect(AWARDABLE_BADGE_CODES as readonly string[], code).toContain(code);
    }
  });

  it('付ける処理のあるバッジは、どれも書き換えたか、説明が条件と合うと確かめたものにある (新しいバッジの説明の確かめ忘れの検出)', () => {
    const reviewed = new Set<string>([...REWRITTEN_CODES, ...VERIFIED_UNCHANGED_CODES]);
    const unreviewed = AWARDABLE_BADGE_CODES.filter((code) => !reviewed.has(code));
    expect(unreviewed, '説明が付く条件と合うかを確かめて、REWRITTEN_CODES か VERIFIED_UNCHANGED_CODES に足してください').toEqual([]);
    for (const code of VERIFIED_UNCHANGED_CODES) {
      expect(AWARDABLE_BADGE_CODES as readonly string[], `${code} は付ける処理の一覧から外れた`).toContain(code);
      expect(original.has(code), `${code} の行が元の migration に無い`).toBe(true);
    }
  });
});

describe('#1867 バッジの説明の migration: 説明が付く条件と合う', () => {
  it('first_bite: 完了した食事 1 食で付く → 「はじめて」と「完了」を言う', () => {
    expect(routeThreshold('first_bite', 'mealCount')).toBe(1);
    expect(description('first_bite')).toContain('はじめて');
    expect(description('first_bite')).toContain(COMPLETION_WORD);
  });

  it('photo_10: 写真ではなく完了した食事の数で付く → しきい値の食数と「完了」を言う', () => {
    const threshold = routeThreshold('photo_10', 'mealCount');
    expect(description('photo_10')).toContain(`${threshold}食`);
    expect(description('photo_10')).toContain(COMPLETION_WORD);
  });

  it('streak_3 / streak_7: 完了した食事のある日の連続日数で付く → 日数と「完了」を言う', () => {
    const threeDays = routeThreshold('streak_3', 'streak');
    expect(description('streak_3')).toContain(`${threeDays}日連続`);
    expect(routeThreshold('streak_7', 'streak')).toBe(DAYS_PER_WEEK);
    expect(description('streak_7')).toContain('1週間連続');
    for (const code of ['streak_3', 'streak_7']) {
      expect(description(code), code).toContain(COMPLETION_WORD);
    }
  });

  it('完了した食事を数える 4 つは「記録」「写真」「撮影」と書かない', () => {
    for (const code of ['first_bite', 'photo_10', 'streak_3', 'streak_7']) {
      for (const word of COMPLETION_BADGE_FORBIDDEN_WORDS) {
        expect(description(code), `${code} の説明に「${word}」がある`).not.toContain(word);
      }
    }
  });

  it('planner (20261018040000 の時点の文): 使い方ガイドのお試しを言い、「1週間の献立を作成」とは書かない', () => {
    expect(description('planner')).toContain('使い方ガイド');
    expect(description('planner')).toContain('お試し');
    expect(description('planner')).not.toContain('1週間の献立を作成');
  });
});

describe('#1867 planner の説明の migration (20261018050000): AI の週の献立の生成でも付く', () => {
  it('migration は planner の description だけを書き換え、rollback は 20261018040000 の文に戻す', () => {
    expect([...plannerUpdates.keys()]).toEqual(['planner']);
    expect([...plannerRollback.keys()]).toEqual(['planner']);
    expect(plannerRollback.get('planner')).toBe(updates.get('planner'));
    expect(plannerUpdates.get('planner')).not.toBe(updates.get('planner'));
    expect(plannerUpdates.get('planner')).not.toBe(original.get('planner')?.description);
  });

  it('planner のいまの説明は 20261018050000 の文で、ほかの 4 つは 20261018040000 の文のまま', () => {
    expect(current.get('planner')).toBe(plannerUpdates.get('planner'));
    for (const code of REWRITTEN_CODES.filter((c) => c !== 'planner')) {
      expect(current.get(code), code).toBe(updates.get(code));
    }
  });

  it('planner を付ける処理は、お試しの献立の追加・週の献立の生成の完了の状態の確認・バッジの一覧の判定の 3 つだけ', () => {
    // awardBadge(..., 'planner') を呼ぶソースは POST /api/menu-plans/add と GET /api/ai/menu/weekly/status だけ
    const plannerAwarders = sourceFiles('src')
      .filter((file) => /awardBadge\([^)]*'planner'\)/.test(readRepoFile(file)))
      .sort();
    expect(plannerAwarders).toEqual([WEEKLY_STATUS_ROUTE, MENU_PLANS_ADD_ROUTE].sort());

    // 状態の確認が付けるのは、完了 (completed) で、週の献立の生成の印のある行だけ
    const statusSource = readRepoFile(WEEKLY_STATUS_ROUTE);
    expect(statusSource).toMatch(/request\.status === 'completed' && isWeeklyMenuRequestWeeklyOrigin\(request\.weekly_request\)/);

    // GET /api/badges は、完了した週の献立の生成の行があるときに planner を判定する
    expect(routeSource).toMatch(/badge\.code === 'planner' && hasCompletedWeeklyMenuRequest/);

    // POST /api/menu-plans/add を呼ぶ画面は、どれも使い方ガイド (ハンズオンツアー) のお試しの経路。
    // 呼び出しは、パスで始まる文字列 ('/api/menu-plans/add…'・`${base}/api/menu-plans/add…`) で拾う (コメントの「POST /api/menu-plans/add」は拾わない)
    const callers = [...sourceFiles('src'), ...sourceFiles('apps/mobile/src'), ...sourceFiles('apps/mobile/app')]
      .filter((file) => file !== MENU_PLANS_ADD_ROUTE && MENU_PLANS_ADD_CALL.test(readRepoFile(file)))
      .sort();
    expect(callers).toEqual([
      'apps/mobile/src/components/menu/V4GenerateModal.tsx',
      'src/app/handson-tour/menu/page.tsx',
      'src/components/ai-assistant/V4GenerateModal.tsx',
    ]);
    for (const file of callers) {
      expect(readRepoFile(file), `${file} がお試しの経路でない`).toMatch(/source=handson_tour|sandbox: true/);
    }

    // 週の献立の生成の行の印を書くのは、利用者が AI で週の献立を作る経路だけ (印の定義のファイルを除く):
    //   - いつも書く (weeklyMenuRequestWeeklyOriginData): いつも 7 日分を作る POST /api/ai/menu/weekly/request だけ
    //   - 対象の枠が 1 週間を覆うときだけ書く (weeklyMenuRequestWeeklyOriginDataForDates): v4/generate・v5/generate・AI 相談のアクション
    const writersOf = (call: RegExp) =>
      [...sourceFiles('src'), ...sourceFiles('supabase/functions')]
        .filter((file) => file !== WEEKLY_ORIGIN_LIB && call.test(readRepoFile(file)))
        .sort();
    expect(writersOf(/\bweeklyMenuRequestWeeklyOriginData\(/)).toEqual([WEEKLY_REQUEST_ROUTE]);
    expect(writersOf(/\bweeklyMenuRequestWeeklyOriginDataForDates\(/)).toEqual(
      [V4_GENERATE_ROUTE, V5_GENERATE_ROUTE, CONSULTATION_EXECUTOR].sort(),
    );

    // AI 相談のアクションで印を書くのは 1 週間分の生成 (generate_week_menu) の中の 1 か所だけ (1 日分・1 食には書かない)
    const executorSource = readRepoFile(CONSULTATION_EXECUTOR);
    expect(executorSource.match(/weeklyMenuRequestWeeklyOriginDataForDates\(/g) ?? []).toHaveLength(1);
    const weekCase = executorSource.slice(
      executorSource.indexOf("case 'generate_week_menu'"),
      executorSource.indexOf("case 'generate_single_meal'"),
    );
    expect(weekCase).toMatch(/weeklyMenuRequestWeeklyOriginDataForDates\(/);
  });

  it('planner のいまの説明は、AI で 1 週間の献立をはじめて作ったことと、使い方ガイドのお試しの両方を言う', () => {
    const text = current.get('planner') ?? '';
    expect(text).toContain('AI');
    expect(text).toContain('1週間の献立');
    expect(text).toContain('はじめて');
    expect(text).toContain('使い方ガイド');
    expect(text).toContain('お試し');
  });
});
