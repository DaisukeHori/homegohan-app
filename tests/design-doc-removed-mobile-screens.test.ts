/**
 * #1659 (#1598) 設計書 (docs/design/) が、消したモバイルのネイティブの画面とファイルを、いまあるもの (実装先・読み手) として名指ししない
 *
 * #1673 (#1598 / #1610) で、通常の操作で届かないネイティブの画面 (下の REMOVED_MOBILE_SCREENS) を消した。そのとき直した設計書の行
 * (mobile/01-architecture.md §12.4・family/03-ui-spec.md など) は「削除した」と書いたが、ハンズオンツアーの設計書 (family/09) は
 * apps/mobile/app/meals/new.tsx を、まだ sandbox 対応の実装先として挙げていた (07-components.md・12-phases.md・13-integration.md・
 * 16-files-structure.md)。設計書を写して実装すると、消した画面を作り直してしまう。ここで落とす。
 * #1598 の続きでは、消した画面と一緒に部品・テスト・maestro の flow も消した。そのあと別の設計書が、消したモバイルのテスト
 * (`apps/mobile/__tests__/app/profile-name-placeholder-lists.test.tsx`)・根のテスト (`tests/mobile-super-admin-api-contract.test.ts`) を
 * 「走らせて確認する」番兵として挙げ、運営の MFA の設計 (cross/12) は、消した区画 ((super-admin)・(support)) を機械検査の定数
 * (`MOBILE_GATED_AREAS = ['apps/mobile/app/(super-admin)', …]`) に持ったままだった (行に「削除した」と書いても、定数として残れば検査が空振りする)。
 *   1. REMOVED_MOBILE_SCREENS と REMOVED_REPO_FILES (一覧は tests/helpers/mobile-removed-1598.ts) のファイルは無い
 *      (画面を戻すなら、この一覧と設計書を一緒に直す)
 *   2. docs/design/ の .md のうち、消した画面を名指しする行 (`apps/mobile/app/<パス>` か `app/<パス>`) は、同じ行で消したことを書く (REMOVAL_NOTE)
 *   3. 消した部品・テスト・maestro の flow・根のファイルを、リポジトリの根からのパス (`apps/mobile/<パス>`・`tests/<パス>`) で名指しする行も、
 *      同じ行で消したことを書く (短い書き方の `src/<パス>` は Web のパスと区別できないので見ない)
 *   4. 設計書のコードが文字列 (`'…'` / `"…"`) で持つ `apps/mobile/app/<パス>` は、消した画面やその区画 (消した画面を含むディレクトリ) を指さない
 *      (注記があっても赤。glob の `/**` は外して確かめる)
 *   5. 走査が空振りしていない (#1673 が直した mobile/01-architecture.md §12.4 の行と、コードの文字列の 1 件以上を見つける)
 * ディレクトリの木の中の短い名前 (`meals/new.tsx`) は行だけでは場所が分からないので、木ごとの検査が受け持つ
 * (family/09 の §5 の木は tests/handson-tour-files-structure-doc.test.ts)。
 * 設計書の走査は、ファイルの一番外側 (収集のとき) で 1 回だけ、消したものをまとめた正規表現で行う
 * (画面ごと・行ごとに正規表現を作って 2 回走査すると、消した画面が 61 になったとき、1 件のテストが既定の時間切れの 5 秒を超えた)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REMOVED_MAESTRO_FLOW_DIRS,
  REMOVED_MAESTRO_FLOWS,
  REMOVED_MOBILE_SCREENS,
  REMOVED_MOBILE_SOURCE_FILES,
  REMOVED_REPO_FILES,
} from './helpers/mobile-removed-1598';

const ROOT = path.resolve(__dirname, '..');
/** 走査する設計書の根 (リポジトリの根からの相対) */
const DESIGN_DIR = 'docs/design';
/** モバイルのディレクトリ (リポジトリの根からの相対) */
const MOBILE_DIR = 'apps/mobile';
/** モバイルの画面のディレクトリ (Expo Router の app/) */
const MOBILE_APP_DIR = `${MOBILE_DIR}/app`;
/** maestro の flow のディレクトリ */
const MAESTRO_DIR = `${MOBILE_DIR}/maestro`;

