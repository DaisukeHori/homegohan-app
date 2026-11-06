/**
 * #2283 モバイルの AI 相談の「1日献立変更」の日付の欄の値・文・決め方 (apps/mobile/src/lib/ai-day-menu-date.ts) が、Web の AI 相談
 * (src/components/AIChatBubble.tsx。#2245 K1・L1) と同じであること。
 *
 * モバイルはルートの src/ を import できない (.easignore が /src/ を除外する) ので、Web の値・文・関数を写して持つ。写しが Web から
 * ずれたら (どちらかだけを変えたら) ここで赤になる。Web の部品は画面のモジュールの中にあり、読み込むと画面の依存まで要るので、
 * ソースを TypeScript の構文木で読み、定数と関数を取り出して比べる。
 *   1. 値: 既定の日のずらし (DAY_MENU_DEFAULT_OFFSET_DAYS)・選べる最後の日のずらし (DAY_MENU_MAX_OFFSET_DAYS) が Web と同じ
 *   2. 文: 範囲の外の理由の一文 (DAY_MENU_DATE_UNSELECTABLE_MESSAGE)・欄の下の範囲の案内が Web と同じ
 *   3. 決め方: Web の関数 (dayMenuDateRangeOf・isDayMenuDateSelectable・defaultDayMenuDateOf) を取り出して動かし、同じ入力で
 *      モバイルの写しと同じ答えになる (表示の日が無い・今日・範囲の中・範囲の外・形の崩れ、暦の端)
 *   4. 写しが使われている: AIDayMenuModal は値・文を自分で持たず、この部品から読む
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { addDaysToDate, isCalendarDate } from '@homegohan/shared';
import * as mobile from '../apps/mobile/src/lib/ai-day-menu-date';

const ROOT = path.resolve(__dirname, '..');
const WEB_CHAT_BUBBLE_PATH = 'src/components/AIChatBubble.tsx';
const DAY_MENU_MODAL_PATH = 'apps/mobile/src/components/ai/AIDayMenuModal.tsx';
const NUMBER_NAMES = ['DAY_MENU_DEFAULT_OFFSET_DAYS', 'DAY_MENU_MAX_OFFSET_DAYS'] as const;
const WEB_FUNCTION_NAMES = [
  'shiftCalendarDayOrNull',
  'dayMenuDateRangeOf',
  'isDayMenuDateSelectable',
  'defaultDayMenuDateOf',
] as const;

interface DayMenuDateFunctions {
  dayMenuDateRangeOf: (today: string) => { min: string; max: string | null };
  isDayMenuDateSelectable: (date: string, range: { min: string; max: string | null }) => boolean;
  defaultDayMenuDateOf: (today: string, displayedDate: unknown) => string;
}

function webText(): string {
  return fs.readFileSync(path.join(ROOT, WEB_CHAT_BUBBLE_PATH), 'utf8');
}

function webSource(): ts.SourceFile {
  return ts.createSourceFile(WEB_CHAT_BUBBLE_PATH, webText(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** ソースの最上位の const 宣言 (name) の文 */
function topLevelVariableStatement(source: ts.SourceFile, name: string): { statement: ts.VariableStatement; initializer: ts.Expression } {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return { statement, initializer: declaration.initializer };
      }
    }
  }
  throw new Error(`${WEB_CHAT_BUBBLE_PATH} に ${name} が無い`);
}

function stringConstant(source: ts.SourceFile, name: string): string {
  const { initializer } = topLevelVariableStatement(source, name);
  if (!ts.isStringLiteralLike(initializer)) throw new Error(`${name} が文字列の定数でない`);
  return initializer.text;
}

function numberConstant(source: ts.SourceFile, name: string): number {
  const { initializer } = topLevelVariableStatement(source, name);
  if (!ts.isNumericLiteral(initializer)) throw new Error(`${name} が数の定数でない`);
  return Number(initializer.text);
}

/** ソースの最上位の関数宣言 (name) */
function topLevelFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  }
  throw new Error(`${WEB_CHAT_BUBBLE_PATH} に関数 ${name} が無い`);
}

/** Web の JSX の文字 (JsxText) をすべて (前後の空白を除く) */
function webJsxTexts(source: ts.SourceFile): string[] {
  const texts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text !== '') texts.push(text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return texts;
}

/**
 * Web の日付の欄の関数を取り出して動かす。関数と、それが使う数の定数の宣言の文を JavaScript に変換し、Web が import する
 * addDaysToDate・isCalendarDate (どちらも @homegohan/shared の再エクスポート) を渡して評価する
 */
function webFunctions(): DayMenuDateFunctions {
  const source = webSource();
  const declarations = [
    ...NUMBER_NAMES.map((name) => topLevelVariableStatement(source, name).statement.getText(source)),
    ...WEB_FUNCTION_NAMES.map((name) => topLevelFunction(source, name).getText(source)),
  ].join('\n');
  const javascript = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  // 評価するのはリポジトリの Web の部品のソースだけ (外からの入力ではない)
  const build = new Function(
    'addDaysToDate',
    'isCalendarDate',
    `${javascript}\nreturn { dayMenuDateRangeOf, isDayMenuDateSelectable, defaultDayMenuDateOf };`,
  ) as (add: typeof addDaysToDate, isDate: typeof isCalendarDate) => DayMenuDateFunctions;
  return build(addDaysToDate, isCalendarDate);
}

