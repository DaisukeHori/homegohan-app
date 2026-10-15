/**
 * Web とモバイルの「究極モードの生成か」の判定の突合 (#1609)
 *
 * 以前は、Web (src/lib/ai/weekly-menu-request-ultimate.ts の isUltimateModeWeeklyMenuRequest) とモバイル
 * (apps/mobile/app/menus/weekly/index.tsx の isUltimatePendingRequest。この画面は #1598 で消した) に別々の判定があった (どちらも `=== true`)。
 * 片方だけを変えると、同じ生成中の行で Web とモバイルの進捗カードの段 (究極 / 通常) が食い違う。
 * #1609 で判定を @homegohan/shared の 1 つの関数に寄せ、両方の利用者をそこへ移した。
 * モバイルの週間献立のネイティブの画面は、その後 #1598 で消した (献立のタブは WebView で Web の画面を出す)。このテストは
 *   1. 共有の判定の基準 (真偽値の true のときだけ究極モード)
 *   2. Web の利用者 (生成中の行の確認の route・週間献立の画面) が共有の判定を使い、自前の判定を持たないこと (ソースの検査)
 *   3. モバイルのソースに、自前の判定が戻っていないこと
 * を検査する。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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

describe('モバイル: 自前の判定を持たない', () => {
  // モバイルの週間献立の画面 (apps/mobile/app/menus/weekly/index.tsx) は、通常の操作で届かないネイティブの画面として消した (#1598)。
  // 献立のタブは WebView で Web の週間献立の画面を出すので、進捗カードの段は Web の判定で決まる。
  // モバイルのソースに、応答・行の ultimateMode を自前で比べるところが戻っていないことを見る
  const MOBILE_DIRS = ['apps/mobile/app', 'apps/mobile/src'];
  const walk = (rel: string): string[] =>
    readdirSync(join(ROOT, rel), { withFileTypes: true }).flatMap((entry) => {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) return walk(child);
      return /\.tsx?$/.test(entry.name) ? [child] : [];
    });
  const mobileFiles = MOBILE_DIRS.flatMap(walk);

  it('走査が空振りしていない (残した画面・フックを読んでいる)', () => {
    expect(mobileFiles).toContain('apps/mobile/app/(tabs)/menus.tsx');
    expect(mobileFiles).toContain('apps/mobile/src/hooks/useV4MenuGeneration.ts');
  });

  it('応答・行の ultimateMode / ultimate_mode を自前で比べるところが無い', () => {
    const offenders = mobileFiles.filter((file) =>
      /\.(?:ultimateMode|ultimate_mode)\s*===?\s*true/.test(stripComments(read(file))),
    );
    expect(offenders).toEqual([]);
  });
});