/** 消したことを書いた行の目印 (「2026-10-15 に削除」「…として消した」) */
const REMOVAL_NOTE = /削除|消した/;

/** 走査が空振りしていないことの目印: #1673 が「削除」と書き直した行 */
const KNOWN_REMOVAL_LINE = {
  file: `${DESIGN_DIR}/mobile/01-architecture.md`,
  screen: 'meals/new.tsx',
} as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 長いものから並べた選択 (短いパスが長いパスの頭に当たっても、長い方を選ぶ) */
const alternation = (items: readonly string[]): string =>
  [...items]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

/** 名指しの前に付かない文字 (英数字・`/`・`-`・`_`。付くものは別のディレクトリの下のパス。Web の `src/app/...` など) */
const NOT_PATH_BEFORE = '(?:^|[^\\w/-])';
/** ファイルの名前のすぐ後ろに続かないこと (storage.ts が storage.tsx の頭に当たらないように) */
const END_OF_PATH = '(?![\\w-])';
/** ディレクトリの下の flow のファイル (サブディレクトリの下も) */
const FLOW_FILE = '[\\w.-]+(?:/[\\w.-]+)*\\.ya?ml';

/**
 * 画面のファイルを名指しする書き方: `apps/mobile/app/<パス>` か `app/<パス>`。1 番目の組が画面 (apps/mobile/app からの相対)。
 * 前に英数字・`/`・`-`・`_` が付くもの (Web の `src/app/...` など) は別のファイルなので数えない
 */
const SCREEN_MENTION = new RegExp(
  `${NOT_PATH_BEFORE}(?:${escapeRegExp(MOBILE_DIR)}/)?app/(${alternation(REMOVED_MOBILE_SCREENS)})`,
  'g',
);

/**
 * 画面のほかに消したファイルを、リポジトリの根からのパスで名指しする書き方。どの選択肢も組を 1 つだけ持ち、組は根からのパスになる
 * (部品・テスト = `apps/mobile/<パス>`・maestro の flow = `apps/mobile/maestro/<パス>`・根のファイル = `<パス>`)
 */
const REMOVED_FILE_MENTION = new RegExp(
  [
    `${NOT_PATH_BEFORE}(${escapeRegExp(MOBILE_DIR)}/(?:${alternation(REMOVED_MOBILE_SOURCE_FILES)}))${END_OF_PATH}`,
    `${NOT_PATH_BEFORE}(${escapeRegExp(MAESTRO_DIR)}/(?:${alternation(REMOVED_MAESTRO_FLOWS)}))${END_OF_PATH}`,
    `${NOT_PATH_BEFORE}(${escapeRegExp(MAESTRO_DIR)}/(?:${alternation(REMOVED_MAESTRO_FLOW_DIRS)})/${FLOW_FILE})${END_OF_PATH}`,
    `${NOT_PATH_BEFORE}((?:${alternation(REMOVED_REPO_FILES)}))${END_OF_PATH}`,
  ].join('|'),
  'g',
);

/** コードの文字列 (`'…'` か `"…"`) で書いた、apps/mobile/app の下のパス。1 番目の組が apps/mobile/app からの相対 (glob の `/**` は外す) */
const MOBILE_APP_CODE_LITERAL = new RegExp(
  `['"]${escapeRegExp(MOBILE_APP_DIR)}/([^'"\\s*]+?)(?:/\\*\\*?)?['"]`,
  'g',
);

/** 名指しを探す前の、安い絞り込み (画面と部品・flow は `app` を含む。根のファイルはそれぞれの頭のディレクトリを含む) */
const MENTION_HINTS = ['app', ...new Set(REMOVED_REPO_FILES.map((file) => file.slice(0, file.indexOf('/') + 1)))];

