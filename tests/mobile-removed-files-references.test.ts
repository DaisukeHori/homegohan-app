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
 *   - apps/mobile/maestro/testdata/README.md: フィクスチャ画像の表が、消した flow を `flows/` を付けない短い書き方
 *     (`health/26-ocr-auto-fill.yaml`) で「用途フロー」として挙げていた
 * tests/docs-mobile-removed-references.test.ts は CLAUDE.md と README の「`…`」で囲んだ書き方だけを見るので、
 * 引用符で囲まないコードのコメントは見ていなかった。ここでは git で管理するテキストのファイルを全部見る。
 *   1. 消したファイル (tests/helpers/mobile-removed-1598.ts の画面・部品・関数・テスト・maestro の flow) を名指しする行
 *      (`apps/mobile/<パス>`。画面は `app/<パス>` も。部品・関数・テストは、apps/mobile の中のファイルでは `src/<パス>`・
 *      `__tests__/<パス>` も。maestro の flow は `maestro/` を省いた書き方と、消したディレクトリの flow の `flows/` を省いた書き方も)
 *      は、同じ行で消したことを書く (REMOVAL_NOTE)
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
 *   - 見張りのテスト 4 本 (#2164 で消したホームの hook の見張り tests/mobile-home-hook-removed-2157.test.ts を含む) と、消したものの一覧・設計書がまだ直していない名指しの一覧 2 つ (EXCLUDED_FILES): 捕まえることを確かめるために元の文を持つ・一覧そのもの
 * この検査の限界: パスも「ファイル の 名前」も書かずに、消した画面を言葉だけで「いまある」と書いた文
 * (「モバイルの管理画面が使う」など) は捕まえない。apps/mobile の外のファイルの `src/<パス>` は Web のパスと区別できないので、
 * 部品・関数・テストは `apps/mobile/<パス>` の書き方だけを見る。apps/mobile の中でも、リポジトリの根に同じパスがある
 * (Web に同じパスのファイルがある) `src/<パス>` は、Web を指すことがあるので数えない。
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
/**
 * 見ないファイル: 元の文をそのまま持つ見張りのテストと、消したものの一覧 (flow は名前だけでも名指しとして数えるので、一覧に当たる)。
 * tests/mobile-home-hook-removed-2157.test.ts は、#2164 で消したホームの hook のパスを「無いこと」を確かめる対象として持つ見張り。
 * 設計書がまだ直していない名指しの一覧 2 つも、設計書の名指しを写して数で持つので見ない (一覧の行は設計書の見張りが確かめる)
 */
const EXCLUDED_FILES = [
  'tests/mobile-removed-files-references.test.ts',
  'tests/docs-mobile-removed-references.test.ts',
  'tests/design-doc-removed-mobile-screens.test.ts',
  'tests/mobile-home-hook-removed-2157.test.ts',
  'tests/helpers/mobile-removed-1598.ts',
  'tests/helpers/design-doc-pending-notes-1598.ts',
  'tests/helpers/design-doc-pending-revisions-1598.ts',
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

/** 名指しの前に付かない文字 (英数字・`/`・`-`・`_`。付くものは別のディレクトリの下のパス。Web の `src/app/...` など) */
const NOT_PATH_BEFORE = '(?:^|[^\\w/-])';
/** maestro の flow を置く、maestro の下のディレクトリ */
const FLOWS_SUBDIR = 'flows/';
/** ディレクトリの下の flow のファイル (サブディレクトリの下も) */
const FLOW_FILE = '[\\w.-]+(?:/[\\w.-]+)*\\.ya?ml';
/** maestro の flow の名指しの頭 (`apps/mobile/maestro/` か `maestro/`。省いた書き方も拾う) */
const OPTIONAL_MAESTRO_PREFIX = `(?:(?:${escapeRegExp(MOBILE_DIR)}/)?maestro/)?`;
/** 中の flow をすべて消した、flows/ の下のディレクトリ (`flows/` を省いた `health/26-….yaml` の書き方も拾う) */
const REMOVED_FLOWS_SUBDIRS = REMOVED_MAESTRO_FLOW_DIRS.filter((dir) => dir.startsWith(FLOWS_SUBDIR)).map((dir) =>
  dir.slice(FLOWS_SUBDIR.length),
);
/**
 * 中の flow をすべて消した、maestro の直下のディレクトリ。flows/ の下に同じ名前のディレクトリ (flows/menus-weekly) が残るので、
 * `maestro/` を付けた書き方だけを拾う
 */
const REMOVED_ROOT_FLOW_DIRS = REMOVED_MAESTRO_FLOW_DIRS.filter((dir) => !dir.startsWith(FLOWS_SUBDIR));

const alternation = (items: readonly string[]): string => items.map(escapeRegExp).join('|');

/**
 * 消したファイルを名指しする書き方と、見つけた名指しをリポジトリの根からのパス (画面は `app/<パス>`) に直す方法。
 * どの書き方も、組 (括弧) を 1 つだけ持つ
 */
const REMOVED_FILE_MENTION_KINDS: readonly { pattern: string; target: (hit: string) => string }[] = [
  // 画面: `apps/mobile/app/<パス>` か `app/<パス>`
  {
    pattern: `${NOT_PATH_BEFORE}(?:${escapeRegExp(MOBILE_DIR)}/)?(app/(?:${alternation(REMOVED_MOBILE_SCREENS)}))${END_OF_PATH}`,
    target: (hit) => hit,
  },
  // 部品・関数・テスト: `apps/mobile/<パス>`
  {
    pattern: `${escapeRegExp(MOBILE_DIR)}/(${alternation(REMOVED_MOBILE_SOURCE_FILES)})${END_OF_PATH}`,
    target: (hit) => `${MOBILE_DIR}/${hit}`,
  },
  // maestro の直下の flow: `apps/mobile/maestro/<パス>`・`maestro/<パス>`・`<パス>`
  {
    pattern: `${NOT_PATH_BEFORE}${OPTIONAL_MAESTRO_PREFIX}(${alternation(REMOVED_MAESTRO_FLOWS)})${END_OF_PATH}`,
    target: (hit) => `${MAESTRO_DIR}/${hit}`,
  },
  // maestro の直下の、消したディレクトリの flow: `apps/mobile/maestro/<ディレクトリ>/<flow>`・`maestro/<ディレクトリ>/<flow>`
  {
    pattern: `${NOT_PATH_BEFORE}(?:${escapeRegExp(MOBILE_DIR)}/)?maestro/((?:${alternation(REMOVED_ROOT_FLOW_DIRS)})/${FLOW_FILE})${END_OF_PATH}`,
    target: (hit) => `${MAESTRO_DIR}/${hit}`,
  },
  // flows/ の下の、消したディレクトリの flow: `apps/mobile/maestro/flows/<ディレクトリ>/<flow>` から `<ディレクトリ>/<flow>` まで
  {
    pattern: `${NOT_PATH_BEFORE}${OPTIONAL_MAESTRO_PREFIX}(?:${escapeRegExp(FLOWS_SUBDIR)})?((?:${alternation(REMOVED_FLOWS_SUBDIRS)})/${FLOW_FILE})${END_OF_PATH}`,
    target: (hit) => `${MAESTRO_DIR}/${FLOWS_SUBDIR}${hit}`,
  },
];

const REMOVED_FILE_MENTION = new RegExp(REMOVED_FILE_MENTION_KINDS.map((kind) => kind.pattern).join('|'), 'g');

/**
 * apps/mobile の中のファイルが、アプリの部品・関数・テストを `apps/mobile/` を付けずに書いた名指し (`src/<パス>`・`__tests__/<パス>`)。
 * リポジトリの根に同じパスがあるもの (Web の同じパスのファイル) は、Web を指すことがあるので数えない
 */
const REMOVED_SOURCE_SHORT_MENTION = new RegExp(
  `${NOT_PATH_BEFORE}(${alternation(REMOVED_MOBILE_SOURCE_FILES)})${END_OF_PATH}`,
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

/**
 * 名指しを探す前の、安い絞り込み。画面と部品は `app` を含む (`apps/mobile/` も `app` の後ろに `s/` が付くだけ)。
 * flow は `.yaml` か `.yml` を含む
 */
const MENTION_HINTS = ['app', '.yaml', '.yml'] as const;
/** apps/mobile の中の短い書き方の、安い絞り込み (どれも `src/` か `__tests__/` を含む) */
const SHORT_MENTION_HINTS = ['src/', '__tests__/'] as const;

/** 1 行の中で、消したファイルを名指ししているところ。file を渡すと、apps/mobile の中のファイルの短い書き方も見る */
function removedFilesInLine(text: string, file?: string): string[] {
  const found: string[] = [];
  if (MENTION_HINTS.some((hint) => text.includes(hint))) {
    for (const match of text.matchAll(REMOVED_FILE_MENTION)) {
      const index = REMOVED_FILE_MENTION_KINDS.findIndex((_, kind) => match[kind + 1] !== undefined);
      found.push(REMOVED_FILE_MENTION_KINDS[index].target(match[index + 1]));
    }
  }
  if (file?.startsWith(`${MOBILE_DIR}/`) && SHORT_MENTION_HINTS.some((hint) => text.includes(hint))) {
    for (const match of text.matchAll(REMOVED_SOURCE_SHORT_MENTION)) {
      if (!fs.existsSync(path.join(ROOT, match[1]))) found.push(`${MOBILE_DIR}/${match[1]}`);
    }
  }
  return found;
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
      for (const target of removedFilesInLine(text, file)) removedFiles.push({ file, line: index + 1, target, noted, text });
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
  testdataCheckupSheet:
    '| `checkup-sheet.jpg` | `health/26-ocr-auto-fill.yaml` | 健康診断結果票。血圧・HbA1c・体重・BMI が記載されているもの。文字が鮮明であること。推奨解像度: 1240x1754px (A4相当) 以上。 |',
  testdataAiAttachPhoto:
    '| `ai-attach-photo.jpg` | `ai/25-image-attach-respond.yaml` | AIチャットに添付する食事写真。料理が明確に写っていること。推奨解像度: 1080x1080px 以上。 |',
  userStorageShort:
    '  //   - singleMealGenerating: 1 食の作り直しの生成中の状態。前の利用者の食事の ID が入る (src/components/menu/RegenerateMealModal.tsx が書く)',
} as const;

/** 短い書き方の src/ を、アプリのファイルとして読むファイル (apps/mobile の中) */
const MOBILE_SOURCE_FILE = `${MOBILE_DIR}/src/lib/user-storage.ts`;
/** 消したことを書いた、短い書き方の flow の名指しがある文書 (走査が空振りしていないことの確かめ用) */
const TESTDATA_README = `${MAESTRO_DIR}/testdata/README.md`;

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

    it('消したファイルの名指し: flow の短い書き方 (flows/・maestro/ を省いたもの) と、apps/mobile の中の src/ の書き方を捕まえる', () => {
      expect(removedFilesInLine(FORMER_TEXTS.testdataCheckupSheet)).toEqual([
        'apps/mobile/maestro/flows/health/26-ocr-auto-fill.yaml',
      ]);
      expect(removedFilesInLine(FORMER_TEXTS.testdataAiAttachPhoto)).toEqual([
        'apps/mobile/maestro/flows/ai/25-image-attach-respond.yaml',
      ]);
      expect(removedFilesInLine('maestro test flows/pantry/01-add.yaml')).toEqual(['apps/mobile/maestro/flows/pantry/01-add.yaml']);
      expect(removedFilesInLine('手順は `pantry-flow.yaml` を見る')).toEqual(['apps/mobile/maestro/pantry-flow.yaml']);
      expect(removedFilesInLine('maestro test maestro/menus-weekly/05-other.yaml')).toEqual([
        'apps/mobile/maestro/menus-weekly/05-other.yaml',
      ]);
      expect(removedFilesInLine(FORMER_TEXTS.userStorageShort, MOBILE_SOURCE_FILE)).toEqual([
        'apps/mobile/src/components/menu/RegenerateMealModal.tsx',
      ]);
    });

    it('消したファイルの名指し: Web の src/app/・いまあるファイル・名前の頭が同じ別のファイルは捕まえない', () => {
      expect(removedFilesInLine('| `src/app/(main)/health/checkups/[id]/page.tsx` |')).toEqual([]);
      expect(removedFilesInLine('// src/app/meals/new.tsx')).toEqual([]);
      expect(removedFilesInLine('apps/mobile/src/lib/menu-request-error.ts の menuRequestErrorMessageForDisplay')).toEqual([]);
      expect(removedFilesInLine('apps/mobile/src/lib/storage.tsx')).toEqual([]);
      expect(removedFilesInLine('apps/mobile/maestro/smoke.yaml')).toEqual([]);
    });

    it('消したファイルの名指し: 残した flow・別のディレクトリの下のパス・apps/mobile の外や Web の src/ は捕まえない', () => {
      // flows/ の下の menus-weekly は残した (消したのは maestro の直下の menus-weekly)
      expect(removedFilesInLine('apps/mobile/maestro/flows/menus-weekly/03-tab-direct-navigation.yaml')).toEqual([]);
      // maestro/ を付けない直下のディレクトリの書き方は、flows/menus-weekly と区別できないので数えない
      expect(removedFilesInLine('`menus-weekly/03-tab-direct-navigation.yaml`')).toEqual([]);
      expect(removedFilesInLine('apps/mobile/maestro/flows/home/01-all-sections-display.yaml')).toEqual([]);
      expect(removedFilesInLine('.github/workflows/health/check.yaml')).toEqual([]);
      // apps/mobile の外のファイルの src/ は Web のパス
      expect(removedFilesInLine(FORMER_TEXTS.userStorageShort)).toEqual([]);
      expect(removedFilesInLine(FORMER_TEXTS.userStorageShort, 'src/lib/user-storage.ts')).toEqual([]);
      // apps/mobile の中でも、リポジトリの根に同じパスがある src/ は Web を指すことがある
      expect(removedFilesInLine('// Web の src/lib/meal-type-visuals.ts と同じ表', MOBILE_SOURCE_FILE)).toEqual([]);
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
          TESTDATA_README,
          MOBILE_SOURCE_FILE,
        ]),
      );
    });

    it('消したことを書いた、短い書き方の名指しの行を見つける (testdata/README.md の flow・user-storage.ts の src/)', () => {
      const testdata = scan.removedFiles.filter(
        (mention) => mention.file === TESTDATA_README && mention.target === 'apps/mobile/maestro/flows/health/26-ocr-auto-fill.yaml',
      );
      const userStorage = scan.removedFiles.filter(
        (mention) =>
          mention.file === MOBILE_SOURCE_FILE && mention.target === 'apps/mobile/src/components/menu/RegenerateMealModal.tsx',
      );
      expect(testdata.length).toBeGreaterThan(0);
      expect(userStorage.length).toBeGreaterThan(0);
      expect([...testdata, ...userStorage].every((mention) => mention.noted)).toBe(true);
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
