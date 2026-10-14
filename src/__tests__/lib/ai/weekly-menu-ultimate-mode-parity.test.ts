/**
 * Web とモバイルの「究極モードの生成か」の判定の突合 (#1609)
 *
 * 以前は、Web (src/lib/ai/weekly-menu-request-ultimate.ts の isUltimateModeWeeklyMenuRequest) とモバイル
 * (apps/mobile/app/menus/weekly/index.tsx の isUltimatePendingRequest) に別々の判定があった (どちらも `=== true`)。
 * 片方だけを変えると、同じ生成中の行で Web とモバイルの進捗カードの段 (究極 / 通常) が食い違う。
 * #1609 で判定を @homegohan/shared の 1 つの関数に寄せ、両方の利用者をそこへ移した。このテストは
 *   1. 共有の判定の基準 (真偽値の true のときだけ究極モード)
 *   2. Web の利用者 (生成中の行の確認の route・週間献立の画面) とモバイルの週間献立の画面が、どれも共有の判定を使い、
 *      自前の判定を持たないこと (ソースの検査)
 * を検査する。モバイルの画面の振る舞い (応答の ultimateMode で進捗カードの種類が変わる) は
 * apps/mobile/__tests__/menus-weekly/ultimate-progress-card.test.tsx が検査する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUltimateModeWeeklyMenuRequest } from '@homegohan/shared';
import * as webLib from '@/lib/ai/weekly-menu-request-ultimate';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * コメントの行を除いたソース (経緯を書いたコメントの `=== true` に当たらないように、コードの行だけを検査する)。
 * 行の頭が // ・ * ・ /* ・ {/* の行を除く ('image/*' のような文字列を含む行を消さないよう、行単位で判定する)
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}

const SHARED_IMPORT = /import\s*\{[^}]*\bisUltimateModeWeeklyMenuRequest\b[^}]*\}\s*from\s*["']@homegohan\/shared["']/;

describe('共有の判定 (@homegohan/shared の isUltimateModeWeeklyMenuRequest) の基準', () => {
  it('真偽値の true のときだけ究極モード', () => {
    expect(isUltimateModeWeeklyMenuRequest(true)).toBe(true);
  });

  it.each([false, null, undefined, 'true', 1, {}, []])('%p は通常の生成 (印の無い古い行・古いサーバーの応答を含む)', (value) => {
    expect(isUltimateModeWeeklyMenuRequest(value)).toBe(false);
  });
});

describe('Web: 共有の判定を使い、自前の判定を持たない', () => {
  it('src/lib/ai/weekly-menu-request-ultimate.ts は判定を持たない (書く側の値と読む列の指定だけ)', () => {
    expect(Object.keys(webLib).sort()).toEqual(['WEEKLY_MENU_REQUEST_ULTIMATE_MODE_SELECT', 'weeklyMenuRequestUltimateModeData']);
    expect(stripComments(read('src/lib/ai/weekly-menu-request-ultimate.ts'))).not.toMatch(/===\s*true/);
  });

  it.each([
    'src/app/api/ai/menu/weekly/pending/route.ts',
    'src/app/(main)/menus/weekly/page.tsx',
  ])('%s は判定を @homegohan/shared から読む', (file) => {
    expect(read(file)).toMatch(SHARED_IMPORT);
  });

  it('生成中の行の確認は、行の ultimate_mode を共有の判定にかけて ultimateMode として返す', () => {
    expect(read('src/app/api/ai/menu/weekly/pending/route.ts')).toContain(
      'ultimateMode: isUltimateModeWeeklyMenuRequest(pendingRequest.ultimate_mode),',
    );
  });
});

describe('モバイル: 共有の判定を使い、自前の判定を持たない', () => {
  const mobileFile = 'apps/mobile/app/menus/weekly/index.tsx';
  const mobileSource = read(mobileFile);
  const mobileCode = stripComments(mobileSource);

  it('週間献立の画面は判定を @homegohan/shared から読む', () => {
    expect(mobileSource).toMatch(SHARED_IMPORT);
  });

  it('入り直しの判定 (isUltimatePendingRequest) は、応答の ultimateMode を共有の判定にかけるだけ', () => {
    const fn = mobileCode.match(/function isUltimatePendingRequest\([^)]*\): boolean \{([\s\S]*?)\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![1].trim()).toBe('return isUltimateModeWeeklyMenuRequest(res.ultimateMode);');
  });

  it('応答の ultimateMode を自前で比べるところが無い', () => {
    expect(mobileCode).not.toMatch(/\.ultimateMode\s*===?\s*true/);
  });

  it('生成中の行の判定は、入り直しの判定 (isUltimatePendingRequest) を通して進捗カードの種類に渡す', () => {
    expect(mobileCode).toContain('setPendingIsUltimate(isUltimatePendingRequest(res));');
  });
});
