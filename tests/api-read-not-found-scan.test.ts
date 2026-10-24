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
 *   (C) `.maybeSingle()` の結果を `const { data: row } = ...` と error を受けずに分割代入し、すぐ後ろ
 *       (同じブロックの次の FOLLOWING_STATEMENTS 文) の if が 404 を返すもの
 *       (maybeSingle は行が無いと data が null で error も null だが、DB の失敗でも data は null になる。
 *       error を受けないと失敗が「無い」と見分けられず 404 になる。health/checkups/[id] の PUT・DELETE で見つかった形)
 *   どちらも、その if の条件か then の側で PGRST116 を見分けているもの (`if (error.code === 'PGRST116') return 404`) は数えない
 *   (行が無い失敗だけを 404 にし、ほかの失敗を 500 にする書き方)。(B)・(C) の if の条件がエラーの code を比べているもの
 *   (`if (error?.code === POSTGRES_FOREIGN_KEY_VIOLATION && ...) return 404`。保存の参照先が無い外部キー違反だけを 404 にする。
 *   POST /api/recipes/[id]/comments) も数えない (特定の失敗だけを見分けていて、ほかの失敗は 404 にならない)。
 *
 * この検査の限界 (捕まえない書き方。網羅は目指さない):
 *   - 404 を返す関数を呼ぶだけで、then の側に 404 の数字が出てこないもの (`if (error || !row) return notFound()`)
 *   - エラーらしくない名前の値 (`const { data, error: failure } = ...; if (failure || !data)`)
 *   - `.single()` の結果を変数に入れてから、FOLLOWING_STATEMENTS 文より後ろで 404 にするもの
 *   - `.maybeSingle()` の結果を分割代入せずに変数に入れるもの (`const res = ...; if (!res.data) return 404`)、
 *     error を受けていても 404 の if より後ろで見るもの (`if (!row) return 404; if (error) ...`)
 *   - src/app/api の外 (src/lib) のヘルパーの中で、DB の失敗を「無い」と同じに扱うもの
 *     (例: src/lib/handson-tour/sandbox-eligibility.ts は読めないときも profile_not_found にする fail-closed の判定)
 *
 * 走査の対象は src/app/api 配下の全ファイル (テストを除く)。1 件でもあれば失敗する。
 *
 * (D) パスの id を DB に渡す前に形を確かめているか (#1917 の続き。整合 1024c):
 *   動的なパス ([id] など) の route.ts の HTTP の handler (GET / POST / PUT / PATCH / DELETE) のうち、パスの値 (第 2 引数) を受け取り、
 *   handler の中で `.from(...)` か `.rpc(...)` を呼ぶものは、パスの値を引数にして isUuid / normalizeUuid を呼ぶか、`.safeParse(...)` で
 *   id を検証する (route の正典が UUID でない id を 400 と決めているもの) か、UUID の正規表現 (UUID_RE など) で確かめていること。
 *   「パスの値を引数にして」= 引数の中に `params` か、`params` から取り出した変数 (`const { id } = await params` の id など) の名前があること。
 *   本文の `.safeParse(body)` だけの handler は、確かめていない側に数える。
 *   パスの値が uuid の列に届かない (文字列の列・日付・トークン) handler や、所属の操作の route (code の体系が正典で別に決まる) は
 *   PATH_ID_CHECK_EXCLUDED に理由つきで載せる。載せた handler が検査を持つようになったら (または消えたら)、載せたままを失敗にする。
 *   限界: handler が呼ぶ関数 (src/lib・同じファイルの関数) の中で DB に渡すもの (`.from` を handler に書かないもの) は見ない。
 *   この形は #1917 の続きで手で洗った (admin/moderation/[type]/[id] の GET・POST・PUT・restore の POST と super-admin/coupons/[id]/apply の POST は
 *   isUuid を足した。account/data-requests/[id] は parseDsrId・admin/users/[id]/role は handleRoleChange の中・super-admin/users/[id]/manual-plan は
 *   targetIdOf・admin/inquiries/[id] は updateInquiry の中で確かめている)。
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
  rule: 'A' | 'B' | 'C';
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

/** 式の中に、エラーらしい名前の値の code を === / == で比べるところがあるか (`error?.code === X`) */
function comparesErrorCode(expr: ts.Node): boolean {
  let found = false;
  const isErrorCode = (n: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(n) && n.name.text === 'code' && isErrorValue(n.expression);
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      (isErrorCode(n.left) || isErrorCode(n.right))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
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

/** `X.maybeSingle()` の呼び出しか */
function isMaybeSingleCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'maybeSingle'
  );
}

