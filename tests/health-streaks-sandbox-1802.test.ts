// @vitest-environment node
//
// #1802: 連続日数 (health_streaks) に、ハンズオンのお試しの記録 (is_sandbox = true) が入らないことを固定する。
//
// 確かめた事実 (#1802 で、main のコードを読んで確かめた):
//   1. health_streaks に行を足す・変える (insert / upsert / update) のは src/lib/health-streaks.ts だけ。
//      DB の関数・トリガー (supabase/migrations) にも書き手は無い。
//   2. src/lib/health-streaks.ts が書く streak_type は daily_record (健康の記録 health_records の連続日数) だけ。
//      比較ランキングの指標 record_streak / breakfast_streak が読む meal_record / breakfast の行は、どこからも書かれない
//      (supabase/functions/calculate-segment-stats/index.ts の #1528 のコメントと同じ)。
//   3. updateHealthStreak を呼ぶのは、health_records を保存する 3 か所 (records・records/quick・AI の相談のアクション) だけ。
//   4. お試しの記録は meals (is_sandbox = true) の 1 行に入るだけ (src/lib/handson-tour/sandbox-photo-meal.ts。#1604)。
//      その経路 (ハンズオンのコード・POST /api/meal-plans/add-from-photo) は health_streaks も health_records も触らない
//      (add-from-photo のお試しの保存が meals にしか書かないことは tests/api/add-from-photo-sandbox-route.test.ts が固定している)。
// よって、いまはお試しの記録が連続日数に数えられる経路は無い。直すところは無いので、この事実をここで固定する。
//
// このテストが落ちたら (例: 食事の記録から meal_record / breakfast を書く処理を足した・health_streaks を触るファイルが増えた)、
// その書き手がお試しの記録 (meals.is_sandbox / user_daily_meals.is_sandbox) を数えないようになっているかを確かめてから、
// 下の一覧を直すこと (バッジの件数・比較ランキングの集計と同じ扱い。#1314・#1500)。
//
// 走査の限界 (構文だけを見るので、次は検出しない):
//   - 表の名前を変数や組み立てた文字列で渡す書き方 (`.from(TABLE)`)。表の名前は文字列のリテラルで書く前提
//     (その代わり、規則 A で「'health_streaks' という文字列を持つファイル」そのものを一覧で固定している)
//   - `.from('health_streaks')` を変数に入れてから `.insert(...)` を呼ぶ書き方 (規則 B の書き手の判定は、同じ式の連鎖だけを見る)

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

const TABLE = 'health_streaks';

/** 本番のコードを置く場所 (テストは除く) */
const SCAN_ROOTS = ['src', 'apps/mobile/app', 'apps/mobile/src', 'packages', 'supabase/functions'] as const;
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__', '.next', 'dist', 'build']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** health_streaks の行を足す・変える PostgREST のメソッド */
const WRITE_METHODS = new Set(['insert', 'upsert', 'update']);

/** health_streaks の streak_type として使われている値 (src/app/api/health/streaks/route.ts の許可の一覧と、集計が読む breakfast) */
const KNOWN_STREAK_TYPES = ['daily_record', 'meal_record', 'health_record', 'exercise_record', 'breakfast'] as const;

/**
 * 'health_streaks' という文字列を持つ本番のファイルと、その理由。ちょうどこの一覧 (増えても減っても落ちる)。
 * 型の定義・読むだけ・利用者が自分の行を消すだけのファイルは、連続日数を進めないので、お試しの記録とは関わらない。
 */
