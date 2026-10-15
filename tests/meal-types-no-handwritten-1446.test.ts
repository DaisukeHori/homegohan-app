/**
 * #1446 / #1631 の回帰テスト: 食事の区分 (5 値) の値の集合と並びを手書きせず、@homegohan/shared の MealType / MEAL_ORDER /
 * isMealType から導き、any へのキャストで型を外さない。
 * (このファイル自身が差分の any キャストの grep の数に入らないよう、キャストの語は分けて組み立てる)
 *
 * - #1446: 献立画面 (Web・モバイル) と食事を追加するモーダル
 * - #1631: 献立生成の API (v4・v5) の受け付ける区分、AI 相談の許可リスト、planned_meals の許可リスト、食事の画面・モーダル・
 *   並べ替えの API の手書きの MealType、types/domain の MealType、食事の記録の画面の「おやつ・夜食」の手書き、
 *   AI 相談のシステムプロンプトの区分の表示名と並びの手書きの表 (MEAL_LABELS / MEAL_ORDER から引く)、
 *   写真の判別 (classify-photo) の解析プロンプトの区分の表示名と、モバイルの週間献立のカードの短い名前の、5 値との比較の連鎖、
 *   並べ替えの API の使われていない「おやつ以外の 4 値」の並び (正本から 1 つ除いた並びの手書き)
 *
 * ■ 見張りの契約 (#1631)
 * この番兵は、下の「捕まえる書き方」だけを見張る。書き方を 1 つずつ足して追いかける形はとらない。
 * 「捕まえない書き方 (限界)」に当たる手書きを見落としても、この番兵の欠陥としては扱わない (見つけたら製品側を直すか、別の Issue にする)。
 * 検査はコメントを除いてから行う (コメントの中の語で誤って赤にしない)。テストのファイルは期待値として 5 値を書くので走査しない。
 *
 * 捕まえる書き方 (TARGET_FILES の各ファイル。☆ は製品のソース全体の走査でも、除外表 (理由つき) の外なら赤):
 *   1. ☆ 5 値すべてを引用符つきで並べた配列・z.enum の引数 (並びは問わない)
 *   2. ☆ 5 値すべてを引用符つきで | でつないだ型の union
 *   3. ☆ 5 値すべてと 1 つずつ比べる形 (=== / !== / == / != の左右どちらか、または case 'v':) が、ファイルのどこかに 5 値ぶんそろっている
 *   4. 手書きの型の宣言 type MealType = …
 *   5. おやつ・夜食の並び ('snack', 'midnight_snack') の手書き
 *   6. 正本から 1 つだけ除いた 4 値を引用符つきで並べた配列
 *   7. any へのキャスト (CAST_CHECK_EXCLUDED のファイルを除く)
 *   8. ☆ 5 値をキーに持つ表 (オブジェクトのリテラル) を Record<string, …> の型で宣言したもの
 *      (Record<string, …> は MealType に値が増えても tsc が漏れを止めない。製品のソースでは Record<MealType, …> にする)
 *   9. NO_FIVE_KEY_TABLE_FILES のファイルでは、5 値をキーに持つ表そのもの (表示名は MEAL_LABELS、並びは MEAL_ORDER から引く)
 *
 * 捕まえない書き方 (限界):
 *   a. 5 値のうち一部 (4 値以下) との比較 + 既定の値 (else) で残りを表す連鎖。例: (#1665 より前の) Web の『食事を追加』モーダルの
 *      背景色と絵文字 (区分ごとの見た目の対応表。値の集合の正本の問題ではなく表示の表の置き場の問題なので、#1631 の範囲外とした)。
 *      区分の見た目の対応表は、このファイルの末尾の #1665 の番兵 (下の「#1665 の見張りの契約」) が見張る
 *   b. 部分集合 (基本の 3 食など 3 値以下) の配列・union・比較。例: BASE_MEAL_TYPES、時刻で区分の並びを選ぶ 3 値の配列
 *   c. 4 値の union・4 値との比較 (4 値は配列だけを見る)
 *   d. 値を返すだけの分岐 (時刻から区分を選ぶ return 'breakfast' など。戻り値の MealType 型を tsc が確かめる)
 *   e. Record<MealType, …> の表 (値の網羅は tsc が止める。表示名の文字列が MEAL_LABELS と重なることは見ない)
 *   f. 引用符の無い値 (テンプレートリテラル・変数や定数を介した値・文字列の連結で作った値)
 *   g. 比較が 1 つの連鎖になっているかは見ない (ファイルの中に散らばった 5 値ぶんの比較でも 3 として拾う)
 *   h. HANDWRITTEN_ALLOWED / STRING_KEYED_TABLE_ALLOWED の除外表のファイル (正本そのものと、shared を import できない Edge Functions)
 *   i. PRODUCT_SOURCE_DIRS の外のファイル・SOURCE_EXTENSIONS の外の拡張子
 *
 * 型 (tsc) は「手書きの 5 値が正本と同じ値か」までは見ないので、ソースを読んで手書きとキャストが戻っていないことを固定する。
 * 正本から導いた値そのもの (並び・表示名・受け付ける値) は、それぞれの挙動のテストが固定する。
 *
 * ■ #1665 の見張りの契約 (食事の区分ごとの見た目の対応表)
 * 区分ごとの色・下地の色・絵文字・アイコン・表示名は、表 (Record<MealType, …>) 1 か所から引く:
 *   - Web とモバイルで同じ値: packages/shared/src/meal-types.ts (MEAL_LABELS・MEAL_EMOJIS)
 *   - Web: src/lib/meal-type-visuals.ts (モバイルの表 apps/mobile/src/lib/meal-type-visuals.ts は、使っていたネイティブの画面と一緒に消した。#1598)
 * 表の値そのもの (今の画面の色・絵文字) は tests/meal-type-visuals-1665.test.ts が固定する。
 * この番兵は、表の外に区分ごとの見た目の対応が新しく増えないことを、次の「捕まえる書き方」で見張る
 * (PRODUCT_SOURCE_DIRS から VISUAL_SCAN_EXCLUDED_DIRS を除いた製品のソース。除外表 (理由つき) のファイルは見ない):
 *   V1. 区分の値と == / === で比べた結果で値を選ぶ形が、ファイルの中で 2 つ以上の区分ぶんある
 *       (三項演算子 x === 'v' ? … / 'v' === x ? …、switch の case 'v':、if (… === 'v') return …)。
 *       5 値そろわない連鎖 (一部の区分 + 既定の値) も拾う (#1631 の番兵の限界 a を埋める)
 *   V2. 5 値をキーに持つ表 (オブジェクトのリテラル。Record<MealType, …> も含む) が、見た目の表のファイル・除外表の外にある
 *   V3. 区分の値を引用符つきで持つ項目と、見た目の項目 (label / shortLabel / icon / Icon / emoji / color / bg / background) を
 *       同じ 1 つのオブジェクトのリテラルに並べた形 ({ type: 'breakfast', label: '朝食', icon: '🌅' } のような選択肢の一覧)
 * 捕まえない書き方 (限界。見落としても番兵の欠陥としては扱わない):
 *   v-a. 1 つの区分だけとの比較 (const isSnack = t === 'snack' など。片方の区分だけ特別に扱う判定は見た目の表ではない)
 *   v-b. != / !== での比較 (if (t !== 'breakfast' && …) return null のような絞り込み)・includes() での判定
 *   v-c. 引用符の無い値 (定数・変数・テンプレートリテラルを介した比較や項目)
 *   v-d. 5 値そろわない表 (3 食だけの表など)。V3 の形に当たらない 3 値以下の表は見ない (型の網羅は tsc が止めない)
 *   v-e. 入れ子の { } を含むオブジェクトの V3 (1 つのオブジェクトのリテラルの中に { } があると見ない)
 *   v-f. VISUAL_SCAN_EXCLUDED_DIRS (Edge Functions (supabase/functions)・scripts。見た目を持たない) と、除外表のファイル
 *   v-g. 比べた結果で値を選ぶのが、三項演算子・case・if (…) return の 3 つ以外の形 (&& / || での選び方、if の中の代入など)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEAL_ORDER } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');

/** 食事の区分を正本から導くことにしたファイル (#1446・#1631 の対象) */
const TARGET_FILES = [
  // #1446
  // (モバイルの週の献立の画面 apps/mobile/app/menus/weekly/index.tsx も対象だったが、通常の操作で届かない画面として消した。#1598)
  'src/app/(main)/menus/weekly/page.tsx',
  'src/app/(main)/menus/weekly/_components/modals/AddMealSlotModal.tsx',
  // #1631
  // (モバイルの食事の新規作成の画面 apps/mobile/app/meals/new.tsx も対象だったが、スキャンのタブが WebView になって
  //  通常の操作で届かない画面だったので、画面ごと消した。#1598。食事の記録は Web の src/app/(main)/meals/new/page.tsx が受け持つ)
  'lib/slot-builder.ts',
  'src/app/(main)/home/page.tsx',
  'src/app/(main)/meals/new/page.tsx',
  'src/app/(main)/menus/weekly/_components/modals/AddMealModal.tsx',
  'src/app/(main)/menus/weekly/_components/modals/ImproveMealModal.tsx',
  'src/app/(main)/menus/weekly/_components/modals/RegenerateMealModal.tsx',
  'src/app/api/ai/menu/v4/generate/route.ts',
  'src/app/api/ai/menu/v5/generate/route.ts',
  'src/app/api/meal-plans/meals/reorder/route.ts',
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts',
  // (モバイルの食事の詳細の画面 apps/mobile/app/meals/[id].tsx も対象だったが、通常の操作で届かない画面として消した。#1598)
  'src/lib/ai/consultation-action-executor.ts',
  'src/lib/planned-meal-validation.ts',
  'types/domain.ts',
  'src/app/api/ai/classify-photo/route.ts',
];