/** 分割代入の項の、元のプロパティの名前 (`{ data: row }` の data・`{ error }` の error) */
function bindingPropertyName(element: ts.BindingElement): string | null {
  const name = element.propertyName ?? element.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** 文が `const { data..., (error なし) } = ...` の形の変数宣言か (data を受けて error を受けない) */
function destructuresDataWithoutError(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement)) return false;
  return statement.declarationList.declarations.some((declaration) => {
    if (!ts.isObjectBindingPattern(declaration.name)) return false;
    const names = declaration.name.elements.map(bindingPropertyName);
    return names.includes('data') && !names.includes('error');
  });
}

/** 文の後ろ FOLLOWING_STATEMENTS 文のうち、404 を返す if (PGRST116 を見分けているものを除く) */
function notFoundIfsAfter(statement: ts.Statement): ts.IfStatement[] {
  const siblings = siblingStatements(statement);
  const index = siblings.indexOf(statement);
  return siblings
    .slice(index + 1, index + 1 + FOLLOWING_STATEMENTS)
    .filter(
      (next): next is ts.IfStatement =>
        ts.isIfStatement(next) &&
        returnsNotFound(next.thenStatement) &&
        !mentionsNoRowsCode(next.expression) &&
        !mentionsNoRowsCode(next.thenStatement) &&
        !comparesErrorCode(next.expression),
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

/** HTTP の handler の名前 */
const HTTP_HANDLER_NAMES = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** パスの値 (context) を受け取る handler の引数の数 (request と context) */
const HANDLER_WITH_CONTEXT_PARAMS = 2;

/**
 * (D) の理由: 家族・組織の所属の操作と運営の所属の操作の route。4xx を nested の形の MembershipErrorCode / OP の code で返し、
 * UUID でない id (招待の [id] はトークンのものもある) をどの code・状態で返すかは各正典 (family・org・operator) の決定が要る。
 * #1917 の続き (整合 1024c) の範囲の外にし、別に扱う
 */
const MEMBERSHIP_ROUTE_REASON = '所属の操作の route (nested の code の体系。UUID でない id の扱いは family・org・operator の正典の決定が要る)';

/**
 * (D) パスの値を DB に渡すが、形を確かめなくてよい handler (`<src/app/api からのパス> <メソッド>`) と理由
 */
const PATH_ID_CHECK_EXCLUDED: Record<string, string> = {
  'admin/finance/invoices/[id]/route.ts GET': 'id は Stripe のイベント ID で、stripe_webhook_events.id は文字列の列',
  'experiments/[key]/assignment/route.ts GET': 'key は実験の名前で、文字列の列を引く',
  'super-admin/flags/[key]/route.ts DELETE': 'key は機能フラグの名前で、文字列の列を引く',
  'super-admin/flags/[key]/route.ts PATCH': 'key は機能フラグの名前で、文字列の列を引く',
  'health/records/[date]/route.ts GET': 'パスの値は日付で、RECORD_DATE_PATTERN と isCalendarDate で確かめて 400 にする',
  'health/records/[date]/route.ts PUT': 'パスの値は日付で、RECORD_DATE_PATTERN と isCalendarDate で確かめて 400 にする',
  'health/records/[date]/route.ts DELETE': 'パスの値は日付で、RECORD_DATE_PATTERN と isCalendarDate で確かめて 400 にする',
  'family/invites/[id]/reject/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'family/invites/[id]/revoke/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'family/members/[member_id]/remove/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'family/representative-transfer/[id]/accept/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'family/representative-transfer/[id]/decline/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'org/invites/[id]/accept/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'org/invites/[id]/reject/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'org/invites/[id]/revoke/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'org/members/[user_id]/remove/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'org/owner-transfer/[id]/accept/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'org/owner-transfer/[id]/decline/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'operator/membership/family/[id]/candidates/route.ts GET': MEMBERSHIP_ROUTE_REASON,
  'operator/membership/org/[id]/candidates/route.ts GET': MEMBERSHIP_ROUTE_REASON,
  'operator/membership/family/[id]/dissolve/route.ts POST': MEMBERSHIP_ROUTE_REASON,
  'operator/membership/org/[id]/dissolve/route.ts POST': MEMBERSHIP_ROUTE_REASON,
};

interface PathIdHandler {
  key: string;
  checked: boolean;
}

/** 束縛 (変数名・分割代入) が作る名前を集める */
function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, out);
  }
}

/** ノードの中に、names のどれかの名前の識別子があるか */
function mentionsAnyName(node: ts.Node, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node) && names.has(node.text)) return true;
  return ts.forEachChild(node, (child) => mentionsAnyName(child, names) || undefined) ?? false;
}

