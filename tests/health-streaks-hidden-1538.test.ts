// @vitest-environment node
//
// #1538: 連続日数 (health_streaks) に、運営が隠した食事 (meals.hidden_at が入った行。#1101) が入らないことを固定する。
//
// 確かめた事実 (#1538 で、main のコードと migration を読んで確かめた):
//   1. 運営が隠す列 (hidden_at / hidden_by / hidden_reason) を持つ表は meals と recipes だけ
//      (supabase/migrations/20261009000500_hide_moderated_content.sql の 1.)。健康の記録 health_records と
//      連続日数 health_streaks には隠す列が無く、運営が隠す対象でもない。
//   2. health_streaks を書くのは src/lib/health-streaks.ts だけで、書く streak_type は daily_record だけ
//      (tests/health-streaks-sandbox-1802.test.ts の規則 B・C・D が固定している)。この書き手が読み書きする表は
//      health_streaks だけで、食事・レシピの表 (meals / recipes / planned_meals / user_daily_meals) を読まない。
//   3. 連続日数を進める updateHealthStreak に渡す日付は、呼び出し元が直前に upsert した health_records の
//      record_date と同じ変数 (records・records/quick・AI の相談のアクションの 3 か所)。食事の日付は渡らない。
//   4. 比較ランキングの指標 record_streak / breakfast_streak が読む meal_record / breakfast の行は、どこからも書かれない
//      (supabase/functions/calculate-segment-stats/index.ts の #1528 のコメント。1802 の規則 D)。
// よって、いまは隠した食事が連続日数に数えられる経路は無い。直すところは無いので、この事実をここで固定する。
//
// このテストが落ちたら (例: health_records や health_streaks に隠す列を足した・連続日数の書き手が食事を読むようになった・
// 食事の記録から meal_record / breakfast を書く処理を足した)、その書き手が運営の隠した食事 (meals.hidden_at IS NOT NULL) と
// お試しの記録 (is_sandbox = true) を数えないようになっているかを確かめてから、下の一覧を直すこと
// (比較ランキングの集計 calculate-segment-stats の meals の読み込み・count_meals_per_user と同じ扱い。#1445・#1500)。
//
// 走査の限界 (構文だけを見るので、次は検出しない):
//   - 表の名前を変数や組み立てた文字列で渡す書き方 (`.from(TABLE)`)。表の名前は文字列のリテラルで書く前提
//   - migration の動的 SQL (EXECUTE format(...)) で列を足す書き方

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** 運営が隠したことを表す列 (migration 20261009000500 の 1.) */
const HIDDEN_COLUMN = 'hidden_at';

/** 隠す列を持つ表。ちょうどこの一覧 (増えても減っても落ちる) */
const TABLES_WITH_HIDDEN_COLUMN = ['meals', 'recipes'] as const;

/** 連続日数の元になる表と、連続日数そのものの表 (どちらにも隠す列は無い) */
const STREAK_SOURCE_TABLES = ['health_records', 'health_streaks'] as const;

/** 連続日数の唯一の書き手 (1802 の規則 B) */
const STREAK_WRITER = 'src/lib/health-streaks.ts';

/** 食事・レシピの表 (隠す列を持つ表と、食事の記録の表) */
const MEAL_TABLES = ['meals', 'recipes', 'planned_meals', 'user_daily_meals'] as const;

/** updateHealthStreak を呼ぶファイル (1802 の規則 E と同じ 3 か所) */
const HEALTH_STREAK_CALLERS = [
  'src/app/api/health/records/quick/route.ts',
  'src/app/api/health/records/route.ts',
  'src/lib/ai/consultation-action-executor.ts',
] as const;

/** updateHealthStreak(supabase, userId, recordDate) の記録日の引数の位置 (0 始まり) */
const RECORD_DATE_ARG_INDEX = 2;

/** 本番より前の表の定義 (migration の起点) と、migration の置き場所 */
const BASELINE_SCHEMA = 'supabase/baseline/prod_schema.sql';
const MIGRATIONS_DIR = 'supabase/migrations';