/**
 * any へのキャストの検査から外すファイルと理由。
 * 食事の区分の手書きの検査 (5 値・MealType の型・おやつと夜食の並び) は外さない。
 */
const CAST_CHECK_EXCLUDED: Record<string, string> = {
  // (apps/mobile/app/meals/new.tsx・apps/mobile/app/meals/[id].tsx の行は、画面ごと消したので除いた。#1598)
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts':
    '#1631 より前からある LLM の呼び出しの引数 (chat.completions.create に渡す本文) の any キャスト。食事の区分とは関係しない',
};

/**
 * 5 値の表をそもそも持たないファイル (表示名は MEAL_LABELS、並びは MEAL_ORDER から引く)。
 * Record<MealType, …> の表であっても、ここでは手書きの表が戻ったら赤にする。
 */
const NO_FIVE_KEY_TABLE_FILES = [
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts',
  'src/app/api/ai/classify-photo/route.ts',
];

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
  'supabase/functions/_shared/nutrition-pipeline.ts': `${DENO_CANNOT_IMPORT_SHARED}。区分の表示名を 5 値との比較の連鎖で持つ`,
};

/**
 * 製品のソースのうち、5 値をキーに持つ表を Record<string, …> の型で残してよいファイルと理由 (除外表)。
 * ここに無いファイルに Record<string, …> の 5 値の表が現れたら赤にする。
 */