/**
 * handler の中でパスの値を指す名前: `params` と、`params` (またはそこから取り出した変数) から作った変数
 * (`const { id } = await params` の id・`const { id: familyId } = params` の familyId・`const id = (await props.params).id` の id など)
 */
function pathValueNames(body: ts.Node): Set<string> {
  const names = new Set<string>(['params']);
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && mentionsAnyName(n.initializer, names)) {
      collectBindingNames(n.name, names);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return names;
}

/**
 * handler の中の呼び出しを調べる: DB に触るか (`.from` / `.rpc`)、パスの値の形を確かめるか。
 * 確かめる呼び出し (isUuid・normalizeUuid・`.safeParse`・UUID の正規表現の `.test`) は、引数にパスの値の名前があるときだけ数える
 * (本文の `.safeParse(body)` だけでは、パスの値を確かめたことにならない)
 */
function inspectHandler(body: ts.Node): { touchesDb: boolean; checked: boolean } {
  const pathNames = pathValueNames(body);
  const checksPathValue = (call: ts.CallExpression): boolean => call.arguments.some((arg) => mentionsAnyName(arg, pathNames));
  let touchesDb = false;
  let checked = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && (callee.text === 'isUuid' || callee.text === 'normalizeUuid') && checksPathValue(n)) checked = true;
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        if (name === 'from' || name === 'rpc') touchesDb = true;
        if (name === 'safeParse' && checksPathValue(n)) checked = true;
        if (name === 'test' && ts.isIdentifier(callee.expression) && /UUID/i.test(callee.expression.text) && checksPathValue(n)) checked = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return { touchesDb, checked };
}

/** 動的なパスの route.ts の、パスの値を受け取って DB に触る handler の一覧 */
function pathIdHandlers(text: string, relativeToApi: string): PathIdHandler[] {
  const source = ts.createSourceFile(relativeToApi, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: PathIdHandler[] = [];
  const consider = (name: string, fn: ts.Node | undefined, paramCount: number): void => {
    if (!fn || !HTTP_HANDLER_NAMES.has(name) || paramCount < HANDLER_WITH_CONTEXT_PARAMS) return;
    const { touchesDb, checked } = inspectHandler(fn);
    if (touchesDb) out.push({ key: `${relativeToApi} ${name}`, checked });
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      consider(statement.name.text, statement.body, statement.parameters.length);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) || !init) continue;
        const paramCount = ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init.parameters.length : HANDLER_WITH_CONTEXT_PARAMS;
        consider(declaration.name.text, init, paramCount);
      }
    }
  }
  return out;
}