function readSource(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** SQL のコメント (-- 行末まで・/* *\/) を取り除く */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const QUALIFIED_TABLE = String.raw`(?:"?public"?\s*\.\s*)?"?(\w+)"?`;
const ALTER_TABLE_ADD_HIDDEN = new RegExp(
  String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED_TABLE}[\s\S]*\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?${HIDDEN_COLUMN}"?(?![\w])`,
  'i',
);
const CREATE_TABLE_HEAD = new RegExp(String.raw`^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED_TABLE}\s*\(`, 'i');
const HIDDEN_COLUMN_WORD = new RegExp(String.raw`(^|[^\w])"?${HIDDEN_COLUMN}"?(?![\w])`);

/** SQL の文 (; で区切る) のうち、隠す列を作る文の表の名前 */
function tablesGivenHiddenColumn(sql: string): string[] {
  const tables: string[] = [];
  for (const statement of stripSqlComments(sql).split(';')) {
    const altered = ALTER_TABLE_ADD_HIDDEN.exec(statement);
    if (altered) {
      tables.push(altered[1]);
      continue;
    }
    const created = CREATE_TABLE_HEAD.exec(statement);
    if (created && HIDDEN_COLUMN_WORD.test(statement.slice(created[0].length))) tables.push(created[1]);
  }
  return tables;
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => path.posix.join(MIGRATIONS_DIR, f));
}

function parse(rel: string): ts.SourceFile {
  const kind = rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, readSource(rel), ts.ScriptTarget.Latest, true, kind);
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function literalText(node: ts.Node | undefined): string | null {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return null;
}

/** ファイルの文字列のリテラル (コメントの中は見ない) */
function stringLiterals(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  visit(sf, (n) => {
    const text = literalText(n);
    if (text !== null) out.push(text);
  });
  return out;
}

/** `x.<method>(<最初の引数>)` の呼び出し */
function callsOf(sf: ts.SourceFile, method: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  visit(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === method) out.push(n);
  });
  return out;
}

/** `updateHealthStreak(...)` の呼び出し (識別子で呼ぶもの) */
function updateHealthStreakCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  visit(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'updateHealthStreak') out.push(n);
  });
  return out;
}

/** `.from('<table>')` に続く同じ式の連鎖の `.upsert(<obj>)` の、最初の引数のオブジェクトのリテラル */
function upsertObjectsOnTable(sf: ts.SourceFile, table: string): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  for (const fromCall of callsOf(sf, 'from')) {
    if (literalText(fromCall.arguments[0]) !== table) continue;
    let cur: ts.Node = fromCall;
    while (ts.isPropertyAccessExpression(cur.parent) && ts.isCallExpression(cur.parent.parent)) {
      const call = cur.parent.parent;
      const arg = call.arguments[0];
      if (cur.parent.name.text === 'upsert' && arg && ts.isObjectLiteralExpression(arg)) out.push(arg);
      cur = call;
    }
  }
  return out;
}

/** オブジェクトのリテラルの record_date に入れる識別子の名前 (`record_date: x` / 省略形 `{ record_date }`) */
function recordDateIdentifier(obj: ts.ObjectLiteralExpression): string | null {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'record_date' && ts.isIdentifier(prop.initializer)) {
      return prop.initializer.text;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'record_date') return prop.name.text;
  }
  return null;
}

