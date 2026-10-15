/**
 * #1659 (#1598) 設計書 (docs/design/) が、消したモバイルのネイティブの画面を、いまある画面 (実装先) として名指ししない
 *
 * #1673 (#1598 / #1610) で、通常の操作で届かないネイティブの画面 (下の REMOVED_MOBILE_SCREENS) を消した。そのとき直した設計書の行
 * (mobile/01-architecture.md §12.4・family/03-ui-spec.md など) は「削除した」と書いたが、ハンズオンツアーの設計書 (family/09) は
 * apps/mobile/app/meals/new.tsx を、まだ sandbox 対応の実装先として挙げていた (07-components.md・12-phases.md・13-integration.md・
 * 16-files-structure.md)。設計書を写して実装すると、消した画面を作り直してしまう。ここで落とす。
 *   1. REMOVED_MOBILE_SCREENS のファイルは無い (画面を戻すなら、この一覧と設計書を一緒に直す)
 *   2. docs/design/ の .md のうち、そのファイルを名指しする行 (`apps/mobile/app/<パス>` か `app/<パス>`) は、
 *      同じ行で消したことを書く (REMOVAL_NOTE)
 *   3. 走査が空振りしていない (#1673 が直した mobile/01-architecture.md §12.4 の行を見つける)
 * ディレクトリの木の中の短い名前 (`meals/new.tsx`) は行だけでは場所が分からないので、木ごとの検査が受け持つ
 * (family/09 の §5 の木は tests/handson-tour-files-structure-doc.test.ts)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** 走査する設計書の根 (リポジトリの根からの相対) */
const DESIGN_DIR = 'docs/design';
/** モバイルの画面のディレクトリ (Expo Router の app/) */
const MOBILE_APP_DIR = 'apps/mobile/app';

/** #1673 (#1598 / #1610) と #1598 の続きで消したネイティブの画面 (MOBILE_APP_DIR からの相対) */
const REMOVED_MOBILE_SCREENS = [
  'meals/new.tsx',
  'family/index.tsx',
  'profile/index.tsx',
  'comparison/index.tsx',
  '(public)/company.tsx',
  '(public)/contact.tsx',
  '(public)/faq.tsx',
  '(public)/guide.tsx',
  '(public)/legal.tsx',
  '(public)/news.tsx',
  // #1598 の続き (通常の操作で届かない残りのネイティブの画面。_layout も含む)
  '(tabs)/favorites.tsx',
  '(tabs)/health.tsx',
  'ai/[sessionId].tsx',
  'ai/important.tsx',
  'ai/index.tsx',
  'badges/index.tsx',
  'health/challenges.tsx',
  'health/checkups/[id].tsx',
  'health/checkups/index.tsx',
  'health/checkups/new.tsx',
  'health/goals.tsx',
  'health/graphs.tsx',
  'health/insights.tsx',
  'health/record/[date].tsx',
  'health/record/index.tsx',
  'health/record/quick.tsx',
  'health/settings.tsx',
  'health/streaks.tsx',
  'meals/[id].tsx',
  'meals/[id]/edit.tsx',
  'menus/weekly/index.tsx',
  'menus/weekly/request/index.tsx',
  'pantry/index.tsx',
  'shopping-list/index.tsx',
  'recipes/[id].tsx',
  'recipes/[id]/edit.tsx',
  'recipes/collections/[collectionId].tsx',
  'recipes/collections/index.tsx',
  'recipes/collections/select.tsx',
  'recipes/index.tsx',
  'recipes/new.tsx',
  '(org)/_layout.tsx',
  '(org)/org/challenges.tsx',
  '(org)/org/dashboard.tsx',
  '(org)/org/departments.tsx',
  '(org)/org/invites.tsx',
  '(org)/org/members.tsx',
  '(org)/org/settings.tsx',
  '(support)/_layout.tsx',
  '(support)/support/index.tsx',
  '(support)/support/inquiries.tsx',
  '(support)/support/inquiries/[id].tsx',
  '(support)/support/users.tsx',
  '(support)/support/users/[id].tsx',
  '(super-admin)/_layout.tsx',
  '(super-admin)/super-admin/admins.tsx',
  '(super-admin)/super-admin/database.tsx',
  '(super-admin)/super-admin/feature-flags.tsx',
  '(super-admin)/super-admin/index.tsx',
  '(super-admin)/super-admin/settings.tsx',
] as const;

/** 消したことを書いた行の目印 (「2026-10-15 に削除」「…として消した」) */
const REMOVAL_NOTE = /削除|消した/;

/** 走査が空振りしていないことの目印: #1673 が「削除」と書き直した行 */
const KNOWN_REMOVAL_LINE = {
  file: `${DESIGN_DIR}/mobile/01-architecture.md`,
  screen: 'meals/new.tsx',
} as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 画面のファイルを名指しする書き方: `apps/mobile/app/<パス>` か `app/<パス>`。
 * 前に英数字・`/`・`-`・`_` が付くもの (Web の `src/app/...` など) は別のファイルなので数えない
 */
function mentionOf(screen: string): RegExp {
  return new RegExp(`(?:^|[^\\w/-])(?:apps/mobile/)?app/${escapeRegExp(screen)}`);
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listMarkdown(rel));
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

type Mention = { file: string; line: number; screen: string; text: string };

/** 設計書の中で、消した画面のファイルを名指しする行 */
function mentions(): Mention[] {
  const out: Mention[] = [];
  for (const file of listMarkdown(DESIGN_DIR)) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const screen of REMOVED_MOBILE_SCREENS) {
        if (mentionOf(screen).test(text)) out.push({ file, line: index + 1, screen, text });
      }
    });
  }
  return out;
}

describe('#1659 設計書は、#1598 で消したモバイルのネイティブの画面を、いまある画面として名指ししない', () => {
  it('消した画面のファイルは無い (戻すなら、この一覧と設計書を一緒に直す)', () => {
    const present = REMOVED_MOBILE_SCREENS.filter((screen) => fs.existsSync(path.join(ROOT, MOBILE_APP_DIR, screen)));
    expect(present).toEqual([]);
  });

  it('名指しの書き方: apps/mobile/app/ と app/ の両方を拾い、Web の src/app/ は拾わない', () => {
    const pattern = mentionOf('meals/new.tsx');
    expect(pattern.test('| `apps/mobile/app/meals/new.tsx` | sandbox prop 対応 |')).toBe(true);
    expect(pattern.test('// app/meals/new.tsx')).toBe(true);
    expect(pattern.test('| `src/app/meals/new.tsx` |')).toBe(false);
    expect(pattern.test('| `src/app/(main)/meals/new/page.tsx` |')).toBe(false);
  });

  it('走査が空振りしていない (#1673 が直した mobile/01-architecture.md §12.4 の行を見つける)', () => {
    const found = mentions().filter(
      (mention) => mention.file === KNOWN_REMOVAL_LINE.file && mention.screen === KNOWN_REMOVAL_LINE.screen,
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('消した画面のファイルを名指しする行は、同じ行で消したことを書く', () => {
    const stale = mentions()
      .filter((mention) => !REMOVAL_NOTE.test(mention.text))
      .map((mention) => `${mention.file}:${mention.line} (${mention.screen})`);
    expect(stale).toEqual([]);
  });
});
