/**
 * #1598 ソース・テスト・文書は、消したモバイルのファイル (画面・部品・関数・テスト) と名前・maestro の flow を、いまあるものとして名指ししない
 *
 * #1598 の続きで、通常の操作で届かないネイティブの画面と、それだけが使う部品・関数・テスト・maestro の flow を消した。
 * そのあとも、Web・共有・テストのコメントが、消したファイルや関数を「いまアプリがそうしている」と書いたまま残り、
 * maestro の直下には消した画面へ入る flow が残っていた (このテストの FORMER_TEXTS に元の文を置き、見張りが捕まえることを確かめる)。
 *   - src/lib/shopping-list-request-error.ts: 「アプリは apps/mobile/src/lib/menu-request-error.ts の
 *     shoppingListRequestErrorMessageForDisplay を通す」(アプリから消した関数。Web に同じ名前が残るので、名前で grep すると見つかる)
 *   - src/__tests__/config/status-color-tokens.test.ts: 「モバイルも同じ値 (消したモバイルの表 の MEAL_TYPE_COLORS) を使っている」
 *   - tests/meal-type-visuals-1665.test.ts: 「モバイルの表は (消したモバイルのテスト) が固定する」
 *   - maestro の pantry-flow.yaml など: 消した冷蔵庫・買い物リスト・健康・週の献立・AI 相談の画面へ入る flow。
 *     home-navigation.yaml は、消した「お気に入り」のタブをタップしていた
 * tests/docs-mobile-removed-references.test.ts は CLAUDE.md と README の「`…`」で囲んだ書き方だけを見るので、
 * 引用符で囲まないコードのコメントは見ていなかった。ここでは git で管理するテキストのファイルを全部見る。
 *   1. 消したファイル (tests/helpers/mobile-removed-1598.ts の画面・部品・関数・テスト・maestro の flow) を名指しする行
 *      (`apps/mobile/<パス>`。画面は `app/<パス>` も) は、同じ行で消したことを書く (REMOVAL_NOTE)
 *   2. 「apps/mobile/<ファイル>.ts(x) の 名前」(名前は ` で囲んでも囲まなくてもよい。「/」「・」「、」で並べた名前も) と書いた名前のうち、
 *      #1598 でアプリから消した名前 (MOBILE_NAMES_REMOVED_IN_1598) は、そのファイルが export していなければ、同じ行で消したことを書く
 *   3. 消した画面だけを前提にしていた maestro の flow とそのディレクトリは無い。タブを順にたどる flow (home-navigation.yaml) が
 *      タップするタブの名前は、いまのタブ (apps/mobile/app/(tabs)/_layout.tsx の title) にある
 *   4. 走査が空振りしていない (いまの行のうち、消したことを書いた名指しと「ファイル の 名前」の書き方を見つける)
 * 見ないもの:
 *   - supabase/migrations/: 適用済みの migration は書き換えない (その時点の記録)
 *   - docs/design/: tests/design-doc-removed-mobile-screens.test.ts が受け持つ
 *   - docs/requirements/: 要件の記録。これから作るファイル (新規) も名指しするので、実在とは突き合わせない
 *   - .cursor/: 作業の計画の記録
 *   - 見張りのテスト 3 本 (EXCLUDED_FILES): 捕まえることを確かめるために、元の文をそのまま持つ
 * この検査の限界: パスも「ファイル の 名前」も書かずに、消した画面を言葉だけで「いまある」と書いた文
 * (「モバイルの管理画面が使う」など) は捕まえない。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MOBILE_NAMES_REMOVED_IN_1598,
  REMOVED_MAESTRO_FLOWS,
  REMOVED_MAESTRO_FLOW_DIRS,
  REMOVED_MOBILE_SCREENS,
  REMOVED_MOBILE_SOURCE_FILES,
} from './helpers/mobile-removed-1598';

const ROOT = path.resolve(__dirname, '..');
/** モバイルのディレクトリ (リポジトリの根からの相対) */
const MOBILE_DIR = 'apps/mobile';
/** maestro の flow のディレクトリ */
const MAESTRO_DIR = `${MOBILE_DIR}/maestro`;
/** タブの画面の並び (title がタブの名前) */
const TABS_LAYOUT = `${MOBILE_DIR}/app/(tabs)/_layout.tsx`;
/** タブを順にたどる flow */
const TAB_WALK_FLOW = `${MAESTRO_DIR}/home-navigation.yaml`;