const FILES_TOUCHING_HEALTH_STREAKS: Record<string, string> = {
  'src/lib/health-streaks.ts': '唯一の書き手。daily_record (健康の記録の連続日数) だけを書く',
  'src/app/api/health/records/quick/route.ts': '保存した後に daily_record を読んで応答に入れるだけ',
  'src/app/api/health/streaks/route.ts': '利用者が自分の行を読む・消す (DELETE) だけ。数を進めない',
  'src/hooks/useHomeData.ts': 'ホームで daily_record を読むだけ',
  'apps/mobile/src/hooks/useHomeData.ts': 'モバイルのホームで daily_record を読むだけ',
  'src/lib/account-export-tables.ts': 'アカウントの書き出しで自分の行を読むだけ',
  'supabase/functions/calculate-segment-stats/index.ts': '比較ランキングの集計で meal_record / breakfast を読むだけ (書く処理は無い。#1528)',
  'src/types/database.types.ts': 'DB の型の定義',
  'packages/shared/src/database.types.ts': 'DB の型の定義 (共有パッケージ)',
};

/** updateHealthStreak を import するファイル (どれも health_records を保存した後に呼ぶ)。ちょうどこの一覧 */
const HEALTH_STREAK_CALLERS = [
  'src/app/api/health/records/quick/route.ts',
  'src/app/api/health/records/route.ts',
  'src/lib/ai/consultation-action-executor.ts',
] as const;

/** ハンズオンのお試しの記録を保存する経路 (#1604) */
const SANDBOX_WRITER_FILES = [
  'src/lib/handson-tour/sandbox-photo-meal.ts',
  'src/app/api/meal-plans/add-from-photo/route.ts',
] as const;
const SANDBOX_DIRS = ['src/lib/handson-tour', 'src/app/api/handson-tour', 'packages/handson-tour-shared'] as const;

function walk(relDir: string, out: string[]): void {
  const absDir = path.join(ROOT, relDir);
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(rel, out);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !TEST_FILE.test(entry.name)) {
      out.push(rel);
    }
  }
}

function listSourceFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, out);
  return out.sort();
}

const sourceFileCache = new Map<string, ts.SourceFile>();
function parse(rel: string): ts.SourceFile {
  const cached = sourceFileCache.get(rel);
  if (cached) return cached;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const kind = rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  sourceFileCache.set(rel, sf);
  return sf;
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

/** ファイルの文字列のリテラル (コメントの中は見ない) */
function stringLiterals(rel: string): string[] {
  const out: string[] = [];
  visit(parse(rel), (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
  });
  return out;
}

function firstArgText(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return arg.text;
  return null;
}

/** `x.from('<table>')` に続く同じ式の連鎖で呼ばれるメソッドの名前 (`.from(t).update(...).eq(...)` なら update, eq) */
function chainedMethodsOnTable(rel: string, table: string): string[] {
  const methods: string[] = [];
  visit(parse(rel), (n) => {
    if (!ts.isCallExpression(n)) return;
    if (!ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'from') return;
    if (firstArgText(n) !== table) return;
    let cur: ts.Node = n;
    while (ts.isPropertyAccessExpression(cur.parent) && ts.isCallExpression(cur.parent.parent)) {
      methods.push(cur.parent.name.text);
      cur = cur.parent.parent;
    }
  });
  return methods;
}

/** import / export ... from / require / import() のモジュール指定子 */
function moduleSpecifiers(rel: string): string[] {
  const out: string[] = [];
  visit(parse(rel), (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n)) {
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      const isDynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const spec = firstArgText(n);
      if ((isRequire || isDynamicImport) && spec) out.push(spec);
    }
  });
  return out;
}

function importsHealthStreaksLib(rel: string): boolean {
  return moduleSpecifiers(rel).some((spec) => /(^|\/)lib\/health-streaks$/.test(spec) || /^\.{1,2}\/(.*\/)?health-streaks$/.test(spec));
}

/** SQL のコメント (-- 行末まで・/* *\/) を取り除く */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const FILES = listSourceFiles();