const TODAY = '2026-11-06';
/** 暦の計算で 14 日後を扱えない今日 (上限なし) と、明日を扱えない今日 (既定は今日) */
const TODAY_WITHOUT_MAX = '9999-12-20';
const TODAY_WITHOUT_TOMORROW = '9999-12-31';
const TODAYS = [TODAY, '2026-12-25', '2027-02-20', TODAY_WITHOUT_MAX, TODAY_WITHOUT_TOMORROW] as const;
/** 今日からのずれ (範囲の外の前後・端・中) */
const OFFSETS = [-1, 0, 1, 7, 13, 14, 15, 30] as const;
const NOT_DATES = ['', '2026/11/10', '2026-11-1', '2026-11-31', '2026-02-30', 'tomorrow'] as const;

/** today から offset 日ずらした日 (暦の計算で扱えなければ外す) */
function shiftedOrNull(today: string, offset: number): string | null {
  try {
    return addDaysToDate(today, offset);
  } catch {
    return null;
  }
}

function candidateDates(today: string): string[] {
  return [
    ...OFFSETS.map((offset) => shiftedOrNull(today, offset)).filter((date): date is string => date !== null),
    ...NOT_DATES,
  ];
}

describe('1. 値が Web と一致する', () => {
  it.each(NUMBER_NAMES)('%s', (name) => {
    expect(mobile[name]).toBe(numberConstant(webSource(), name));
  });
});

describe('2. 文が Web と一致する', () => {
  it('範囲の外の理由の一文 (DAY_MENU_DATE_UNSELECTABLE_MESSAGE)', () => {
    expect(mobile.DAY_MENU_DATE_UNSELECTABLE_MESSAGE).toBe(stringConstant(webSource(), 'DAY_MENU_DATE_UNSELECTABLE_MESSAGE'));
  });

  it('欄の下の範囲の案内 (DAY_MENU_DATE_RANGE_HINT は Web の日付の欄の下の文字と同じ)', () => {
    expect(webJsxTexts(webSource())).toContain(mobile.DAY_MENU_DATE_RANGE_HINT);
  });
});

describe('3. 決め方が Web と同じ', () => {
  const web = webFunctions();

  it('選べる範囲 (dayMenuDateRangeOf)', () => {
    for (const today of TODAYS) {
      expect(mobile.dayMenuDateRangeOf(today), today).toEqual(web.dayMenuDateRangeOf(today));
    }
  });

  it('作ってよい日か (isDayMenuDateSelectable)', () => {
    for (const today of TODAYS) {
      const range = web.dayMenuDateRangeOf(today);
      for (const date of candidateDates(today)) {
        expect(mobile.isDayMenuDateSelectable(date, range), `${today} に ${date}`).toBe(web.isDayMenuDateSelectable(date, range));
      }
    }
  });

  it('既定の日 (defaultDayMenuDateOf。表示の日が無い・今日・範囲の中・範囲の外・形の崩れ・文字列でない)', () => {
    for (const today of TODAYS) {
      for (const displayed of [undefined, null, 0, ...candidateDates(today)]) {
        expect(mobile.defaultDayMenuDateOf(today, displayed), `${today} に表示の日 ${String(displayed)}`).toBe(
          web.defaultDayMenuDateOf(today, displayed),
        );
      }
    }
  });

  it('取り出した Web の関数が空振りしていない (表示の日が無ければ明日・範囲は今日〜14 日後・範囲の外は作れない)', () => {
    expect(web.defaultDayMenuDateOf(TODAY, undefined)).toBe('2026-11-07');
    expect(web.dayMenuDateRangeOf(TODAY)).toEqual({ min: TODAY, max: '2026-11-20' });
    expect(web.isDayMenuDateSelectable('2026-11-05', web.dayMenuDateRangeOf(TODAY))).toBe(false);
    expect(web.isDayMenuDateSelectable('2026-11-21', web.dayMenuDateRangeOf(TODAY))).toBe(false);
    expect(web.dayMenuDateRangeOf(TODAY_WITHOUT_MAX).max).toBeNull();
    expect(web.defaultDayMenuDateOf(TODAY_WITHOUT_TOMORROW, undefined)).toBe(TODAY_WITHOUT_TOMORROW);
  });
});

describe('4. 写しが使われている', () => {
  it('AIDayMenuModal は値・文を自分で持たず、ai-day-menu-date から読む', () => {
    const modal = fs.readFileSync(path.join(ROOT, DAY_MENU_MODAL_PATH), 'utf8');
    expect(modal).toContain('from "../../lib/ai-day-menu-date"');
    expect(modal).not.toContain(mobile.DAY_MENU_DATE_UNSELECTABLE_MESSAGE);
    expect(modal).not.toContain(mobile.DAY_MENU_DATE_RANGE_HINT);
    for (const name of ['defaultDayMenuDateOf', 'isDayMenuDateSelectable', 'dayMenuDateRangeOf']) {
      expect(modal, `${name} を AIDayMenuModal が呼んでいる`).toMatch(new RegExp(`\\b${name}\\(`));
      expect(modal, `${name} を AIDayMenuModal が自分で定義していない`).not.toMatch(new RegExp(`function ${name}\\b`));
    }
  });
});
