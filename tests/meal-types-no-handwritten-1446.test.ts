/**
 * #1446 / #1631 の回帰テスト: 食事の区分 (5 値) を手書きせず、@homegohan/shared の MealType / MEAL_ORDER / isMealType
 * から導き、any へのキャストで型を外さない。
 * (このファイル自身が差分の any キャストの grep の数に入らないよう、キャストの語は分けて組み立てる)
 *
 * - #1446: 献立画面 (Web・モバイル) と食事を追加するモーダル
 * - #1631: 献立生成の API (v4・v5) の受け付ける区分、AI 相談の許可リスト、planned_meals の許可リスト、食事の画面・モーダル・
 *   並べ替えの API の手書きの MealType、types/domain の MealType、食事の記録の画面の「おやつ・夜食」の手書き
 *
 * 型 (tsc) は「手書きの 5 値が正本と同じ値か」までは見ないので、ソースを読んで手書きとキャストが戻っていないことを固定する。
 * コメントの中の語で誤って赤にしないよう、コメントを除いてから検査する。
 * あわせて、製品のソース全体を走査し、5 値の手書きがあるのは除外表 (理由つき) のファイルだけであることを確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEAL_ORDER } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');

/** 食事の区分を正本から導くことにしたファイル (#1446・#1631 の対象) */
const TARGET_FILES = [
  // #1446
  'apps/mobile/app/menus/weekly/index.tsx',
  'src/app/(main)/menus/weekly/page.tsx',
  'src/app/(main)/menus/weekly/_components/modals/AddMealSlotModal.tsx',
  // #1631
  'apps/mobile/app/meals/new.tsx',
  'lib/slot-builder.ts',
  'src/app/(main)/home/page.tsx',
  'src/app/(main)/meals/new/page.tsx',
  'src/app/(main)/menus/weekly/_components/modals/AddMealModal.tsx',
  'src/app/(main)/menus/weekly/_components/modals/ImproveMealModal.tsx',
  'src/app/(main)/menus/weekly/_components/modals/RegenerateMealModal.tsx',
  'src/app/api/ai/menu/v4/generate/route.ts',
  'src/app/api/ai/menu/v5/generate/route.ts',
  'src/app/api/meal-plans/meals/reorder/route.ts',
  'src/lib/ai/consultation-action-executor.ts',
  'src/lib/planned-meal-validation.ts',
  'types/domain.ts',
];

/**
 * any へのキャストの検査から外すファイルと理由。
 * 食事の区分の手書きの検査 (5 値・MealType の型・おやつと夜食の並び) は外さない。
 */
const CAST_CHECK_EXCLUDED: Record<string, string> = {
  'apps/mobile/app/meals/new.tsx':
    '#1631 より前からある画像の選択 (mediaTypes) と Text / Pressable の ref の any キャスト。食事の区分とは関係しない',
};

/** Edge Functions を除外表に入れる理由 */
const DENO_CANNOT_IMPORT_SHARED =
  'Edge Functions (Deno) は packages/shared (@homegohan/shared) を import できない (Node の workspace の外で動く)';

/**
 * 製品のソースのうち、5 値の手書きを残してよいファイルと理由 (除外表)。
 * ここに無いファイルに 5 値の手書きが現れたら赤にする。
 */
const HANDWRITTEN_ALLOWED: Record<string, string> = {
  'packages/shared/src/meal-types.ts': '食事の区分の正本 (MealType / MEAL_ORDER) そのもの',
  'supabase/functions/_shared/meal-generator.ts': DENO_CANNOT_IMPORT_SHARED,
  'supabase/functions/generate-menu-v4/index.ts': DENO_CANNOT_IMPORT_SHARED,
  'supabase/functions/generate-menu-v4/step-utils.ts': DENO_CANNOT_IMPORT_SHARED,
  'supabase/functions/generate-menu-v5/index.ts': DENO_CANNOT_IMPORT_SHARED,
  'supabase/functions/generate-menu-v5/template-catalog.ts': `${DENO_CANNOT_IMPORT_SHARED}。6 つ目の値 any (どの区分にも使えるひな形) を持つ別の型`,
};