/** 1 行の中で名指しした、消した画面 (同じ画面を 2 回書いても 1 つ) */
function screensMentionedIn(text: string): string[] {
  if (!text.includes('app/')) return [];
  return [...new Set([...text.matchAll(SCREEN_MENTION)].map((match) => match[1]))];
}

/** 1 行の中で、画面のほかに消したファイルを名指ししたもの (リポジトリの根からのパス) */
function removedFilesMentionedIn(text: string): string[] {
  if (!MENTION_HINTS.some((hint) => text.includes(hint))) return [];
  return [
    ...new Set([...text.matchAll(REMOVED_FILE_MENTION)].map((match) => match.slice(1).find((group) => group !== undefined) ?? '')),
  ];
}

/** 消した画面か、消した画面を含むディレクトリ (区画) か (apps/mobile/app からの相対) */
function isRemovedScreenOrArea(relative: string): boolean {
  return REMOVED_MOBILE_SCREENS.some((screen) => screen === relative || screen.startsWith(`${relative}/`));
}

/** 1 行の中のコードの文字列のうち、apps/mobile/app の下のパス (apps/mobile/app からの相対) */
function mobileAppCodeLiteralsIn(text: string): string[] {
  if (!text.includes(MOBILE_APP_DIR)) return [];
  return [...text.matchAll(MOBILE_APP_CODE_LITERAL)].map((match) => match[1]);
}

/** コードの文字列が、いまは無い、消した画面か区画を指すか */
function pointsToRemovedScreen(relative: string): boolean {
  return isRemovedScreenOrArea(relative) && !fs.existsSync(path.join(ROOT, MOBILE_APP_DIR, relative));
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

type Mention = { file: string; line: number; target: string; text: string };
type Scan = { screens: Mention[]; files: Mention[]; codeLiterals: Mention[] };

/** 設計書の中で、消した画面・ファイルを名指しする行と、apps/mobile/app の下を指すコードの文字列 */
function scanDesignDocs(): Scan {
  const scan: Scan = { screens: [], files: [], codeLiterals: [] };
  for (const file of listMarkdown(DESIGN_DIR)) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((text, index) => {
      const line = index + 1;
      for (const target of screensMentionedIn(text)) scan.screens.push({ file, line, target, text });
      for (const target of removedFilesMentionedIn(text)) scan.files.push({ file, line, target, text });
      for (const target of mobileAppCodeLiteralsIn(text)) scan.codeLiterals.push({ file, line, target, text });
    });
  }
  return scan;
}

/** 設計書の走査 (収集のときに 1 回だけ) */
const scanned = scanDesignDocs();

const describeMention = (mention: Mention): string => `${mention.file}:${mention.line} (${mention.target})`;

