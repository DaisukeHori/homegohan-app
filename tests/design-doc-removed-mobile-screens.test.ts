/**
 * #1659 (#1598) 設計書 (docs/design/) が、消したモバイルのネイティブの画面を、いまある画面 (実装先) として名指ししない
 *
 * #1673 (#1598 / #1610) で、通常の操作で届かないネイティブの画面 (下の REMOVED_MOBILE_SCREENS) を消した。そのとき直した設計書の行
 * (mobile/01-architecture.md §12.4・family/03-ui-spec.md など) は「削除した」と書いたが、ハンズオンツアーの設計書 (family/09) は
 * apps/mobile/app/meals/new.tsx を、まだ sandbox 対応の実装先として挙げていた (07-components.md・12-phases.md・13-integration.md・
 * 16-files-structure.md)。設計書を写して実装すると、消した画面を作り直してしまう。ここで落とす。
 *   1. REMOVED_MOBILE_SCREENS (一覧は tests/helpers/mobile-removed-1598.ts) のファイルは無い (画面を戻すなら、この一覧と設計書を一緒に直す)
 *   2. docs/design/ の .md のうち、そのファイルを名指しする行 (`apps/mobile/app/<パス>` か `app/<パス>`) は、
 *      同じ行で消したことを書く (REMOVAL_NOTE)
 *   3. 走査が空振りしていない (#1673 が直した mobile/01-architecture.md §12.4 の行を見つける)
 * ディレクトリの木の中の短い名前 (`meals/new.tsx`) は行だけでは場所が分からないので、木ごとの検査が受け持つ
 * (family/09 の §5 の木は tests/handson-tour-files-structure-doc.test.ts)。
 * 設計書の走査は、ファイルの一番外側 (収集のとき) で 1 回だけ、消した画面をまとめた 1 つの正規表現で行う
 * (画面ごと・行ごとに正規表現を作って 2 回走査すると、消した画面が 61 になったとき、1 件のテストが既定の時間切れの 5 秒を超えた)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { REMOVED_MOBILE_SCREENS } from './helpers/mobile-removed-1598';

const ROOT = path.resolve(__dirname, '..');
/** 走査する設計書の根 (リポジトリの根からの相対) */
const DESIGN_DIR = 'docs/design';
/** モバイルの画面のディレクトリ (Expo Router の app/) */
const MOBILE_APP_DIR = 'apps/mobile/app';


/** 消したことを書いた行の目印 (「2026-10-15 に削除」「…として消した」) */
const REMOVAL_NOTE = /削除|消した/;

/** 走査が空振りしていないことの目印: #1673 が「削除」と書き直した行 */
const KNOWN_REMOVAL_LINE = {
  file: `${DESIGN_DIR}/mobile/01-architecture.md`,
  screen: 'meals/new.tsx',
} as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 画面のファイルを名指しする書き方: `apps/mobile/app/<パス>` か `app/<パス>`。1 番目の組が画面 (apps/mobile/app からの相対)。
 * 前に英数字・`/`・`-`・`_` が付くもの (Web の `src/app/...` など) は別のファイルなので数えない。
 * 長い画面から並べる (短い画面のパスが長い画面のパスの頭に当たっても、長い方を選ぶ)
 */
const SCREEN_MENTION = new RegExp(
  `(?:^|[^\\w/-])(?:apps/mobile/)?app/(${[...REMOVED_MOBILE_SCREENS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})`,
  'g',
);

/** 名指しを探す前の、安い絞り込み (どの書き方も `app/` を含む) */
const MENTION_HINT = 'app/';

/** 1 行の中で名指しした、消した画面 (同じ画面を 2 回書いても 1 つ) */
function screensMentionedIn(text: string): string[] {
  if (!text.includes(MENTION_HINT)) return [];
  return [...new Set([...text.matchAll(SCREEN_MENTION)].map((match) => match[1]))];
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
      for (const screen of screensMentionedIn(text)) out.push({ file, line: index + 1, screen, text });
    });
  }
  return out;
}

/** 設計書の中で、消した画面のファイルを名指しする行 (収集のときに 1 回だけ集める) */
const scanned = mentions();

describe('#1659 設計書は、#1598 で消したモバイルのネイティブの画面を、いまある画面として名指ししない', () => {
  it('消した画面のファイルは無い (戻すなら、この一覧と設計書を一緒に直す)', () => {
    const present = REMOVED_MOBILE_SCREENS.filter((screen) => fs.existsSync(path.join(ROOT, MOBILE_APP_DIR, screen)));
    expect(present).toEqual([]);
  });

  it('名指しの書き方: apps/mobile/app/ と app/ の両方を拾い、Web の src/app/ は拾わない', () => {
    expect(screensMentionedIn('| `apps/mobile/app/meals/new.tsx` | sandbox prop 対応 |')).toEqual(['meals/new.tsx']);
    expect(screensMentionedIn('// app/meals/new.tsx')).toEqual(['meals/new.tsx']);
    expect(screensMentionedIn('| `src/app/meals/new.tsx` |')).toEqual([]);
    expect(screensMentionedIn('| `src/app/(main)/meals/new/page.tsx` |')).toEqual([]);
  });

  it('名指しの書き方: 1 行に並べた画面を 1 つずつ拾い、似た画面 (meals/[id].tsx と meals/[id]/edit.tsx) を取り違えない', () => {
    expect(
      screensMentionedIn('`apps/mobile/app/(super-admin)/_layout.tsx`・`apps/mobile/app/(support)/_layout.tsx` を包む'),
    ).toEqual(['(super-admin)/_layout.tsx', '(support)/_layout.tsx']);
    expect(screensMentionedIn('| `app/meals/[id]/edit.tsx` | `app/meals/[id].tsx` | `app/meals/[id].tsx` |')).toEqual([
      'meals/[id]/edit.tsx',
      'meals/[id].tsx',
    ]);
  });

  it('走査が空振りしていない (#1673 が直した mobile/01-architecture.md §12.4 の行を見つける)', () => {
    const found = scanned.filter(
      (mention) => mention.file === KNOWN_REMOVAL_LINE.file && mention.screen === KNOWN_REMOVAL_LINE.screen,
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('消した画面のファイルを名指しする行は、同じ行で消したことを書く', () => {
    const stale = scanned
      .filter((mention) => !REMOVAL_NOTE.test(mention.text))
      .map((mention) => `${mention.file}:${mention.line} (${mention.screen})`);
    expect(stale).toEqual([]);
  });
});