/** 製品のソースとして走査するディレクトリ (テストは期待値として 5 値を書くので走査しない) */
const PRODUCT_SOURCE_DIRS = [
  'src',
  'lib',
  'types',
  'components',
  'shared',
  'apps/mobile/app',
  'apps/mobile/src',
  'packages',
  'supabase/functions',
  'scripts',
];

/** 走査するソースの拡張子 */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
/** 走査しないディレクトリの名前 */
const SKIPPED_DIR_NAMES = new Set(['node_modules', '__tests__', '__mocks__', '.next', 'dist', 'build']);
/** テストのファイル名 (期待値として 5 値を書くので走査しない) */
const TEST_FILE_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** 5 値を正本と同じ並びで手書きした配列 (引用符は ' と " のどちらも) */
const HANDWRITTEN_FIVE_VALUES =
  /['"]breakfast['"]\s*,\s*['"]lunch['"]\s*,\s*['"]dinner['"]\s*,\s*['"]snack['"]\s*,\s*['"]midnight_snack['"]/;
/** 基本の 3 食のほか (おやつ・夜食) を手書きした並び (#1631。正本 MEAL_ORDER から基本の 3 食を除いて作る) */
const HANDWRITTEN_EXTRA_PAIR = /['"]snack['"]\s*,\s*['"]midnight_snack['"]/;
/** 5 値を手書きした型の宣言 (type MealType = 'breakfast' | ...) */
const LOCAL_MEAL_TYPE_ALIAS = /\btype\s+MealType\s*=/;
/** 型を外す any へのキャストの語 (分けて書く理由は冒頭) */
const CAST_TO_ANY = ['as', 'any'].join(' ');
/** 型を外す any へのキャスト */
const AS_ANY = new RegExp(`\\b${CAST_TO_ANY.replace(' ', '\\s+')}\\b`);

/** 入れ子の無い [ ... ] (配列のリテラル・z.enum の引数) */
const ARRAY_LITERAL = /\[[^[\]]*\]/g;
/** 文字列のリテラルを | でつないだ並び (型の union) */
const STRING_LITERAL_UNION = /(?:['"][\w-]+['"]\s*\|\s*)+['"][\w-]+['"]/g;

/** 行コメントとブロックコメント (JSX の {/* *\/} を含む) を除く。文字列の中の // (URL) は残す */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function readStripped(relativePath: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

/** 断片が食事の区分の 5 値を引用符つきで全部含むか (並びは問わない) */
function containsAllFiveQuoted(fragment: string): boolean {
  return MEAL_ORDER.every((mealType) => new RegExp(`['"]${mealType}['"]`).test(fragment));
}

/** 5 値を手書きした配列か union があるか (並びは問わない) */
function hasHandwrittenFiveValues(strippedSource: string): boolean {
  const fragments = [
    ...(strippedSource.match(ARRAY_LITERAL) ?? []),
    ...(strippedSource.match(STRING_LITERAL_UNION) ?? []),
  ];
  return fragments.some(containsAllFiveQuoted);
}

/** 製品のソースのファイルを ROOT からの相対パスで集める */
function collectProductSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (relativeDir: string) => {
    const absoluteDir = path.join(ROOT, relativeDir);
    if (!fs.existsSync(absoluteDir)) return;
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR_NAMES.has(entry.name)) walk(relativePath);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !TEST_FILE_NAME.test(entry.name)) {
        files.push(relativePath);
      }
    }
  };
  PRODUCT_SOURCE_DIRS.forEach(walk);
  return files;
}

describe('#1446 / #1631 食事の区分は正本から導き、any へのキャストで型を外さない', () => {
  it.each(TARGET_FILES)('%s に 5 値の手書きの配列・union が無い', (file) => {
    const source = readStripped(file);
    expect(source).not.toMatch(HANDWRITTEN_FIVE_VALUES);
    expect(hasHandwrittenFiveValues(source)).toBe(false);
  });

  it.each(TARGET_FILES)('%s に MealType の手書きの型が無い', (file) => {
    expect(readStripped(file)).not.toMatch(LOCAL_MEAL_TYPE_ALIAS);
  });

  it.each(TARGET_FILES)('%s に「おやつ・夜食」の手書きの並びが無い', (file) => {
    expect(readStripped(file)).not.toMatch(HANDWRITTEN_EXTRA_PAIR);
  });

  it.each(TARGET_FILES.filter((file) => !(file in CAST_CHECK_EXCLUDED)))('%s に any へのキャストが無い', (file) => {
    expect(readStripped(file)).not.toMatch(AS_ANY);
  });

  it('対象と除外表のファイルはどれも実在する (改名・削除で検査が空振りしない)', () => {
    for (const file of [...TARGET_FILES, ...Object.keys(CAST_CHECK_EXCLUDED), ...Object.keys(HANDWRITTEN_ALLOWED)]) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it('製品のソースで 5 値を手書きしているのは除外表 (理由つき) のファイルだけ', () => {
    const files = collectProductSourceFiles();
    // 走査が空振りしていない (対象のファイルを実際に読んでいる)
    expect(files).toEqual(expect.arrayContaining(TARGET_FILES));
    const handwritten = files.filter((file) => hasHandwrittenFiveValues(readStripped(file)));
    expect(handwritten.filter((file) => !(file in HANDWRITTEN_ALLOWED)).sort()).toEqual([]);
    // 除外表は正本と Edge Functions の実際の手書きを指している (除外表の行が空振りしていない)
    expect(handwritten).toEqual(expect.arrayContaining(Object.keys(HANDWRITTEN_ALLOWED)));
  });

  it('検査の正規表現は、戻ってきた手書きとキャストを実際に拾う (検査が空振りしていない)', () => {
    expect(stripComments("const ALL: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];")).toMatch(
      HANDWRITTEN_FIVE_VALUES,
    );
    expect(stripComments("type MealType = 'breakfast' | 'lunch';")).toMatch(LOCAL_MEAL_TYPE_ALIAS);
    expect(stripComments(`MEAL_ORDER.indexOf(a.meal_type ${CAST_TO_ANY});`)).toMatch(AS_ANY);
    expect(stripComments(`// MEAL_ORDER.indexOf(a.meal_type ${CAST_TO_ANY});`)).not.toMatch(AS_ANY);
    expect(stripComments("{(['snack', 'midnight_snack'] as MealType[]).map((type) => {")).toMatch(HANDWRITTEN_EXTRA_PAIR);
    // 並びを変えた配列・z.enum・union も拾う
    expect(hasHandwrittenFiveValues("const A = ['lunch', 'breakfast', 'dinner', 'midnight_snack', 'snack'] as const;")).toBe(true);
    expect(hasHandwrittenFiveValues('z.enum(["breakfast", "lunch", "dinner", "snack", "midnight_snack"])')).toBe(true);
    expect(hasHandwrittenFiveValues("type M = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';")).toBe(true);
    expect(hasHandwrittenFiveValues('type M = "breakfast" | "lunch" | "dinner" | "snack" | "midnight_snack" | "any";')).toBe(true);
    // 5 値のうち一部だけの並び (基本の 3 食など) と、正本から導いた形は拾わない
    expect(hasHandwrittenFiveValues("const BASE: MealType[] = ['breakfast', 'lunch', 'dinner'];")).toBe(false);
    expect(hasHandwrittenFiveValues('const V: readonly MealType[] = MEAL_ORDER;')).toBe(false);
  });
});
