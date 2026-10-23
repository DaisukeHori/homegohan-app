// @vitest-environment node
/**
 * #1917 API の route が、DB の読み込みの失敗を「見つからない (404)」にしていないかの「見張り」
 *
 * 問題:
 *   以前は多くの route が `.single()` で 1 行を読み、`if (error || !row) return 404` (または error を見ずに `if (!row) return 404`)
 *   と書いていた。DB の一時的な失敗 (接続の切断・タイムアウトなど) でも「見つかりません」になり、実在する行が消えたように見え、
 *   再試行の判断を誤らせる。逆に `.single()` の error をそのまま 500 にすると、行が無いとき (PGRST116) も 500 になる
 *   (GET /api/health/goals/[id] の他人の目標・消された目標)。
 *
 * 決まり (直し方):
 *   1 行を読んで「無ければ 404」にするところは `.maybeSingle()` で読み、`if (error) return internalError(...)` (500)、
 *   `if (!row) return 404` と分ける (行が無いときだけ 404)。uuid 型の列を引く id は、DB に渡す前に isUuid で確かめて 404 にする
 *   (渡すと 22P02 の失敗になり、「DB の失敗は 500」に入ってしまうため)。
 *
 * 数えるもの (TypeScript の構文木で読む。コメント・文字列の中は見ない):
 *   (A) if の条件が `||` でつないだ式で、その項にエラーらしい名前の値 (`error` / `err` / `xxxError` / `xxxErr`) があり、
 *       then の側が 404 を返すもの (`if (error || !row) return NextResponse.json(..., { status: 404 })`)
 *   (B) `.single()` で読んだ文のすぐ後ろ (同じブロックの次の FOLLOWING_STATEMENTS 文) の if が 404 を返すもの
 *       (error を見ずに `if (!row) return 404` と書く形。`.single()` は行が無いと PGRST116 の失敗になる)
 *   どちらも、その if の条件か then の側で PGRST116 を見分けているもの (`if (error.code === 'PGRST116') return 404`) は数えない
 *   (行が無い失敗だけを 404 にし、ほかの失敗を 500 にする書き方)。
 *
 * この検査の限界 (捕まえない書き方。網羅は目指さない):
 *   - 404 を返す関数を呼ぶだけで、then の側に 404 の数字が出てこないもの (`if (error || !row) return notFound()`)
 *   - エラーらしくない名前の値 (`const { data, error: failure } = ...; if (failure || !data)`)
 *   - `.single()` の結果を変数に入れてから、FOLLOWING_STATEMENTS 文より後ろで 404 にするもの
 *   - src/app/api の外 (src/lib) のヘルパーの中で、DB の失敗を「無い」と同じに扱うもの
 *     (例: src/lib/handson-tour/sandbox-eligibility.ts は読めないときも profile_not_found にする fail-closed の判定)
 *
 * 走査の対象は src/app/api 配下の全ファイル (テストを除く)。1 件でもあれば失敗する。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/api';

/** エラーを受ける値の名前: e / err / error、または Error / Err で終わる名前 */
const ERROR_NAME = /^(?:e|err|error)$|(?:Error|Err)$/;
/** 「見つからない」の HTTP ステータス */
const HTTP_NOT_FOUND = 404;
/** `.single()` の文の後ろで、404 を返す if を探す文の数 */
const FOLLOWING_STATEMENTS = 3;
/** PostgREST の「行が無い (または 2 行以上)」の error.code */
const POSTGREST_NO_ROWS_CODE = 'PGRST116';

interface Finding {
  file: string;
  line: number;
  rule: 'A' | 'B';
  text: string;
}

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listRouteFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** ノードの中に 404 の数値リテラルがあるか */
function returnsNotFound(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isNumericLiteral(n) && Number(n.text) === HTTP_NOT_FOUND) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** ノードの中に 'PGRST116' の文字列リテラルがあるか */
function mentionsNoRowsCode(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === POSTGREST_NO_ROWS_CODE) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** `a || b || c` を項の並びにする */
function orOperands(expr: ts.Expression): ts.Expression[] {
  const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [...orOperands(inner.left), ...orOperands(inner.right)];
  }
  return [inner];
}

/** 項がエラーらしい名前の値か (`error` / `fetchErr` / `result.error`) */
function isErrorValue(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return ERROR_NAME.test(expr.text);
  if (ts.isPropertyAccessExpression(expr)) return ERROR_NAME.test(expr.name.text);
  return false;
}

/** `X.single()` の呼び出しか */
function isSingleCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'single'
  );
}