describe('#1538: 連続日数 (health_streaks) に運営が隠した食事が入らない', () => {
  it('隠す列を作る文の見分け方が、ALTER TABLE と CREATE TABLE の両方を拾う (空振りで通らないように)', () => {
    expect(tablesGivenHiddenColumn('ALTER TABLE public.meals ADD COLUMN IF NOT EXISTS hidden_at timestamptz;')).toEqual(['meals']);
    expect(tablesGivenHiddenColumn('alter table only "public"."health_records" add "hidden_at" timestamptz')).toEqual([
      'health_records',
    ]);
    expect(tablesGivenHiddenColumn('CREATE TABLE IF NOT EXISTS public.health_streaks (id uuid, hidden_at timestamptz);')).toEqual([
      'health_streaks',
    ]);
    // 別の列・コメントの中・索引は拾わない
    expect(tablesGivenHiddenColumn('ALTER TABLE public.meals ADD COLUMN hidden_at_note text;')).toEqual([]);
    expect(tablesGivenHiddenColumn('-- ALTER TABLE public.health_records ADD COLUMN hidden_at timestamptz;')).toEqual([]);
    expect(tablesGivenHiddenColumn('CREATE INDEX idx_meals_hidden_at ON public.meals (hidden_at) WHERE hidden_at IS NOT NULL;')).toEqual([]);
    expect(tablesGivenHiddenColumn('CREATE TABLE public.meal_notes (id uuid, hidden_atx text);')).toEqual([]);
  });

  it('規則 1: 運営が隠す列 (hidden_at) を持つ表は meals と recipes だけ。health_records と health_streaks には無い', () => {
    const files = [BASELINE_SCHEMA, ...migrationFiles()];
    expect(files.length).toBeGreaterThan(1);
    const tables = new Set<string>();
    for (const rel of files) for (const table of tablesGivenHiddenColumn(readSource(rel))) tables.add(table);
    expect([...tables].sort()).toEqual([...TABLES_WITH_HIDDEN_COLUMN].sort());
    for (const table of STREAK_SOURCE_TABLES) expect(tables.has(table), table).toBe(false);
  });

  it('規則 2: 連続日数の唯一の書き手は health_streaks だけを読み書きし、食事・レシピの表を読まない', () => {
    const sf = parse(STREAK_WRITER);
    const fromTables = callsOf(sf, 'from').map((call) => literalText(call.arguments[0]));
    // 判定が空振りしていないことの確かめ (読む・作る・変えるの 3 回)
    expect(fromTables.length).toBeGreaterThan(0);
    expect(new Set(fromTables)).toEqual(new Set(['health_streaks']));
    // DB の関数を呼んで、食事から数えることもしない
    expect(callsOf(sf, 'rpc')).toEqual([]);
    const literals = stringLiterals(sf);
    for (const table of MEAL_TABLES) expect(literals.includes(table), table).toBe(false);
  });

  it('規則 3: updateHealthStreak に渡す記録日は、直前に upsert した health_records の record_date と同じ変数', () => {
    for (const rel of HEALTH_STREAK_CALLERS) {
      const sf = parse(rel);
      const calls = updateHealthStreakCalls(sf);
      expect(calls.length, rel).toBeGreaterThan(0);
      const upsertedDates = upsertObjectsOnTable(sf, 'health_records').map(recordDateIdentifier);
      expect(upsertedDates.length, rel).toBeGreaterThan(0);
      for (const call of calls) {
        const arg = call.arguments[RECORD_DATE_ARG_INDEX];
        expect(arg && ts.isIdentifier(arg), `${rel}: 記録日の引数が変数でない`).toBe(true);
        expect(upsertedDates, rel).toContain((arg as ts.Identifier).text);
      }
    }
  });

  it('規則 3 の見分け方が、health_records 以外の表の upsert と、別の変数を拾わない (空振りで通らないように)', () => {
    const src = [
      "await supabase.from('health_records').upsert({ user_id: u, record_date: recordDate }, { onConflict: 'x' });",
      "await supabase.from('meals').upsert({ record_date: mealDate });",
      'await updateHealthStreak(supabase, u, recordDate);',
    ].join('\n');
    const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(upsertObjectsOnTable(sf, 'health_records').map(recordDateIdentifier)).toEqual(['recordDate']);
    expect(upsertObjectsOnTable(sf, 'meals').map(recordDateIdentifier)).toEqual(['mealDate']);
    expect(updateHealthStreakCalls(sf)).toHaveLength(1);
    const shorthand = ts.createSourceFile(
      'y.ts',
      "await supabase.from('health_records').upsert({ record_date });",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(upsertObjectsOnTable(shorthand, 'health_records').map(recordDateIdentifier)).toEqual(['record_date']);
  });
});