/** 消したことを書いた行の目印 (「削除」「消した」「消しました」「消して」「消し、」) */
const REMOVAL_NOTE = /削除|消し[たまて、]/;

/** 見ないディレクトリ (理由はファイルの先頭のコメント) */
const EXCLUDED_DIRS = ['supabase/migrations/', 'docs/design/', 'docs/requirements/', '.cursor/'] as const;
/** 見ないファイル: 元の文をそのまま持つ見張りのテスト */
const EXCLUDED_FILES = [
  'tests/mobile-removed-files-references.test.ts',
  'tests/docs-mobile-removed-references.test.ts',
  'tests/design-doc-removed-mobile-screens.test.ts',
] as const;
/** 見るテキストのファイルの拡張子 */
const TEXT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md', '.yaml', '.yml', '.sh', '.json'] as const;
/** 見ないファイルの名前 (依存の固定の表。大きく、ファイルの名指しを含まない) */
const EXCLUDED_BASENAMES = ['package-lock.json'] as const;
/** git ls-files の出力の上限 (いまは数百 KB。tests/no-committed-credentials.test.ts の git の呼び出しと同じ値) */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ファイルの名前のすぐ後ろに続かないこと (storage.ts が storage.tsx の頭に当たらないように) */
const END_OF_PATH = '(?![\\w-])';

/**
 * 消したファイルを名指しする書き方。どこを名指ししたかを 1 番目の組で返す。
 *   - 画面: `apps/mobile/app/<パス>` か `app/<パス>` (前に英数字・`/`・`-`・`_` が付く Web の `src/app/...` は数えない)
 *   - 部品・関数・テスト: `apps/mobile/<パス>`
 *   - maestro の flow: `apps/mobile/maestro/<パス>`
 */
const REMOVED_FILE_MENTION = new RegExp(
  [
    `(?:^|[^\\w/-])(?:${escapeRegExp(MOBILE_DIR)}/)?(app/(?:${REMOVED_MOBILE_SCREENS.map(escapeRegExp).join('|')}))${END_OF_PATH}`,
    `${escapeRegExp(MOBILE_DIR)}/((?:${REMOVED_MOBILE_SOURCE_FILES.map(escapeRegExp).join('|')}))${END_OF_PATH}`,
    `${escapeRegExp(MAESTRO_DIR)}/((?:${REMOVED_MAESTRO_FLOWS.map(escapeRegExp).join('|')}))${END_OF_PATH}`,
  ].join('|'),
  'g',
);

/** 名前 (識別子)。後ろに識別子の文字や `-` が続くもの (testID の home-screen など) は名前として数えない */
const NAME = '`?[A-Za-z_$][\\w$]*`?(?![\\w$-])';
/** 「apps/mobile/<ファイル>.ts(x) の 名前 / 名前」の書き方 (1 番目の組がファイル、2 番目の組が並べた名前) */
const MOBILE_EXPORT_MENTION = new RegExp(
  `(${escapeRegExp(MOBILE_DIR)}/[\\w()\\[\\]./@-]+?\\.tsx?)\`?\\)? ?の ?(${NAME}(?:\\s*[/・、]\\s*${NAME})*)`,
  'g',
);

const REMOVED_NAMES: ReadonlySet<string> = new Set(MOBILE_NAMES_REMOVED_IN_1598);

type Mention = { file: string; line: number; target: string; noted: boolean; text: string };

/** 名指しを探す前の、安い絞り込み (どの書き方も `app/` を含む。`apps/mobile/` も `app` の後ろに `s/` が付くだけなので含む) */
const MENTION_HINT = 'app';