/** ノードを含む文 (親がブロック・ファイルの文) */
function enclosingStatement(node: ts.Node): ts.Statement | null {
  let current: ts.Node | undefined = node;
  while (current && current.parent) {
    if (ts.isBlock(current.parent) || ts.isSourceFile(current.parent) || ts.isCaseClause(current.parent)) {
      return current as ts.Statement;
    }
    current = current.parent;
  }
  return null;
}

/** 文の並び (ブロック・ファイル・case) */
function siblingStatements(statement: ts.Statement): readonly ts.Statement[] {
  const parent = statement.parent;
  if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent)) return parent.statements;
  return [];
}

function scanFile(file: string): Finding[] {
  return scanSource(fs.readFileSync(file, 'utf-8'), path.relative(ROOT, file));
}

function scanSource(text: string, relative: string): Finding[] {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node): void => {
    // (A) if (error || !row) return 404
    if (ts.isIfStatement(node)) {
      const operands = orOperands(node.expression);
      if (
        operands.length > 1 &&
        operands.some(isErrorValue) &&
        returnsNotFound(node.thenStatement) &&
        !mentionsNoRowsCode(node.expression) &&
        !mentionsNoRowsCode(node.thenStatement)
      ) {
        findings.push({ file: relative, line: lineOf(node), rule: 'A', text: node.expression.getText(source) });
      }
    }

    // (B) .single() のすぐ後ろの if が 404 を返す
    if (isSingleCall(node)) {
      const statement = enclosingStatement(node);
      if (statement) {
        const siblings = siblingStatements(statement);
        const index = siblings.indexOf(statement);
        for (const next of siblings.slice(index + 1, index + 1 + FOLLOWING_STATEMENTS)) {
          if (
            ts.isIfStatement(next) &&
            returnsNotFound(next.thenStatement) &&
            !mentionsNoRowsCode(next.expression) &&
            !mentionsNoRowsCode(next.thenStatement)
          ) {
            findings.push({ file: relative, line: lineOf(next), rule: 'B', text: next.expression.getText(source) });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** 検査そのものが働くことを確かめるための、直す前の書き方の見本 */
function scanSnippet(code: string): Finding[] {
  return scanSource(code, 'snippet/route.ts');
}

describe('API の route が DB の読み込みの失敗を 404 にしない (#1917)', () => {
  it('src/app/api の全 route に、DB の失敗を 404 にする書き方が無い', () => {
    const files = listRouteFiles(path.join(ROOT, SCAN_ROOT));
    expect(files.length).toBeGreaterThan(0);
    const findings = files.flatMap(scanFile);
    expect(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.text}`)).toEqual([]);
  });

  it('(A) error と行の有無を || でつないで 404 にする書き方を見つける', () => {
    const findings = scanSnippet(`
      export async function GET() {
        const { data: row, error } = await db.from('t').select('*').eq('id', id).maybeSingle();
        if (error || !row) {
          return NextResponse.json({ error: 'x' }, { status: 404 });
        }
        return NextResponse.json(row);
      }
    `);
    expect(findings.map((f) => f.rule)).toEqual(['A']);
  });

  it('(B) .single() の error を見ずに、行が無いときに 404 にする書き方を見つける', () => {
    const findings = scanSnippet(`
      export async function GET() {
        const { data: row } = await db.from('t').select('*').eq('id', id).single();

        if (!row) {
          return NextResponse.json({ error: 'x' }, { status: 404 });
        }
        return NextResponse.json(row);
      }
    `);
    expect(findings.map((f) => f.rule)).toEqual(['B']);
  });

  it('maybeSingle で読み、error は 500・行が無いときだけ 404 にする書き方は数えない', () => {
    const findings = scanSnippet(`
      export async function GET() {
        const { data: row, error } = await db.from('t').select('*').eq('id', id).maybeSingle();
        if (error) {
          return internalError('GET /x', error);
        }
        if (!row) {
          return NextResponse.json({ error: 'x' }, { status: 404 });
        }
        return NextResponse.json(row);
      }
    `);
    expect(findings).toEqual([]);
  });

  it('.single() の失敗のうち PGRST116 だけを 404 にする書き方は数えない', () => {
    const findings = scanSnippet(`
      export async function PATCH() {
        const { data, error } = await db.from('t').update(v).eq('id', id).select().single();
        if (error) {
          if (error.code === 'PGRST116') {
            return NextResponse.json({ error: 'x' }, { status: 404 });
          }
          return internalError('PATCH /x', error);
        }
        return NextResponse.json(data);
      }
    `);
    expect(findings).toEqual([]);
  });
});
