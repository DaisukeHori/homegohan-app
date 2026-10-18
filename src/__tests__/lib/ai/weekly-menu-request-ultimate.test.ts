/**
 * 献立生成のリクエストの行が究極モード (#1142) の生成かを見分ける判定 (#1582)
 *
 * 行の mode (v4 / v5) は生成のエンジンで、究極モードを表さない。見分けは generated_data.ultimateMode だけで行う。
 * 行を作るところ (v4 の生成の route・AI 相談のアクション) は、作った時点で generated_data に ultimateMode を書く。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WEEKLY_MENU_REQUEST_ULTIMATE_MODE_SELECT,
  weeklyMenuRequestUltimateModeData,
} from '@/lib/ai/weekly-menu-request-ultimate';
// 判定は Web とモバイルで同じ基準にするため @homegohan/shared に置く (#1609。突合は weekly-menu-ultimate-mode-parity.test.ts)
import { isUltimateModeWeeklyMenuRequest } from '@homegohan/shared';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('isUltimateModeWeeklyMenuRequest', () => {
  it('真偽値の true のときだけ究極モード', () => {
    expect(isUltimateModeWeeklyMenuRequest(true)).toBe(true);
  });

  it.each([false, null, undefined, 'true', 1, {}])('%p は通常の生成', (value) => {
    expect(isUltimateModeWeeklyMenuRequest(value)).toBe(false);
  });
});

describe('weeklyMenuRequestUltimateModeData', () => {
  it('行を作るときに generated_data へ書く値は { ultimateMode } で、判定がそのまま読み戻せる', () => {
    expect(weeklyMenuRequestUltimateModeData(true)).toEqual({ ultimateMode: true });
    expect(weeklyMenuRequestUltimateModeData(false)).toEqual({ ultimateMode: false });
    expect(isUltimateModeWeeklyMenuRequest(weeklyMenuRequestUltimateModeData(true).ultimateMode)).toBe(true);
    expect(isUltimateModeWeeklyMenuRequest(weeklyMenuRequestUltimateModeData(false).ultimateMode)).toBe(false);
  });

  it('生成中の行の確認が読む列は、書くキー (ultimateMode) と同じ', () => {
    const [, path] = WEEKLY_MENU_REQUEST_ULTIMATE_MODE_SELECT.split(':');
    expect(path).toBe(`generated_data->${Object.keys(weeklyMenuRequestUltimateModeData(true))[0]}`);
  });
});

describe('行を作るところは、究極モードかを generated_data に書く (#1582)', () => {
  it('v4 の生成の route は、行を作るときに判定した ultimateMode を generated_data に書く', () => {
    const src = read('src/app/api/ai/menu/v4/generate/route.ts');
    // #1867: 1 週間の生成なら週の献立の生成の印も一緒に広げて書くので、{ ...weeklyMenuRequestUltimateModeData(ultimateMode), ... } の形
    expect(src).toMatch(/generated_data:\s*\{\s*\.\.\.weeklyMenuRequestUltimateModeData\(ultimateMode\),/);
  });

  it('AI 相談のアクションは、行を作る 3 か所 (1 日分・1 週間分・1 食) すべてで generated_data に書く', () => {
    const src = read('src/lib/ai/consultation-action-executor.ts');
    const inserts = src.match(/\.from\('weekly_menu_requests'\)\s*\.insert\(\{[\s\S]*?\}\)\s*\.select/g) ?? [];
    expect(inserts).toHaveLength(3);
    for (const insert of inserts) {
      // #1867: 1 週間分の生成は週の献立の生成の印も一緒に広げて書くので、{ ...weeklyMenuRequestUltimateModeData(ultimate), ... } の形もある
      expect(insert).toMatch(/generated_data:\s*(?:weeklyMenuRequestUltimateModeData\(ultimate\)|\{\s*\.\.\.weeklyMenuRequestUltimateModeData\(ultimate\),)/);
    }
  });

  it('v5 の生成の route は、キューに積む generated_data に ultimateMode を入れている (前から)', () => {
    const src = read('src/app/api/ai/menu/v5/generate/route.ts');
    expect(src).toMatch(/generated_data:\s*\{\s*\.\.\.params/);
    expect(src).toMatch(/^\s*ultimateMode,\s*$/m);
  });
});