/** 動的なパス (`[...]` を含むディレクトリ) の route.ts か */
function isDynamicRouteFile(relativeToApi: string): boolean {
  return /(^|\/)\[[^\]]+\]\//.test(relativeToApi) && relativeToApi.endsWith('/route.ts');
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
        for (const next of notFoundIfsAfter(statement)) {
          findings.push({ file: relative, line: lineOf(next), rule: 'B', text: next.expression.getText(source) });
        }
      }
    }

    // (C) .maybeSingle() を error を受けずに分割代入し、すぐ後ろの if が 404 を返す
    if (isMaybeSingleCall(node)) {
      const statement = enclosingStatement(node);
      if (statement && destructuresDataWithoutError(statement)) {
        for (const next of notFoundIfsAfter(statement)) {
          findings.push({ file: relative, line: lineOf(next), rule: 'C', text: next.expression.getText(source) });
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

  it('(C) .maybeSingle() の error を受けずに、行が無いときに 404 にする書き方を見つける', () => {
    const findings = scanSnippet(`
      export async function PUT() {
        const { data: existing } = await db.from('t').select('id').eq('id', id).maybeSingle();

        if (!existing) {
          return NextResponse.json({ error: 'x' }, { status: 404 });
        }
        return NextResponse.json(existing);
      }
    `);
    expect(findings.map((f) => f.rule)).toEqual(['C']);
  });

  it('(C) .maybeSingle() の error を別の名前で受けて先に 500 にする書き方は数えない', () => {
    const findings = scanSnippet(`
      export async function DELETE() {
        const { data: existing, error: existingError } = await db.from('t').select('id').eq('id', id).maybeSingle();
        if (existingError) {
          return internalError('DELETE /x', existingError);
        }
        if (!existing) {
          return NextResponse.json({ error: 'x' }, { status: 404 });
        }
        return NextResponse.json(existing);
      }
    `);
    expect(findings).toEqual([]);
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

  it('(B) .single() の失敗のうち、エラーの code を比べて特定の失敗 (外部キー違反) だけを 404 にする書き方は数えない', () => {
    const findings = scanSnippet(`
      export async function POST() {
        const { data, error } = await db.from('t').insert(v).select('id').single();
        if (error?.code === FOREIGN_KEY_VIOLATION && error.message.includes('t_parent_id_fkey')) {
          return NextResponse.json({ error: 'x' }, { status: 404 });
        }
        if (error) throw error;
        return NextResponse.json(data);
      }
    `);
    expect(findings).toEqual([]);
  });

  it('(B) .single() のあとで、code を比べずに error だけで 404 にする書き方は見つける', () => {
    const findings = scanSnippet(`
      export async function POST() {
        const { data, error } = await db.from('t').insert(v).select('id').single();
        if (error) {
          return NextResponse.json({ error: 'x' }, { status: 404 });
        }
        return NextResponse.json(data);
      }
    `);
    expect(findings.map((f) => f.rule)).toEqual(['B']);
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
  it('(D) 動的なパスの handler は、パスの値を DB に渡す前に形を確かめる (除外は理由つきの表だけ)', () => {
    const apiRoot = path.join(ROOT, SCAN_ROOT);
    const handlers = listRouteFiles(apiRoot)
      .map((file) => ({ file, relativeToApi: path.relative(apiRoot, file).split(path.sep).join('/') }))
      .filter(({ relativeToApi }) => isDynamicRouteFile(relativeToApi))
      .flatMap(({ file, relativeToApi }) => pathIdHandlers(fs.readFileSync(file, 'utf-8'), relativeToApi));
    expect(handlers.length).toBeGreaterThan(0);

    const unchecked = handlers.filter((h) => !h.checked).map((h) => h.key);
    expect(unchecked.filter((key) => !(key in PATH_ID_CHECK_EXCLUDED))).toEqual([]);
    // 表に載せたままの handler が検査を持つようになった・消えたら、表から外す
    expect(Object.keys(PATH_ID_CHECK_EXCLUDED).filter((key) => !unchecked.includes(key))).toEqual([]);
  });

  it('(D) パスの値を受け取って DB に触るのに形を確かめない handler を見つけ、確かめる handler は数えない', () => {
    const unchecked = pathIdHandlers(
      `
      export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
        const params = await props.params;
        const { error } = await supabase.from('t').delete().eq('id', params.id);
        return NextResponse.json({ success: !error });
      }
      export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
        const params = await props.params;
        if (!isUuid(params.id)) return NextResponse.json({ error: 'x' }, { status: 404 });
        const { error } = await supabase.from('t').update({}).eq('id', params.id);
        return NextResponse.json({ success: !error });
      }
      export async function GET(request: Request) {
        const { data } = await supabase.from('t').select('*');
        return NextResponse.json(data);
      }
      `,
      'snippet/[id]/route.ts',
    );
    expect(unchecked).toEqual([
      { key: 'snippet/[id]/route.ts DELETE', checked: false },
      { key: 'snippet/[id]/route.ts PATCH', checked: true },
    ]);
  });

  it('(D) 本文だけを確かめる handler は確かめていない側に、パスの値から取り出した変数を確かめる handler は確かめた側に数える', () => {
    const handlers = pathIdHandlers(
      `
      export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
        const params = await props.params;
        const parsed = BodySchema.safeParse(await request.json());
        if (!parsed.success || !isUuid(parsed.data.member_id)) return NextResponse.json({ error: 'x' }, { status: 400 });
        const { error } = await supabase.from('t').delete().eq('id', params.id);
        return NextResponse.json({ success: !error });
      }
      export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
        const { id: rowId } = await props.params;
        if (!IdSchema.safeParse(rowId).success) return NextResponse.json({ error: 'x' }, { status: 400 });
        const { error } = await supabase.from('t').update({}).eq('id', rowId);
        return NextResponse.json({ success: !error });
      }
      export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
        const { id } = await params;
        const normalized = id.trim();
        if (!UUID_RE.test(normalized)) return NextResponse.json({ error: 'x' }, { status: 404 });
        const { error } = await supabase.from('t').delete().eq('id', normalized);
        return NextResponse.json({ success: !error });
      }
      `,
      'snippet/[id]/route.ts',
    );
    expect(handlers).toEqual([
      { key: 'snippet/[id]/route.ts POST', checked: false },
      { key: 'snippet/[id]/route.ts PUT', checked: true },
      { key: 'snippet/[id]/route.ts DELETE', checked: true },
    ]);
    expect(isDynamicRouteFile('snippet/[id]/route.ts')).toBe(true);
    expect(isDynamicRouteFile('snippet/route.ts')).toBe(false);
  });
});
