/**
 * #1446 の回帰テスト: 献立画面 (Web・モバイル) と食事を追加するモーダルは、食事の区分 (5 値) を手書きせず
 * @homegohan/shared の MealType / MEAL_ORDER / isMealType から導き、any へのキャストで型を外さない。
 * (このファイル自身が差分の any キャストの grep の数に入らないよう、キャストの語は分けて組み立てる)
 *
 * 型 (tsc) は「手書きの 5 値が正本と同じ値か」までは見ないので、ソースを読んで手書きとキャストが戻っていないことを固定する。
 * コメントの中の語で誤って赤にしないよう、コメントを除いてから検査する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** 食事の区分を正本から導くことにしたファイル (#1446 の対象) */
const TARGET_FILES = [
  'apps/mobile/app/menus/weekly/index.tsx',
  'src/app/(main)/menus/weekly/page.tsx',
  'src/app/(main)/menus/weekly/_components/modals/AddMealSlotModal.tsx',
];

/** 5 値を正本と同じ並びで手書きした配列 (引用符は ' と " のどちらも) */
const HANDWRITTEN_FIVE_VALUES =
  /['"]breakfast['"]\s*,\s*['"]lunch['"]\s*,\s*['"]dinner['"]\s*,\s*['"]snack['"]\s*,\s*['"]midnight_snack['"]/;
/** 5 値を手書きした型の宣言 (type MealType = 'breakfast' | ...) */
const LOCAL_MEAL_TYPE_ALIAS = /\btype\s+MealType\s*=/;
/** 型を外す any へのキャストの語 (分けて書く理由は冒頭) */
const CAST_TO_ANY = ['as', 'any'].join(' ');
/** 型を外す any へのキャスト */
const AS_ANY = new RegExp(`\\b${CAST_TO_ANY.replace(' ', '\\s+')}\\b`);

/** 行コメントとブロックコメント (JSX の {/* *\/} を含む) を除く。文字列の中の // (URL) は残す */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function readStripped(relativePath: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

describe('#1446 食事の区分は正本から導き、any へのキャストで型を外さない', () => {
  it.each(TARGET_FILES)('%s に 5 値の手書きの配列が無い', (file) => {
    expect(readStripped(file)).not.toMatch(HANDWRITTEN_FIVE_VALUES);
  });

  it.each(TARGET_FILES)('%s に MealType の手書きの型が無い', (file) => {
    expect(readStripped(file)).not.toMatch(LOCAL_MEAL_TYPE_ALIAS);
  });

  it.each(TARGET_FILES)('%s に any へのキャストが無い', (file) => {
    expect(readStripped(file)).not.toMatch(AS_ANY);
  });

  it('検査の正規表現は、戻ってきた手書きとキャストを実際に拾う (検査が空振りしていない)', () => {
    expect(stripComments("const ALL: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];")).toMatch(
      HANDWRITTEN_FIVE_VALUES,
    );
    expect(stripComments("type MealType = 'breakfast' | 'lunch';")).toMatch(LOCAL_MEAL_TYPE_ALIAS);
    expect(stripComments(`MEAL_ORDER.indexOf(a.meal_type ${CAST_TO_ANY});`)).toMatch(AS_ANY);
    expect(stripComments(`// MEAL_ORDER.indexOf(a.meal_type ${CAST_TO_ANY});`)).not.toMatch(AS_ANY);
  });
});
