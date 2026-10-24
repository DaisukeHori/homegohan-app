// @vitest-environment node
/**
 * #1917 の続き (整合 1024c): API の route が、JSON として読めない本文を 500 にしていないかの「見張り」
 *
 * 問題:
 *   `const body = await request.json()` を route 全体の try の中で読むと、壊れた JSON の例外が catch の internalError に流れ、
 *   呼び出し元の入力の誤りが 500 (処理中にエラー) になる。構造化ログにも内部エラーとして残る
 *   (レシピ・コメント・買い物リストの route などで見つかった。docs/design/cross/04-api-conventions.md §5.2 の
 *   「JSON として読めない本文を 500 にしない」に合わない)。
 *
 * 決まり (直し方): 本文は次のどれかで読む。
 *   - `await request.json().catch(() => null)` で読み、読めなかったとき (null・オブジェクトでない) を 400 にする
 *     (flat の route は `{ error: API_INVALID_JSON_MESSAGE }`、nested の route は invalidJsonNested())
 *   - readJsonBody (src/lib/http-params.ts) で読み、`{ ok: false }` を 400 にする
 *   - 本文を読む 1 文だけを try で包み、catch で 400 を返すか、既定の値にする
 *   (route 全体の catch が 500 にせず、その route の決まった応答を返すもの (POST /api/ai/hint の固定のヒント (#1327)) はそのまま)
 *
 * 数えるもの (TypeScript の構文木で読む。コメント・文字列の中は見ない):
 *   src/app/api 配下の `request.json()` / `req.json()` の呼び出しのうち、`.catch(...)` を続けず、
 *   いちばん内側の try の本体が 2 文以上 (本文の読み込み以外の処理も包む) で、その catch が 500 にするもの
 *   (catch の中に internalError・500 の数字・INTERNAL_ERROR・throw があり、400 の数字・INVALID_JSON・invalidJson の名前が無いもの)。
 *   try の外で読むもの (例外がそのまま route の外へ出て 500 になる) も数える。
 *
 * この検査の限界 (捕まえない書き方):
 *   - request を別の名前の変数に入れてから読むもの (`const r = request; await r.json()`)
 *   - `.catch(...)` の中で例外を投げ直すもの、既定の値が後ろで 500 になるもの
 *   - src/lib のヘルパーの中で本文を読むもの
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/api';

/** 本文を読む値の名前 */
const REQUEST_NAMES = new Set(['request', 'req']);
/** catch が 400 (入力の誤り) を返していると見なす印 */
const BAD_REQUEST_MARK = /\b400\b|INVALID_JSON|invalidJson/;
/** catch が 500 にしている (または外へ投げ直す) と見なす印 */
const INTERNAL_ERROR_MARK = /internalError|\b500\b|INTERNAL_ERROR|\bthrow\b/;
/** 本文の読み込みだけを包む try の本体の文の数 */
const DEDICATED_TRY_STATEMENTS = 1;

interface Finding {
  file: string;
  line: number;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** `request.json()` (引数なし) の呼び出しか */
function isRequestJsonCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'json' &&
    ts.isIdentifier(node.expression.expression) &&
    REQUEST_NAMES.has(node.expression.expression.text)
  );
}

/** 呼び出しに `.catch(...)` が続いているか */
function isFollowedByCatch(call: ts.CallExpression): boolean {
  const parent = call.parent;
  return ts.isPropertyAccessExpression(parent) && parent.name.text === 'catch';
}

/** いちばん内側の try (同じ関数の中で、呼び出しが try の本体にあるもの) が、読めない本文を 500 にしない形か (本文だけを包む・catch が 400 か 500 以外の決まった応答) */
function isGuardedByTry(call: ts.CallExpression, source: ts.SourceFile): boolean {
  let current: ts.Node = call;
  while (current.parent && !ts.isFunctionLike(current.parent)) {
    const parent: ts.Node = current.parent;
    if (ts.isTryStatement(parent) && parent.tryBlock === current) {
      if (parent.tryBlock.statements.length === DEDICATED_TRY_STATEMENTS) return true;
      // catch の無い try (finally だけ) は、例外がそのまま外へ出て 500 になる
      if (!parent.catchClause) return false;
      const catchText = parent.catchClause.block.getText(source);
      return BAD_REQUEST_MARK.test(catchText) || !INTERNAL_ERROR_MARK.test(catchText);
    }
    current = parent;
  }
  return false;
}

function scanSource(text: string, relative: string): Finding[] {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (isRequestJsonCall(node) && !isFollowedByCatch(node) && !isGuardedByTry(node, source)) {
      findings.push({ file: relative, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function scanSnippet(code: string): Finding[] {
  return scanSource(code, 'snippet/route.ts');
}

describe('API の route が JSON として読めない本文を 500 にしない (#1917 の続き)', () => {
  it('src/app/api の全ファイルに、本文を route 全体の try で読んで 500 にする書き方が無い', () => {
    const files = listSourceFiles(path.join(ROOT, SCAN_ROOT));
    expect(files.length).toBeGreaterThan(0);
    const findings = files.flatMap((file) => scanSource(fs.readFileSync(file, 'utf-8'), path.relative(ROOT, file)));
    expect(findings.map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it('route 全体の try の中で本文を読み、catch が 500 にする書き方を見つける', () => {
    const findings = scanSnippet(`
      export async function POST(request: Request) {
        try {
          const body = await request.json();
          await db.from('t').insert(body);
          return NextResponse.json({ ok: true });
        } catch (error) {
          return internalError('POST /x', error);
        }
      }
    `);
    expect(findings.map((f) => f.line)).toEqual([4]);
  });

  it('try の外で本文を読む書き方を見つける', () => {
    const findings = scanSnippet(`
      export async function POST(req: Request) {
        const { a } = await req.json();
        return NextResponse.json({ a });
      }
    `);
    expect(findings.map((f) => f.line)).toEqual([3]);
  });

  it('route 全体の try の catch が 500 にせず、決まった応答を返す書き方は数えない', () => {
    const findings = scanSnippet(`
      export async function POST(request: Request) {
        try {
          const { a } = await request.json();
          return NextResponse.json({ hint: hintOf(a) });
        } catch (error) {
          return NextResponse.json({ hint: '固定のヒント' });
        }
      }
    `);
    expect(findings).toEqual([]);
  });

  it('catch で投げ直す書き方は見つける', () => {
    const findings = scanSnippet(`
      export async function POST(request: Request) {
        try {
          const body = await request.json();
          return NextResponse.json(await save(body));
        } catch (error) {
          throw error;
        }
      }
    `);
    expect(findings.map((f) => f.line)).toEqual([4]);
  });

  it('.catch で受ける書き方・本文だけを包む try・catch が 400 を返す try は数えない', () => {
    const findings = scanSnippet(`
      export async function POST(request: Request) {
        const a = await request.json().catch(() => null);
        if (!a || typeof a !== 'object') return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
        let b: unknown;
        try {
          b = await request.json();
        } catch {
          b = {};
        }
        try {
          const c = await request.json();
          await db.from('t').insert(c);
        } catch {
          return invalidJsonNested();
        }
        return NextResponse.json({ a, b });
      }
    `);
    expect(findings).toEqual([]);
  });
});