describe('#1659 設計書は、#1598 で消したモバイルのネイティブの画面とファイルを、いまあるものとして名指ししない', () => {
  it('消した画面と、apps/mobile の外で一緒に消したファイルは無い (戻すなら、この一覧と設計書を一緒に直す)', () => {
    const present = [
      ...REMOVED_MOBILE_SCREENS.map((screen) => `${MOBILE_APP_DIR}/${screen}`),
      ...REMOVED_REPO_FILES,
    ].filter((file) => fs.existsSync(path.join(ROOT, file)));
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

  it('消したファイルの名指しの書き方: 部品・テスト・maestro の flow・根のファイルを根からのパスで拾い、短い書き方と残したファイルは拾わない', () => {
    // 16-auth-history-sessions.md (origin/main 3b070f2b) が「走らせて確認」の番兵として挙げていた書き方
    expect(
      removedFilesMentionedIn(
        '`tests/support-routes.test.ts`・`apps/mobile/__tests__/app/profile-name-placeholder-lists.test.tsx` (:55〜56)',
      ),
    ).toEqual(['apps/mobile/__tests__/app/profile-name-placeholder-lists.test.tsx']);
    expect(removedFilesMentionedIn('| N-30 | `tests/mobile-super-admin-api-contract.test.ts` | `(super-admin)` |')).toEqual([
      'tests/mobile-super-admin-api-contract.test.ts',
    ]);
    expect(removedFilesMentionedIn('`apps/mobile/maestro/flows/pantry/01-add-item.yaml`・`apps/mobile/maestro/pantry-flow.yaml`')).toEqual(
      ['apps/mobile/maestro/flows/pantry/01-add-item.yaml', 'apps/mobile/maestro/pantry-flow.yaml'],
    );
    // 短い書き方 (Web と区別できない)・残したファイル・同じ名前の頭を持つ別のファイルは拾わない
    expect(removedFilesMentionedIn('`src/lib/storage.ts` の `uploadFridgePhoto`')).toEqual([]);
    expect(removedFilesMentionedIn('`apps/mobile/src/lib/api.ts`・`apps/mobile/__tests__/app/error-boundaries.test.tsx`')).toEqual([]);
    expect(removedFilesMentionedIn('`apps/mobile/src/lib/storage.tsx`・`web/tests/mobile-super-admin-api-contract.test.ts`')).toEqual([]);
  });

  it('コードの文字列の書き方: 消した区画・画面を指す文字列を拾い、残した区画・glob の付いた残した区画・Web のパスは拾わない', () => {
    const literals = mobileAppCodeLiteralsIn(
      "const MOBILE_GATED_AREAS = ['apps/mobile/app/(super-admin)', 'apps/mobile/app/(support)']; // 2026-10-16 に削除した",
    );
    expect(literals).toEqual(['(super-admin)', '(support)']);
    expect(literals.filter(pointsToRemovedScreen)).toEqual(['(super-admin)', '(support)']);
    expect(mobileAppCodeLiteralsIn('"apps/mobile/app/badges/index.tsx"').filter(pointsToRemovedScreen)).toEqual([
      'badges/index.tsx',
    ]);
    expect(mobileAppCodeLiteralsIn("'apps/mobile/app/handson-tour/**'")).toEqual(['handson-tour']);
    expect(['handson-tour', '(tabs)', '(tabs)/settings.tsx'].filter(pointsToRemovedScreen)).toEqual([]);
    expect(mobileAppCodeLiteralsIn("const PAGE_ROOTS = ['src/app/(support)/support']")).toEqual([]);
    // markdown のコード (バッククォート) は文字列として数えない (行の名指しの検査が受け持つ)
    expect(mobileAppCodeLiteralsIn('`apps/mobile/app/(super-admin)/_layout.tsx`')).toEqual([]);
  });

  it('走査が空振りしていない (#1673 が直した mobile/01-architecture.md §12.4 の行と、コードの文字列を 1 件以上見つける)', () => {
    const found = scanned.screens.filter(
      (mention) => mention.file === KNOWN_REMOVAL_LINE.file && mention.target === KNOWN_REMOVAL_LINE.screen,
    );
    expect(found.length).toBeGreaterThan(0);
    expect(scanned.codeLiterals.length).toBeGreaterThan(0);
  });

  it('消した画面のファイルを名指しする行は、同じ行で消したことを書く', () => {
    const stale = scanned.screens.filter((mention) => !REMOVAL_NOTE.test(mention.text)).map(describeMention);
    expect(stale).toEqual([]);
  });

  it('消した部品・テスト・maestro の flow・根のファイルを名指しする行も、同じ行で消したことを書く', () => {
    const stale = scanned.files.filter((mention) => !REMOVAL_NOTE.test(mention.text)).map(describeMention);
    expect(stale).toEqual([]);
  });

  it('設計書のコードの文字列 (機械検査の定数など) は、消した画面やその区画を指さない (同じ行に消したと書いても赤)', () => {
    const stale = scanned.codeLiterals.filter((mention) => pointsToRemovedScreen(mention.target)).map(describeMention);
    expect(stale).toEqual([]);
  });
});