/** 1 行の中で、消したファイルを名指ししているところ */
function removedFilesInLine(text: string): string[] {
  if (!text.includes(MENTION_HINT)) return [];
  return [...text.matchAll(REMOVED_FILE_MENTION)].map((match) => match[1] ?? `${MOBILE_DIR}/${match[2] ?? `maestro/${match[3]}`}`);
}

/** ファイルが、その名前を export しているか */
function exportsName(source: string, name: string): boolean {
  const bare = escapeRegExp(name);
  return new RegExp(
    `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${bare}\\b|export\\s*\\{[^}]*\\b${bare}\\b[^}]*\\}`,
  ).test(source);
}

/** 1 行の中の「apps/mobile/<ファイル> の 名前」のうち、#1598 でアプリから消した名前で、そのファイルが export していないもの */
function removedNamesAttributedInLine(text: string, readSource: (file: string) => string | null): string[] {
  const found: string[] = [];
  if (!text.includes(MOBILE_DIR)) return found;
  for (const match of text.matchAll(MOBILE_EXPORT_MENTION)) {
    const [, file, names] = match;
    for (const name of names.split(/[/・、]/).map((part) => part.trim().replace(/`/g, ''))) {
      if (!REMOVED_NAMES.has(name)) continue;
      const source = readSource(file);
      if (source === null || !exportsName(source, name)) found.push(`${file} の ${name}`);
    }
  }
  return found;
}

/** 「apps/mobile/<ファイル> の 名前」の書き方を見つけた数 (走査が空振りしていないことの確かめ用) */
function exportMentionCount(text: string): number {
  if (!text.includes(MOBILE_DIR)) return 0;
  return [...text.matchAll(MOBILE_EXPORT_MENTION)].length;
}

function readRepoFile(file: string): string | null {
  const full = path.join(ROOT, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

/**
 * git で管理するファイルの一覧。ファイルの一番外側 (収集のとき) で 1 回だけ git を起こし、テスト・フックの中では起こさない
 * (テストの時間切れに git の起動の時間が入らない。tests/heavy-unit-test-timeout.test.ts の「同じ型」の対象外)
 */
const gitLsFiles = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: GIT_OUTPUT_MAX_BYTES });

/** 見るファイル (git で管理するテキストのファイル。見ないディレクトリ・ファイルを除く) */
function listScannedFiles(): string[] {
  if (gitLsFiles.error || gitLsFiles.status !== 0) {
    throw new Error(`git ls-files に失敗しました: ${gitLsFiles.error?.message ?? gitLsFiles.stderr}`);
  }
  return gitLsFiles.stdout
    .split('\0')
    .filter(Boolean)
    .filter((file) => TEXT_EXTENSIONS.some((ext) => file.endsWith(ext)))
    .filter((file) => !EXCLUDED_DIRS.some((dir) => file.startsWith(dir)))
    .filter((file) => !(EXCLUDED_FILES as readonly string[]).includes(file))
    .filter((file) => !(EXCLUDED_BASENAMES as readonly string[]).includes(path.basename(file)))
    .filter((file) => fs.existsSync(path.join(ROOT, file)));
}

type Scan = { files: string[]; removedFiles: Mention[]; removedNames: Mention[]; exportMentions: { file: string; count: number }[] };

/** すべての見るファイルを 1 回だけ読んで、名指しを集める */
function scanRepo(): Scan {
  const files = listScannedFiles();
  const sources = new Map<string, string | null>();
  const readSource = (file: string) => {
    if (!sources.has(file)) sources.set(file, readRepoFile(file));
    return sources.get(file) ?? null;
  };
  const removedFiles: Mention[] = [];
  const removedNames: Mention[] = [];
  const exportMentions: { file: string; count: number }[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    let count = 0;
    lines.forEach((text, index) => {
      const noted = REMOVAL_NOTE.test(text);
      for (const target of removedFilesInLine(text)) removedFiles.push({ file, line: index + 1, target, noted, text });
      for (const target of removedNamesAttributedInLine(text, readSource)) removedNames.push({ file, line: index + 1, target, noted, text });
      count += exportMentionCount(text);
    });
    if (count > 0) exportMentions.push({ file, count });
  }
  return { files, removedFiles, removedNames, exportMentions };
}

const describeStale = (mentions: Mention[]) =>
  mentions.filter((mention) => !mention.noted).map((mention) => `${mention.file}:${mention.line} (${mention.target})`);

/** 直す前に書いていた文 (見張りがこれを捕まえることを確かめる) */
const FORMER_TEXTS = {
  shoppingListRequestError:
    ' * アプリは apps/mobile/src/lib/menu-request-error.ts の shoppingListRequestErrorMessageForDisplay を通す (#1576)。元の文は Edge Function が構造化ログ (app_logs) に残している。',
  statusColorTokens:
    ' * 食事の種類の色 (朝食・昼食) は状態色ではなく、モバイルも同じ値 (apps/mobile/src/lib/meal-type-visuals.ts の MEAL_TYPE_COLORS) を使っている。',
  mealTypeVisuals1665: ' * モバイルの表は apps/mobile/__tests__/lib/meal-type-visuals.test.ts が固定する。',
  healthBloodTest: ' * モバイルの健診の詳細画面 (apps/mobile/app/health/checkups/[id].tsx) も同じ基準値・判定を使うよう、',
  shortScreen: ' * 以前は router.push("/profile") で、同じパスのネイティブのプロフィール画面 (app/profile/index.tsx) が、',
  maestroFlow: '# 手順は apps/mobile/maestro/pantry-flow.yaml を見る',
} as const;

const scan = scanRepo();

describe('#1598 ソース・テスト・文書は、消したモバイルのファイル・名前・maestro の flow を、いまあるものとして名指ししない', () => {
  describe('見張りの形 (元の文を捕まえ、消したことを書いた行・Web のファイル・いまあるファイルは捕まえない)', () => {
    it('消したファイルの名指し: 元の文の 5 つを捕まえる', () => {
      expect(removedFilesInLine(FORMER_TEXTS.statusColorTokens)).toEqual(['apps/mobile/src/lib/meal-type-visuals.ts']);
      expect(removedFilesInLine(FORMER_TEXTS.mealTypeVisuals1665)).toEqual([
        'apps/mobile/__tests__/lib/meal-type-visuals.test.ts',
      ]);
      expect(removedFilesInLine(FORMER_TEXTS.healthBloodTest)).toEqual(['app/health/checkups/[id].tsx']);
      expect(removedFilesInLine(FORMER_TEXTS.shortScreen)).toEqual(['app/profile/index.tsx']);
      expect(removedFilesInLine(FORMER_TEXTS.maestroFlow)).toEqual(['apps/mobile/maestro/pantry-flow.yaml']);
    });

    it('消したファイルの名指し: Web の src/app/・いまあるファイル・名前の頭が同じ別のファイルは捕まえない', () => {
      expect(removedFilesInLine('| `src/app/(main)/health/checkups/[id]/page.tsx` |')).toEqual([]);
      expect(removedFilesInLine('// src/app/meals/new.tsx')).toEqual([]);
      expect(removedFilesInLine('apps/mobile/src/lib/menu-request-error.ts の menuRequestErrorMessageForDisplay')).toEqual([]);
      expect(removedFilesInLine('apps/mobile/src/lib/storage.tsx')).toEqual([]);
      expect(removedFilesInLine('apps/mobile/maestro/smoke.yaml')).toEqual([]);
    });

    it('「apps/mobile のファイル の 名前」: アプリから消した名前を、引用符で囲まない書き方でも捕まえる', () => {
      expect(removedNamesAttributedInLine(FORMER_TEXTS.shoppingListRequestError, readRepoFile)).toEqual([
        'apps/mobile/src/lib/menu-request-error.ts の shoppingListRequestErrorMessageForDisplay',
      ]);
      expect(
        removedNamesAttributedInLine(
          '`apps/mobile/src/lib/menu-request-error.ts` の `menuRequestErrorMessageForDisplay` / `shoppingListRequestErrorMessageForDisplay`',
          readRepoFile,
        ),
      ).toEqual(['apps/mobile/src/lib/menu-request-error.ts の shoppingListRequestErrorMessageForDisplay']);
    });

    it('「apps/mobile のファイル の 名前」: Web の記述・export している名前・消した名前でない名前は捕まえない', () => {
      expect(
        removedNamesAttributedInLine('Realtime で行を受ける Web の画面も shoppingListRequestErrorMessageForDisplay を通す', readRepoFile),
      ).toEqual([]);
      expect(
        removedNamesAttributedInLine('apps/mobile/src/lib/menu-request-error.ts の menuRequestErrorMessageForDisplay', readRepoFile),
      ).toEqual([]);
      expect(removedNamesAttributedInLine('apps/mobile/app/(tabs)/home.tsx の webview-home', readRepoFile)).toEqual([]);
    });

    it('消したことを書いた行は、名指しがあっても古い記述として数えない', () => {
      expect(REMOVAL_NOTE.test(FORMER_TEXTS.statusColorTokens)).toBe(false);
      expect(REMOVAL_NOTE.test('(その画面 apps/mobile/app/health/checkups/[id].tsx は、その後、通常の操作で届かない画面として消した。#1598)')).toBe(true);
      expect(REMOVAL_NOTE.test('食事の詳細 (`apps/mobile/app/meals/[id].tsx`) は、あわせて消しました (#1598)。')).toBe(true);
    });
  });

  it('消したファイルを名指しする行は、同じ行で消したことを書く', () => {
    expect(describeStale(scan.removedFiles)).toEqual([]);
  });

  it('「apps/mobile のファイル の 名前」と書いた、#1598 でアプリから消した名前は、同じ行で消したことを書く', () => {
    expect(describeStale(scan.removedNames)).toEqual([]);
  });

  describe('maestro の flow', () => {
    it('消した画面だけを前提にしていた flow と、中の flow をすべて消したディレクトリは無い (戻すなら画面と一緒に)', () => {
      const present = [...REMOVED_MAESTRO_FLOWS, ...REMOVED_MAESTRO_FLOW_DIRS].filter((rel) =>
        fs.existsSync(path.join(ROOT, MAESTRO_DIR, rel)),
      );
      expect(present).toEqual([]);
    });

    it('タブを順にたどる flow がタップするタブの名前は、いまのタブ ((tabs)/_layout.tsx の title) にある', () => {
      const titles = [...fs.readFileSync(path.join(ROOT, TABS_LAYOUT), 'utf8').matchAll(/title: "([^"]+)"/g)].map(
        (match) => match[1],
      );
      const tapped = [...fs.readFileSync(path.join(ROOT, TAB_WALK_FLOW), 'utf8').matchAll(/^- tapOn: "([^"]+)"$/gm)].map(
        (match) => match[1],
      );
      // 空振りしていない: タブの名前と、flow のタップを読めている
      expect(titles).toContain('ホーム');
      expect(tapped).toContain('献立');
      expect(tapped.filter((label) => !titles.includes(label))).toEqual([]);
    });
  });

  describe('走査が空振りしていない', () => {
    it('見るファイルに、ソース・テスト・文書・maestro の flow が入っている', () => {
      expect(scan.files).toEqual(
        expect.arrayContaining([
          'src/lib/shopping-list-request-error.ts',
          'src/__tests__/config/status-color-tokens.test.ts',
          'tests/meal-type-visuals-1665.test.ts',
          'CLAUDE.md',
          `${MAESTRO_DIR}/home-navigation.yaml`,
        ]),
      );
    });

    it('消したことを書いた名指しの行を見つける (packages/shared/src/meal-types.ts の、消したモバイルの表の行)', () => {
      const found = scan.removedFiles.filter(
        (mention) => mention.file === 'packages/shared/src/meal-types.ts' && mention.target === 'apps/mobile/src/lib/meal-type-visuals.ts',
      );
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((mention) => mention.noted)).toBe(true);
    });

    it('「apps/mobile のファイル の 名前」の書き方を見つける (CLAUDE.md の menu-request-error.ts の行)', () => {
      expect(scan.exportMentions.find((entry) => entry.file === 'CLAUDE.md')?.count ?? 0).toBeGreaterThan(0);
    });
  });
});