describe('#1802: 連続日数 (health_streaks) にハンズオンのお試しの記録が入らない', () => {
  it('走査の対象が空でない (走査の場所を間違えて、何も見ずに通ることを防ぐ)', () => {
    expect(FILES).toContain('src/lib/health-streaks.ts');
    expect(FILES).toContain('apps/mobile/src/hooks/useHomeData.ts');
    expect(FILES).toContain('supabase/functions/calculate-segment-stats/index.ts');
  });

  it("規則 A: 'health_streaks' という文字列を持つ本番のファイルは、理由を書いた一覧とちょうど同じ", () => {
    const touching = FILES.filter((rel) => stringLiterals(rel).includes(TABLE));
    expect(touching).toEqual(Object.keys(FILES_TOUCHING_HEALTH_STREAKS).sort());
  });

  it('規則 B: health_streaks の行を足す・変える (insert / upsert / update) のは src/lib/health-streaks.ts だけ', () => {
    const writers = FILES.filter((rel) =>
      chainedMethodsOnTable(rel, TABLE).some((method) => WRITE_METHODS.has(method)),
    );
    expect(writers).toEqual(['src/lib/health-streaks.ts']);
    // 唯一の書き手は insert と update の両方を持つ (判定が空振りしていないことの確かめ)
    const methods = chainedMethodsOnTable('src/lib/health-streaks.ts', TABLE);
    expect(methods).toContain('insert');
    expect(methods).toContain('update');
  });

  it('規則 C: DB の関数・トリガー (migration) に health_streaks を書く文は無い', () => {
    const dir = path.join(ROOT, 'supabase/migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const writeStatement =
      /\b(insert\s+into|update|merge\s+into|delete\s+from)\s+(only\s+)?("?public"?\s*\.\s*)?"?health_streaks"?(?![\w])/i;
    const offenders = files.filter((f) => writeStatement.test(stripSqlComments(fs.readFileSync(path.join(dir, f), 'utf8'))));
    expect(offenders).toEqual([]);
    // 正規表現が書く文を拾えることの確かめ (空振りで通らないように)
    expect(writeStatement.test('INSERT INTO public.health_streaks (user_id) VALUES ($1)')).toBe(true);
    expect(writeStatement.test('update "public"."health_streaks" set current_streak = 1')).toBe(true);
    expect(writeStatement.test('CREATE POLICY "x" ON "public"."health_streaks" FOR UPDATE TO "authenticated"')).toBe(false);
  });

  it('規則 D: 唯一の書き手が書く streak_type は daily_record だけ (meal_record / breakfast は書かない)', () => {
    const literals = stringLiterals('src/lib/health-streaks.ts');
    const streakTypes = KNOWN_STREAK_TYPES.filter((type) => literals.includes(type));
    expect(streakTypes).toEqual(['daily_record']);
  });

  it('規則 E: updateHealthStreak を呼ぶのは、health_records を保存する 3 か所だけ', () => {
    const importers = FILES.filter((rel) => rel !== 'src/lib/health-streaks.ts' && importsHealthStreaksLib(rel));
    expect(importers).toEqual([...HEALTH_STREAK_CALLERS].sort());
    for (const rel of HEALTH_STREAK_CALLERS) {
      // どれも health_records を upsert してから連続日数を進める
      expect(chainedMethodsOnTable(rel, 'health_records'), rel).toContain('upsert');
    }
  });

  it('規則 F: お試しの記録を保存する経路は、連続日数にも健康の記録にも触らない', () => {
    const sandboxFiles = FILES.filter(
      (rel) =>
        (SANDBOX_WRITER_FILES as readonly string[]).includes(rel) ||
        SANDBOX_DIRS.some((dir) => rel.startsWith(`${dir}/`)),
    );
    // 経路のファイルが実在する (移動・改名で空振りしない)
    for (const rel of SANDBOX_WRITER_FILES) expect(sandboxFiles, rel).toContain(rel);
    // お試しの記録は meals に is_sandbox = true で入る (#1604)
    expect(stringLiterals('src/lib/handson-tour/sandbox-photo-meal.ts')).toContain('meals');

    for (const rel of sandboxFiles) {
      const literals = stringLiterals(rel);
      expect(literals.includes(TABLE), rel).toBe(false);
      expect(literals.includes('health_records'), rel).toBe(false);
      expect(importsHealthStreaksLib(rel), rel).toBe(false);
    }
  });
});