const STRING_KEYED_TABLE_ALLOWED: Record<string, string> = {
  'supabase/functions/_shared/save-meal.ts': DENO_CANNOT_IMPORT_SHARED,
  'supabase/functions/generate-menu-v5/diversity-scheduler.ts': DENO_CANNOT_IMPORT_SHARED,
  'supabase/functions/generate-menu-v5/diversity-validator.ts': DENO_CANNOT_IMPORT_SHARED,
  'supabase/functions/generate-menu-v5/template-catalog.ts': DENO_CANNOT_IMPORT_SHARED,
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

/** 比較の演算子 (=== / !== / == / !=) */
const EQUALITY_OPERATOR = String.raw`(?:===|!==|==|!=)`;

/** 入れ子の無い [ ... ] (配列のリテラル・z.enum の引数) */
const ARRAY_LITERAL = /\[[^[\]]*\]/g;
/** 文字列のリテラルを | でつないだ並び (型の union) */
const STRING_LITERAL_UNION = /(?:['"][\w-]+['"]\s*\|\s*)+['"][\w-]+['"]/g;

/** 5 値のうち最後の値をキーにした行 (5 値の表を探す手がかり。キーは引用符つきでもよい) */
const LAST_MEAL_TYPE_KEY = /(^|[\s,{])['"]?midnight_snack['"]?\s*:/g;
/** 表を宣言する変数の型が Record<string, …> か (const X: Record<string, …> = {) */
const STRING_KEYED_RECORD_DECLARATION = /\b(?:const|let|var)\s+\w+\s*:\s*Record<\s*string\s*,[\s\S]*=\s*$/;
/** 宣言を探すときに、表の { の前を見る長さ (型の注釈が複数行にわたっても収まる長さ) */
const DECLARATION_LOOKBEHIND_CHARS = 400;

/** 5 値をキーに持つ表 (オブジェクトのリテラル) の { の位置と、その手前の宣言 */
type FiveKeyTable = { openBraceIndex: number; declaration: string };

/** index の位置を囲む { の位置 (見つからなければ -1) */
function findEnclosingOpenBrace(source: string, index: number): number {
  let depth = 0;
  for (let i = index; i >= 0; i -= 1) {
    if (source[i] === '}') depth += 1;
    else if (source[i] === '{') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** openBraceIndex の { に対応する } までの中身から、入れ子の { … } を除いた部分 (表のいちばん外側のキーだけ残す) */
function topLevelBody(source: string, openBraceIndex: number): string {
  let depth = 0;
  let body = '';
  for (let i = openBraceIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      if (depth === 0) return body;
      depth -= 1;
    } else if (depth === 0) body += ch;
  }
  return body;
}

/** 5 値をすべてキーに持つ表を探す */
function findFiveKeyTables(strippedSource: string): FiveKeyTable[] {
  const tables: FiveKeyTable[] = [];
  const seen = new Set<number>();
  for (const match of strippedSource.matchAll(LAST_MEAL_TYPE_KEY)) {
    const openBraceIndex = findEnclosingOpenBrace(strippedSource, match.index ?? 0);
    if (openBraceIndex < 0 || seen.has(openBraceIndex)) continue;
    seen.add(openBraceIndex);
    const body = topLevelBody(strippedSource, openBraceIndex);
    const hasAllFiveKeys = MEAL_ORDER.every((mealType) =>
      new RegExp(`(^|[\\s,])['"]?${mealType}['"]?\\s*:`).test(body),
    );
    if (!hasAllFiveKeys) continue;
    const before = strippedSource.slice(Math.max(0, openBraceIndex - DECLARATION_LOOKBEHIND_CHARS), openBraceIndex);
    const declarationStarts = [...before.matchAll(/\b(?:const|let|var)\s/g)];
    const lastStart = declarationStarts.at(-1)?.index;
    tables.push({ openBraceIndex, declaration: lastStart === undefined ? '' : before.slice(lastStart) });
  }
  return tables;
}

/** 5 値の表のうち、型が Record<string, …> のものがあるか */
function hasStringKeyedFiveKeyTable(strippedSource: string): boolean {
  return findFiveKeyTables(strippedSource).some((table) => STRING_KEYED_RECORD_DECLARATION.test(table.declaration));
}

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

/** その値を引用符つきで比べる形 (x === 'v' / 'v' === x / case 'v':) があるか */
function comparesWith(strippedSource: string, mealType: string): boolean {
  const quoted = String.raw`['"]${mealType}['"]`;
  return new RegExp(
    String.raw`${EQUALITY_OPERATOR}\s*${quoted}|${quoted}\s*${EQUALITY_OPERATOR}|\bcase\s+${quoted}\s*:`,
  ).test(strippedSource);
}

/** 5 値すべてと 1 つずつ比べる形 (三項演算子・if・switch の連鎖) があるか */
function hasFiveWayComparison(strippedSource: string): boolean {
  return MEAL_ORDER.every((mealType) => comparesWith(strippedSource, mealType));
}

/** 5 値のうち、引用符つきで含む値の数 */
function countQuotedMealTypes(fragment: string): number {
  return MEAL_ORDER.filter((mealType) => new RegExp(`['"]${mealType}['"]`).test(fragment)).length;
}

/** 正本から 1 つだけ除いた 4 値を手書きした配列があるか (おやつ以外の 4 値など。基本の 3 食の並びは拾わない) */
function hasHandwrittenAllButOneArray(strippedSource: string): boolean {
  return (strippedSource.match(ARRAY_LITERAL) ?? []).some(
    (fragment) => countQuotedMealTypes(fragment) === MEAL_ORDER.length - 1,
  );
}

/** 5 値を手書きした配列・union・比較の連鎖があるか (並びは問わない) */
function hasHandwrittenFiveValues(strippedSource: string): boolean {
  const fragments = [
    ...(strippedSource.match(ARRAY_LITERAL) ?? []),
    ...(strippedSource.match(STRING_LITERAL_UNION) ?? []),
  ];
  return fragments.some(containsAllFiveQuoted) || hasFiveWayComparison(strippedSource);
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
  it.each(TARGET_FILES)('%s に 5 値の手書きの配列・union・比較の連鎖が無い', (file) => {
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

  it.each(TARGET_FILES)('%s に正本から 1 つ除いた 4 値の手書きの配列が無い', (file) => {
    expect(hasHandwrittenAllButOneArray(readStripped(file))).toBe(false);
  });

  it.each(NO_FIVE_KEY_TABLE_FILES)('%s に 5 値をキーに持つ手書きの表 (表示名・並び) が無い', (file) => {
    expect(findFiveKeyTables(readStripped(file))).toEqual([]);
  });

  it.each(TARGET_FILES.filter((file) => !(file in CAST_CHECK_EXCLUDED)))('%s に any へのキャストが無い', (file) => {
    expect(readStripped(file)).not.toMatch(AS_ANY);
  });

  it('対象と除外表のファイルはどれも実在する (改名・削除で検査が空振りしない)', () => {
    for (const file of [
      ...TARGET_FILES,
      ...NO_FIVE_KEY_TABLE_FILES,
      ...Object.keys(CAST_CHECK_EXCLUDED),
      ...Object.keys(HANDWRITTEN_ALLOWED),
      ...Object.keys(STRING_KEYED_TABLE_ALLOWED),
    ]) {
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

  it('製品のソースで 5 値の表を Record<string, …> の型で持つのは除外表 (理由つき) のファイルだけ', () => {
    const files = collectProductSourceFiles();
    const stringKeyed = files.filter((file) => hasStringKeyedFiveKeyTable(readStripped(file)));
    expect(stringKeyed.filter((file) => !(file in STRING_KEYED_TABLE_ALLOWED)).sort()).toEqual([]);
    // 除外表は Edge Functions の実際の表を指している (除外表の行が空振りしていない)
    expect(stringKeyed).toEqual(expect.arrayContaining(Object.keys(STRING_KEYED_TABLE_ALLOWED)));
  });

  it('5 値の表の検査は、戻ってきた手書きの表を実際に拾う (検査が空振りしていない)', () => {
    // #1631 の R1 で見つかった AI 相談の表示名と並びの表 (Record<string, …>)
    const labels = `const mealTypeLabels: Record<string, string> = {
      breakfast: '朝食',
      lunch: '昼食',
      dinner: '夕食',
      snack: 'おやつ',
      midnight_snack: '夜食',
    };`;
    const order = 'const mealTypeOrder: Record<string, number> = { breakfast: 1, lunch: 2, dinner: 3, snack: 4, midnight_snack: 5 };';
    expect(findFiveKeyTables(stripComments(labels))).toHaveLength(1);
    expect(hasStringKeyedFiveKeyTable(stripComments(labels))).toBe(true);
    expect(hasStringKeyedFiveKeyTable(stripComments(order))).toBe(true);
    // 値が入れ子のオブジェクトで、型の注釈が { …; … } を含む表も拾う
    const config = `const MEAL_CONFIG: Record<string, { icon: string; label: string }> = {
      breakfast: { icon: 'sun', label: '朝食' },
      lunch: { icon: 'sun', label: '昼食' },
      snack: { icon: 'cafe', label: 'おやつ' },
      dinner: { icon: 'moon', label: '夕食' },
      'midnight_snack': { icon: 'moon', label: '夜食' },
    };`;
    expect(hasStringKeyedFiveKeyTable(stripComments(config))).toBe(true);
    // Record<MealType, …> の表は 5 値の表としては拾うが、Record<string, …> としては拾わない
    const typed = config.replace('Record<string,', 'Record<MealType,');
    expect(findFiveKeyTables(stripComments(typed))).toHaveLength(1);
    expect(hasStringKeyedFiveKeyTable(stripComments(typed))).toBe(false);
    // 5 値がそろっていない表 (夜食だけ等) と、正本から引く形は拾わない
    expect(findFiveKeyTables("const X: Record<string, number> = { snack: 4, midnight_snack: 5 };")).toEqual([]);
    expect(findFiveKeyTables('const label = isMealType(t) ? MEAL_LABELS[t] : t;')).toEqual([]);
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

  it('比較の連鎖の検査は、戻ってきた 5 値との比較を実際に拾う (検査が空振りしていない)', () => {
    // #1631 の R2 で見つかった写真の判別の解析プロンプトの表示名 (三項演算子の連鎖)
    const ternary = `const mealTypeLabel = mealType === 'breakfast' ? '朝食'
      : mealType === 'lunch' ? '昼食'
      : mealType === 'dinner' ? '夕食'
      : mealType === 'snack' ? 'おやつ'
      : mealType === 'midnight_snack' ? '夜食'
      : '食事';`;
    expect(hasFiveWayComparison(stripComments(ternary))).toBe(true);
    expect(hasHandwrittenFiveValues(stripComments(ternary))).toBe(true);
    // モバイルの週間献立のカードの短い名前 (二重引用符の連鎖)
    const mobileShort = `const short =
      mealType === "breakfast" ? "朝" :
      mealType === "lunch" ? "昼" :
      mealType === "dinner" ? "夕" :
      mealType === "snack" ? "おやつ" :
      mealType === "midnight_snack" ? "夜食" : base;`;
    expect(hasHandwrittenFiveValues(stripComments(mobileShort))).toBe(true);
    // 左右を入れ替えた比較・!==・switch の case も拾う
    expect(
      hasFiveWayComparison(
        "if ('breakfast' === t) a(); if (t !== 'lunch') b(); if (t == \"dinner\") c(); if (t != 'snack') d(); if ('midnight_snack' === t) e();",
      ),
    ).toBe(true);
    const switchCases = `switch (t) {
      case 'breakfast': return 1;
      case 'lunch': return 2;
      case 'dinner': return 3;
      case 'snack': return 4;
      case "midnight_snack": return 5;
    }`;
    expect(hasFiveWayComparison(stripComments(switchCases))).toBe(true);
    // 5 値のうち一部だけとの比較 (基本の 3 食など。4 値 + 既定の値の連鎖も含む = 冒頭の契約の限界 a・c)・コメントの中の連鎖・
    // 正本から引く形は拾わない
    const partial = "if (t === 'breakfast') a(); if (t === 'lunch') b(); if (t === 'dinner') c(); if (t === 'snack') d();";
    expect(hasFiveWayComparison(partial)).toBe(false);
    expect(hasFiveWayComparison(stripComments(`// ${ternary.replace(/\n/g, ' ')}`))).toBe(false);
    expect(
      hasHandwrittenFiveValues("const label = mealType !== undefined && isMealType(mealType) ? MEAL_LABELS[mealType] : '食事';"),
    ).toBe(false);
    // 値を返すだけの分岐 (時刻から区分を選ぶ return 'breakfast' など) は比較ではないので拾わない
    const returnsOnly = "if (h < 10) return 'breakfast'; if (h < 14) return 'lunch'; if (h < 17) return 'snack'; if (h < 21) return 'dinner'; return 'midnight_snack';";
    expect(hasFiveWayComparison(returnsOnly)).toBe(false);
  });

  it('4 値の配列の検査は、正本から 1 つ除いた手書きの並びを実際に拾う (検査が空振りしていない)', () => {
    // #1631 の R2 の掃除で消した、並べ替えの API の使われていない「おやつ以外の 4 値」の並び
    expect(
      hasHandwrittenAllButOneArray(
        stripComments("const BASE_MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'midnight_snack'];"),
      ),
    ).toBe(true);
    // 基本の 3 食の並び・正本から導いた形・コメントの中の並びは拾わない (5 値の配列はほかの検査が拾う)
    expect(hasHandwrittenAllButOneArray("const BASE: MealType[] = ['breakfast', 'lunch', 'dinner'];")).toBe(false);
    expect(hasHandwrittenAllButOneArray('const V = MEAL_ORDER.filter((t) => t !== SNACK);')).toBe(false);
    expect(
      hasHandwrittenAllButOneArray(stripComments("// ['breakfast', 'lunch', 'dinner', 'midnight_snack']")),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────
// #1665: 食事の区分ごとの見た目の対応表は、表 1 か所 (Record<MealType, …>) から引く (契約は冒頭の「#1665 の見張りの契約」)
// ─────────────────────────────────────────────

/** 区分ごとの見た目の表を置くファイル (V2 の 5 値の表を持ってよい) */
const MEAL_TYPE_VISUAL_TABLE_FILES: Record<string, string> = {
  'packages/shared/src/meal-types.ts': 'Web とモバイルで同じ値の見た目 (MEAL_LABELS・MEAL_EMOJIS) の表',
  'src/lib/meal-type-visuals.ts': 'Web の区分の見た目 (色・下地の色・アイコンの部品) の表',
  // (モバイルの見た目の表 apps/mobile/src/lib/meal-type-visuals.ts は、使っていた週の献立・食事の詳細の画面と一緒に消した。#1598)
};

/** 見た目の表ではないが 5 値をキーに持つ表を置いてよいファイルと理由 (V2 の除外表) */
const FIVE_KEY_NON_VISUAL_TABLE_ALLOWED: Record<string, string> = {
  'src/app/api/meal-plans/meals/reorder/route.ts': '並べ替えの API の区分の並びの番号 (おやつは 0 で、どこへでも動かせる)。見た目ではない',
};

/** 区分との比較の連鎖 (V1) を残してよいファイルと理由 */
const COMPARISON_CHAIN_ALLOWED: Record<string, string> = {
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts':
    'AI 相談のシステムプロンプトで、今の時刻と区分から「次の食事 / その次」の優先度の文言を選ぶ判定。区分ごとの見た目の表ではない',
};

/** 区分の値と見た目の項目を並べたオブジェクト (V3) を残してよいファイルと理由 */
const VISUAL_OPTION_OBJECT_ALLOWED: Record<string, string> = {
  'src/app/onboarding/questions/page.tsx':
    '人数の設定 (曜日 × 朝・昼・夜) のフォームの列 ({ key, label })。人数の設定は 3 食だけで、区分ごとの見た目の表ではない (#1665 の範囲外)',
  'apps/mobile/app/onboarding/questions.tsx':
    '人数の設定 (曜日 × 朝・昼・夜) のフォームの列 ({ key, label })。人数の設定は 3 食だけで、区分ごとの見た目の表ではない (#1665 の範囲外)',
};

/** 見た目の対応を見張らない製品のソースのディレクトリ (Edge Functions と scripts は見た目を持たない = 限界 v-f) */
const VISUAL_SCAN_EXCLUDED_DIRS = ['supabase/functions/', 'scripts/'];

/** == / === (!= / !== は含めない = 限界 v-b) */
const STRICT_OR_LOOSE_EQUALS = String.raw`(?<![!=<>])={2,3}`;

/** その区分と比べた結果で値を選ぶ形 (三項演算子・case・if (…) return) があるか */
function selectsValueByComparisonWith(strippedSource: string, mealType: string): boolean {
  const quoted = String.raw`['"]${mealType}['"]`;
  return [
    new RegExp(String.raw`${STRICT_OR_LOOSE_EQUALS}\s*${quoted}\s*\?`),
    new RegExp(String.raw`${quoted}\s*${STRICT_OR_LOOSE_EQUALS}\s*[\w.$[\]]+\s*\?`),
    new RegExp(String.raw`\bcase\s+${quoted}\s*:`),
    new RegExp(String.raw`\bif\s*\([^()]*${STRICT_OR_LOOSE_EQUALS}\s*${quoted}[^()]*\)\s*(?:return\b|\{\s*return\b)`),
  ].some((pattern) => pattern.test(strippedSource));
}

/** 比べた結果で値を選ぶ区分の数 (2 つ以上で連鎖とみなす = V1) */
function countComparedMealTypes(strippedSource: string): number {
  return MEAL_ORDER.filter((mealType) => selectsValueByComparisonWith(strippedSource, mealType)).length;
}

/** 連鎖とみなす、比べた区分の数の下限 (1 つだけとの比較は特別扱いの判定 = 限界 v-a) */
const MIN_CHAINED_MEAL_TYPES = 2;

/** 入れ子の無い { … } (V3 の 1 つのオブジェクトのリテラル) */
const FLAT_OBJECT_LITERAL = /\{[^{}]*\}/g;
/** 区分の値を引用符つきで持つ項目 (type: 'breakfast' / key: "lunch" など) */
const MEAL_TYPE_VALUE_PROPERTY = new RegExp(String.raw`:\s*['"](?:${MEAL_ORDER.join('|')})['"]`);
/** 見た目の項目 */
const VISUAL_PROPERTY = /\b(?:label|shortLabel|icon|Icon|emoji|color|bg|background)\s*:/;

/** 区分の値と見た目の項目を並べたオブジェクトのリテラル (V3) */
function findVisualOptionObjects(strippedSource: string): string[] {
  return (strippedSource.match(FLAT_OBJECT_LITERAL) ?? []).filter(
    (fragment) => MEAL_TYPE_VALUE_PROPERTY.test(fragment) && VISUAL_PROPERTY.test(fragment),
  );
}

/** 見た目の対応を見張る製品のソース (PRODUCT_SOURCE_DIRS から VISUAL_SCAN_EXCLUDED_DIRS を除いたもの) */
function collectVisualScanFiles(): string[] {
  return collectProductSourceFiles().filter((file) => !VISUAL_SCAN_EXCLUDED_DIRS.some((dir) => file.startsWith(dir)));
}

describe('#1665 食事の区分ごとの見た目は表 1 か所から引き、表の外に対応表を増やさない', () => {
  it('見張るディレクトリは Web とモバイルの画面と共通のパッケージを含む (走査が空振りしていない)', () => {
    const files = collectVisualScanFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        'src/app/(main)/menus/weekly/_components/modals/AddMealSlotModal.tsx',
        'src/app/(main)/meals/[id]/page.tsx',
        'apps/mobile/app/onboarding/questions.tsx',
        'apps/mobile/src/components/menu/V4GenerateModal.tsx',
        ...Object.keys(MEAL_TYPE_VISUAL_TABLE_FILES),
      ]),
    );
    expect(files.some((file) => file.startsWith('supabase/functions/'))).toBe(false);
  });

  it('除外表と見た目の表のファイルはどれも実在する (改名・削除で検査が空振りしない)', () => {
    for (const file of [
      ...Object.keys(MEAL_TYPE_VISUAL_TABLE_FILES),
      ...Object.keys(FIVE_KEY_NON_VISUAL_TABLE_ALLOWED),
      ...Object.keys(COMPARISON_CHAIN_ALLOWED),
      ...Object.keys(VISUAL_OPTION_OBJECT_ALLOWED),
    ]) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it('V1: 区分との比較の連鎖 (三項・switch・if-return) は、除外表 (理由つき) のファイルにしか無い', () => {
    const chained = collectVisualScanFiles().filter(
      (file) => countComparedMealTypes(readStripped(file)) >= MIN_CHAINED_MEAL_TYPES,
    );
    expect(chained.filter((file) => !(file in COMPARISON_CHAIN_ALLOWED)).sort()).toEqual([]);
    // 除外表の行は、いまも実際にある連鎖を指している (除外表が古くならない)
    expect(chained).toEqual(expect.arrayContaining(Object.keys(COMPARISON_CHAIN_ALLOWED)));
  });

  it('V2: 5 値をキーに持つ表は、見た目の表のファイルと除外表 (理由つき) のファイルにしか無い', () => {
    const withTable = collectVisualScanFiles().filter((file) => findFiveKeyTables(readStripped(file)).length > 0);
    expect(
      withTable
        .filter((file) => !(file in MEAL_TYPE_VISUAL_TABLE_FILES) && !(file in FIVE_KEY_NON_VISUAL_TABLE_ALLOWED))
        .sort(),
    ).toEqual([]);
    // 見た目の表のファイルと除外表の行は、いまも実際にある表を指している
    expect(withTable).toEqual(
      expect.arrayContaining([...Object.keys(MEAL_TYPE_VISUAL_TABLE_FILES), ...Object.keys(FIVE_KEY_NON_VISUAL_TABLE_ALLOWED)]),
    );
  });

  it('V3: 区分の値と見た目の項目を並べたオブジェクトは、除外表 (理由つき) のファイルにしか無い', () => {
    const withOptions = collectVisualScanFiles().filter((file) => findVisualOptionObjects(readStripped(file)).length > 0);
    expect(withOptions.filter((file) => !(file in VISUAL_OPTION_OBJECT_ALLOWED)).sort()).toEqual([]);
    expect(withOptions).toEqual(expect.arrayContaining(Object.keys(VISUAL_OPTION_OBJECT_ALLOWED)));
  });

  it('V1 の検査は、#1665 で消した比較の連鎖を実際に拾う (検査が空振りしていない)', () => {
    // Web の『食事を追加』モーダルの下地の色と絵文字 (4 値 + 既定の値の連鎖。#1631 の番兵の限界 a)
    const addMealSlotBackground = `background: type === 'breakfast' ? colors.warningLight
      : type === 'lunch' ? colors.accentLight
      : type === 'dinner' ? colors.purpleLight
      : type === 'snack' ? colors.successLight
      : colors.blueLight`;
    expect(countComparedMealTypes(stripComments(addMealSlotBackground))).toBe(4);
    // 3 食だけの表示名の連鎖 (買い物の範囲・モバイルの買い物リスト)・左右を入れ替えた比較・二重引用符・==
    expect(
      countComparedMealTypes("const label = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : '夕食';"),
    ).toBe(2);
    expect(countComparedMealTypes(`const c = "breakfast" === t ? a : t == "dinner" ? b : c;`)).toBe(2);
    // switch の case と if (…) return の連鎖
    expect(countComparedMealTypes("switch (t) { case 'lunch': return '☀️'; case \"snack\": return '🍪'; default: return ''; }")).toBe(2);
    expect(countComparedMealTypes("if (t === 'breakfast') return '🌅'; if (t === 'midnight_snack') { return '🌃'; }")).toBe(2);
    // 1 つの区分だけとの比較 (限界 v-a)・!== の絞り込み (限界 v-b)・値を返すだけの分岐・コメントの中の連鎖・表から引く形は拾わない
    expect(countComparedMealTypes("const isSnack = meal.mealType === 'snack'; const s = isSnack ? 1 : 2;")).toBe(0);
    expect(
      countComparedMealTypes("if (t !== 'breakfast' && t !== 'lunch' && t !== 'dinner') return null;"),
    ).toBe(0);
    expect(countComparedMealTypes("if (h < 10) return 'breakfast'; if (h < 14) return 'lunch';")).toBe(0);
    expect(countComparedMealTypes(stripComments(`// ${addMealSlotBackground.replace(/\n/g, ' ')}`))).toBe(0);
    expect(countComparedMealTypes('background: MEAL_TYPE_RECORD_THEME[type].bg, emoji: MEAL_EMOJIS[type]')).toBe(0);
  });

  it('V2 の検査は、#1665 で消した Record<MealType, …> の見た目の表を実際に拾う (検査が空振りしていない)', () => {
    // Web のホームの区分の表 (Record<MealType, …> なので #1631 の番兵の検査 8 は拾わない)
    const homeConfig = `const MEAL_CONFIG: Record<MealType, { icon: typeof Coffee; label: string; color: string; time: string }> = {
      breakfast: { icon: Coffee, label: '朝食', color: '#FF9800', time: '7:00' },
      lunch: { icon: Sun, label: '昼食', color: '#4CAF50', time: '12:00' },
      dinner: { icon: Moon, label: '夕食', color: '#7C4DFF', time: '19:00' },
      snack: { icon: Coffee, label: 'おやつ', color: '#E91E63', time: '15:00' },
      midnight_snack: { icon: Moon, label: '夜食', color: '#3F51B5', time: '22:00' },
    };`;
    expect(findFiveKeyTables(stripComments(homeConfig))).toHaveLength(1);
    // モバイルの『食事タイプを選択』モーダルのアイコンの名前の表 (値が文字列だけの表)
    const mobileIcons = `const MEAL_ICONS: Record<MealType, keyof typeof Ionicons.glyphMap> = {
      breakfast: "sunny", lunch: "partly-sunny", dinner: "moon", snack: "cafe", midnight_snack: "cloudy-night",
    };`;
    expect(findFiveKeyTables(stripComments(mobileIcons))).toHaveLength(1);
    // 3 食だけの表 (限界 v-d) は拾わない
    expect(findFiveKeyTables("const L: Record<MealTimeKey, string> = { breakfast: '朝', lunch: '昼', dinner: '夜' };")).toEqual([]);
  });

  it('V3 の検査は、#1665 で消した選択肢の一覧を実際に拾う (検査が空振りしていない)', () => {
    // Web の『献立を改善』の改善する食事の選択肢
    const improveOptions = `const mealOptions = [
      { type: 'breakfast', label: '朝食', icon: '🌅' },
      { type: 'lunch', label: '昼食', icon: '☀️' },
      { type: 'dinner', label: '夕食', icon: '🌙' },
    ];`;
    expect(findVisualOptionObjects(stripComments(improveOptions))).toHaveLength(3);
    expect(findVisualOptionObjects(`{ value: "midnight_snack", color: c }`)).toHaveLength(1);
    // 見た目の項目の無いオブジェクト・区分の値の無いオブジェクト・表から引く形・入れ子を含むもの (限界 v-e) は拾わない
    expect(findVisualOptionObjects("{ mealType: 'snack', dayIndex: 1 }")).toEqual([]);
    expect(findVisualOptionObjects("{ type: 'cook', label: '自炊' }")).toEqual([]);
    expect(findVisualOptionObjects('{ type, label: MEAL_LABELS[type], icon: MEAL_EMOJIS[type] }')).toEqual([]);
    expect(findVisualOptionObjects("{ type: 'breakfast', style: { color: c } }")).toEqual([]);
  });
});
