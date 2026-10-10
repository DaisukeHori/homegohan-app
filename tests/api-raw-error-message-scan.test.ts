// @vitest-environment node
/**
 * #1172 API の応答の本文に、DB の生のエラー文 (message / details / hint) や例外の文面を入れていないことのソース走査テスト
 *
 * 問題:
 *   route が `NextResponse.json({ error: error.message }, { status: 500 })` と書くと、DB (Supabase / PostgREST) が返した
 *   生のエラー文 (テーブル名・列名・制約名・接続先。UNIQUE 違反なら衝突した値) がそのままブラウザ・モバイルに返る。
 *   攻撃の手がかりになり、個人情報が出ることもある。
 *   CLAUDE.md の方針は「500 の本文は汎用メッセージだけにし、詳細は構造化ログに残す」。
 *   共通ヘルパー internalError() (src/lib/api/errors.ts) がこの 2 つを一度に行う。
 *
 * 経緯:
 *   第 1 段 (#1398) で internalError() と、このテストを「許可リスト (既存の違反の件数) から増やさない」歯止めとして入れた。
 *   第 2 段で src/app/api の残りを全部直し、許可リストを空にした。いまは「1 件でもあれば失敗」。
 *
 * 何を違反として数えるか (TypeScript の構文木で解析するので、コメントや文字列の中は見ない):
 *   応答の本文に、エラー由来の値が入っているもの。1 回の応答を 1 件と数える (本文に何か所入っていても 1 件)。
 *   応答の本文 =
 *     - `NextResponse.json(body, init)` / `Response.json(body, init)` の body
 *     - ストリーム (SSE) や `new Response(...)` に流す `JSON.stringify(body)` の body
 *       (`controller.enqueue(...)` / `writer.write(...)` / `new Response(...)` / `new NextResponse(...)` の引数の中にあるもの)
 *   エラー由来の値 =
 *     - `.message` / `.details` / `.hint` (PostgREST のエラーの 3 つの文面):
 *       `error.message` / `err?.details` / `(e as Error).message` / `result.error.hint` / `error['message']`
 *     - `String(error)` / `JSON.stringify(error)`
 *     - エラーのオブジェクトそのもの (`{ error }` / `{ error: insertError }` / `[err]`)。JSON にすると message / details / hint が出る。
 *       名前だけでは文字列の変数と区別できないので、catch で受けた変数と、await の結果から取り出した `error`
 *       (`const { error } = await supabase...` / `const { error: rpcError } = await ...`) に限る
 *     - 上のどれかを入れた変数 (`const message = error instanceof Error ? error.message : '...'` のあと `{ error: message }`)。
 *       同じ関数の中で、本文より前に宣言された const / let を最大 3 段までたどる。`const { message } = error` も同じ
 *   「エラー」の判定は名前で行う: `e` / `err` / `error` / `exception` / `ex`、または `Error` / `Err` で終わる名前
 *   (`insertError` / `rpcError` / `uploadError`)、または `.error` / `.xxxError` のプロパティ (`result.error` / `parsed.error`)。
 *
 * 数えないもの:
 *   - ステータスが 4xx だと分かる応答で、エラーが DB の結果ではないもの。
 *     AuthError / ForbiddenError の文面 (401 / 403) や zod の検証メッセージ (400) のように、こちらが書いた文面を返す経路のため。
 *     ステータスは、リテラル (400〜499)・その分岐 (`a ? 403 : 400`)・それを入れた const (`const status = a ? 404 : 422`) から読む。
 *   - ただし DB の結果 (await の結果から取り出した error。`const { error } = await supabase...` / `const r = await ...; r.error`)
 *     の文面は、4xx でも違反として数える (DB の生のエラー文は、ステータスに関わらず利用者に見せない)。
 *   - ステータスが分からない応答 (`{ status: mapped }` など) は「違反」として数える (安全側)。
 *
 * 見ないもの (検出できない書き方。レビューで見る):
 *   別の関数に message を渡して、その中で JSON にする / 後から代入する `let message; message = error.message` /
 *   エラーらしくない名前の変数 (`catch (reason)` の外で `const reason = ...` など) / DB に保存した文面をあとで返す。
 *
 * 直し方: route では `return internalError('GET /api/xxx', error, { userId: user.id })`
 *   (src/lib/api/errors.ts)。本文は汎用メッセージだけになり、元のエラーは構造化ログ (app_logs) に残る。
 *   運営 API のように `error.message` を読むクライアントには `{ shape: 'nested' }` を渡す。
 *   4xx で利用者に理由を伝えたいときは、こちらで決めた固定の文を返す (DB の文面を加工して返さない)。
 *
 * 走査の対象は src/app/api 配下の全ファイル (テストを除く)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/api';

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────
interface Finding {
  line: number;
  text: string;
}

const JSON_RESPONSE_OBJECTS = new Set(['NextResponse', 'Response']);
/** エラーを受ける変数の名前: e / err / error / exception / ex、または Error / Err で終わる名前 */
const ERROR_NAME = /^(?:e|err|error|exception|ex)$|(?:Error|Err)$/;
/** PostgREST のエラーが文面を持つプロパティ (例外の Error も message を持つ) */
const RAW_TEXT_PROPERTIES = new Set(['message', 'details', 'hint']);
/** ストリームに書く・応答を作る呼び出し (この引数の中の JSON.stringify(...) は応答の本文) */
const STREAM_WRITE_METHODS = new Set(['enqueue', 'write']);
/** 変数をたどる段数の上限 (const a = e.message; const b = a; ... の連鎖) */
const MAX_RESOLVE_DEPTH = 3;

/** 括弧・非 null アサーション・型アサーションを外す */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** エラーを受けている値か: `error` / `insertError` / `result.error` / `state.insertError` */
function isErrorLike(expr: ts.Expression): boolean {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return ERROR_NAME.test(inner.text);
  if (ts.isPropertyAccessExpression(inner)) return ERROR_NAME.test(inner.name.text);
  return false;
}

/** `error.message` / `err?.details` / `result.error.hint` / `error['message']` なら、そのエラーの式を返す */
function rawTextAccessBase(node: ts.Node): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node) && RAW_TEXT_PROPERTIES.has(node.name.text) && isErrorLike(node.expression)) {
    return node.expression;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    RAW_TEXT_PROPERTIES.has(node.argumentExpression.text) &&
    isErrorLike(node.expression)
  ) {
    return node.expression;
  }
  return undefined;
}

/** 識別子が「値としての参照」か。プロパティ名・オブジェクトリテラルのキー・宣言の名前は参照ではない */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
    if (parent.name === id) return false;
  }
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  return true;
}

function statementsOf(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return undefined;
}

/** 変数の宣言。分割代入なら、取り出したプロパティの名前 (`{ error: rpcError }` なら 'error') も持つ */
interface Declaration {
  initializer: ts.Expression | undefined;
  /** 分割代入 `{ a: b } = x` で取り出したプロパティの名前。配列の分割代入なら '[]'。ふつうの宣言なら undefined */
  bindingProperty?: string;
  /** catch (e) の e */
  isCatchVariable?: boolean;
}

/**
 * 識別子の、直前までに見える宣言。いちばん内側のスコープで最初に見つかったもので決める (外側の同名の変数は影になる)。
 * catch 節の変数も見る。
 */
function findDeclaration(id: ts.Identifier): Declaration | undefined {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isCatchClause(scope)) {
      const variable = scope.variableDeclaration;
      if (variable && ts.isIdentifier(variable.name) && variable.name.text === id.text) {
        return { initializer: undefined, isCatchVariable: true };
      }
      continue;
    }
    const statements = statementsOf(scope);
    if (!statements) continue;

    let decided: Declaration | undefined;
    for (const statement of statements) {
      if (statement.end > id.getStart()) break;
      if (!ts.isVariableStatement(statement)) continue;

      for (const declaration of statement.declarationList.declarations) {
        const { name, initializer } = declaration;
        if (ts.isIdentifier(name) && name.text === id.text) {
          decided = { initializer };
        } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
          const found = findInBindingPattern(name, id.text);
          if (found !== undefined) decided = { initializer, bindingProperty: found };
        }
      }
    }
    if (decided) return decided;
  }
  return undefined;
}

/** 分割代入の中から名前を探し、取り出したプロパティの名前を返す (入れ子は外側のプロパティ名)。無ければ undefined */
function findInBindingPattern(pattern: ts.BindingPattern, name: string): string | undefined {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const property = ts.isObjectBindingPattern(pattern)
      ? (() => {
          const key = element.propertyName ?? element.name;
          return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : '';
        })()
      : '[]';
    if (ts.isIdentifier(element.name)) {
      if (element.name.text === name) return property;
    } else if (findInBindingPattern(element.name, name) !== undefined) {
      return property;
    }
  }
  return undefined;
}

/** await の結果か (`await supabase.from(...)` / `await Promise.all([...])`) */
function isAwaited(expr: ts.Expression | undefined): boolean {
  return !!expr && ts.isAwaitExpression(unwrap(expr));
}

/**
 * DB などの結果 (await の結果) から取り出したエラーか。
 *   `const { error } = await supabase...` の error / `const { error: rpcError } = await ...` の rpcError /
 *   `const result = await ...; result.error` / `const [a] = await Promise.all(...); a.error`
 */
function isAwaitedResultError(expr: ts.Expression): boolean {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) {
    const declaration = findDeclaration(inner);
    return !!declaration && declaration.bindingProperty !== undefined && isAwaited(declaration.initializer);
  }
  if (ts.isPropertyAccessExpression(inner)) {
    let root: ts.Expression = unwrap(inner.expression);
    while (ts.isPropertyAccessExpression(root)) root = unwrap(root.expression);
    if (!ts.isIdentifier(root)) return false;
    const declaration = findDeclaration(root);
    return !!declaration && isAwaited(declaration.initializer);
  }
  return false;
}

/** エラーのオブジェクトそのものが入る値か (catch の変数・await の結果から取り出した error) */
function isRawErrorObject(id: ts.Identifier): boolean {
  if (!ERROR_NAME.test(id.text)) return false;
  const declaration = findDeclaration(id);
  if (!declaration) return false;
  if (declaration.isCatchVariable) return true;
  return declaration.bindingProperty !== undefined && isAwaited(declaration.initializer);
}

/** 値として本文に「そのまま」出る位置か (`{ error }` / `{ error: x }` / `[x]` / `...x` / `${x}`) */
function isEmittedAsValue(node: ts.Expression): boolean {
  let current: ts.Node = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isNonNullExpression(current.parent))) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === current;
  if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) return true;
  if (ts.isTemplateSpan(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    // `'失敗: ' + error` / `error ?? 'x'` / `error || 'x'`
    const operator = parent.operatorToken.kind;
    return (
      operator === ts.SyntaxKind.PlusToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken
    );
  }
  if (ts.isConditionalExpression(parent)) return parent.whenTrue === current || parent.whenFalse === current;
  return false;
}

/** `String(x)` / `JSON.stringify(x)` の x か */
function isStringifiedArgument(node: ts.Expression): ts.CallExpression | undefined {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent) || parent.arguments[0] !== node) return undefined;
  const callee = parent.expression;
  if (ts.isIdentifier(callee) && callee.text === 'String') return parent;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON' &&
    callee.name.text === 'stringify'
  ) {
    return parent;
  }
  return undefined;
}

/** 本文の中で見つかったエラー由来の値 */
interface RawSource {
  /** エラーの式 (`error` / `result.error`) */
  base: ts.Expression;
}

/**
 * 識別子が、直前までに宣言された変数で、その値がエラー由来か。
 * いちばん内側のスコープで最初に見つかった宣言で決める (外側の同名の変数は影になる)。
 */
function identifierRawSources(id: ts.Identifier, depth: number): RawSource[] {
  const declaration = findDeclaration(id);
  if (!declaration || declaration.isCatchVariable) return [];
  if (declaration.bindingProperty !== undefined) {
    // const { message } = error / const { details: d } = err
    const { initializer } = declaration;
    if (initializer && RAW_TEXT_PROPERTIES.has(declaration.bindingProperty) && isErrorLike(initializer)) {
      return [{ base: unwrap(initializer) }];
    }
    return [];
  }
  return declaration.initializer ? rawSourcesOf(declaration.initializer, depth) : [];
}

/** 式の中の、エラー由来の値 (直接、または変数経由) */
function rawSourcesOf(root: ts.Node, depth = 0): RawSource[] {
  const sources: RawSource[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    const base = rawTextAccessBase(node);
    if (base) {
      sources.push({ base: unwrap(base) });
      return;
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      // String(err) / JSON.stringify(error) は、宣言が見えなくても名前で判定する (エラーを文字列にする書き方のため)
      if ((ERROR_NAME.test(node.text) && isStringifiedArgument(node)) || (isRawErrorObject(node) && isEmittedAsValue(node))) {
        sources.push({ base: node });
        return;
      }
      if (!ERROR_NAME.test(node.text) && depth < MAX_RESOLVE_DEPTH) {
        sources.push(...identifierRawSources(node, depth + 1));
      }
    }
    if (ts.isPropertyAccessExpression(node) && isErrorLike(node) && isStringifiedArgument(node)) {
      // String(result.error) / JSON.stringify(insertError)
      sources.push({ base: node });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return sources;
}

function isJsonResponseCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'json' &&
    ts.isIdentifier(node.expression.expression) &&
    JSON_RESPONSE_OBJECTS.has(node.expression.expression.text)
  );
}

/** `JSON.stringify(x)` が、ストリームへの書き込み・new Response(...) の引数の中にあるか */
function isStreamedJsonStringify(node: ts.Node): node is ts.CallExpression {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== 'JSON' ||
    node.expression.name.text !== 'stringify'
  ) {
    return false;
  }
  for (let current: ts.Node | undefined = node.parent; current && !ts.isStatement(current); current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      STREAM_WRITE_METHODS.has(current.expression.name.text)
    ) {
      return true;
    }
    if (
      ts.isNewExpression(current) &&
      ts.isIdentifier(current.expression) &&
      JSON_RESPONSE_OBJECTS.has(current.expression.text)
    ) {
      return true;
    }
  }
  return false;
}

/** 数値リテラル、その分岐 (`a ? 403 : 400`)、それを入れた const (`const status = a ? 404 : 422`)。分からなければ null */
function numericValues(expr: ts.Expression, depth = 0): number[] | null {
  const inner = unwrap(expr);
  if (ts.isNumericLiteral(inner)) return [Number(inner.text)];
  if (ts.isConditionalExpression(inner)) {
    const whenTrue = numericValues(inner.whenTrue, depth);
    const whenFalse = numericValues(inner.whenFalse, depth);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isIdentifier(inner) && depth < MAX_RESOLVE_DEPTH) {
    const declaration = findDeclaration(inner);
    if (declaration && declaration.bindingProperty === undefined && declaration.initializer) {
      const statement = declaration.initializer.parent?.parent;
      // let は後から書き換えられるので読まない (const だけ)
      if (statement && ts.isVariableDeclarationList(statement) && statement.flags & ts.NodeFlags.Const) {
        return numericValues(declaration.initializer, depth + 1);
      }
    }
  }
  return null;
}

/** 第 2 引数 (init) から取りうるステータスを取り出す。指定が無ければ 200。分からなければ null */
function resolveStatuses(init: ts.Expression | undefined): number[] | null {
  if (!init) return [200];
  const literal = unwrap(init);
  if (!ts.isObjectLiteralExpression(literal)) return null;

  let hasSpread = false;
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      hasSpread = true;
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'status') {
      return numericValues(property.name);
    } else if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'status'
    ) {
      return numericValues(property.initializer);
    }
  }
  return hasSpread ? null : [200];
}

/** 全ての取りうるステータスが 4xx と分かる (こちらが書いた検証メッセージなどを返す経路) */
function isClientErrorOnly(statuses: number[] | null): boolean {
  return statuses !== null && statuses.length > 0 && statuses.every((status) => status >= 400 && status < 500);
}

/** 応答の本文と、取りうるステータス (分からなければ null) */
interface ResponseBody {
  call: ts.Node;
  body: ts.Expression;
  statuses: number[] | null;
}

function responseBodiesOf(sf: ts.SourceFile): ResponseBody[] {
  const bodies: ResponseBody[] = [];
  const visit = (node: ts.Node): void => {
    if (isJsonResponseCall(node)) {
      const [body, init] = node.arguments;
      if (body) bodies.push({ call: node, body, statuses: resolveStatuses(init) });
    } else if (isStreamedJsonStringify(node)) {
      const [body] = node.arguments;
      // ストリームの途中に流す文面は、ステータスで区別できない
      if (body) bodies.push({ call: node, body, statuses: null });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bodies;
}

function parseSource(source: string, fileName: string): ts.SourceFile {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** ソースの中で、エラー由来の値を本文に入れている応答 (NextResponse.json など) を探す */
function findRawErrorMessageResponses(source: string, fileName = 'route.ts'): Finding[] {
  return findingsOf(parseSource(source, fileName));
}

function findingsOf(sf: ts.SourceFile, bodies: ResponseBody[] = responseBodiesOf(sf)): Finding[] {
  const findings: Finding[] = [];

  for (const { call, body, statuses } of bodies) {
    const sources = rawSourcesOf(body);
    if (sources.length === 0) continue;
    // 4xx で返してよいのは、こちらが書いた文面 (AuthError・zod など) だけ。DB の結果のエラー文は 4xx でも出さない
    const fromDb = sources.some((source) => isAwaitedResultError(source.base));
    if (isClientErrorOnly(statuses) && !fromDb) continue;
    const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf));
    findings.push({ line: line + 1, text: call.getText(sf).replace(/\s+/g, ' ').slice(0, 140) });
  }

  return findings;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** ファイル (リポジトリ直下からの相対パス) -> 違反 */
const scanned = new Map<string, Finding[]>();
/** 走査した応答の本文の数 (走査が空振りしていないことの確認に使う) */
let responseBodyCount = 0;
for (const file of collectSourceFiles(path.join(ROOT, SCAN_ROOT)).sort()) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  const sf = parseSource(fs.readFileSync(file, 'utf-8'), relative);
  const bodies = responseBodiesOf(sf);
  scanned.set(relative, findingsOf(sf, bodies));
  responseBodyCount += bodies.length;
}

const describeFindings = (findings: Finding[]) => findings.map((f) => `    L${f.line}: ${f.text}`).join('\n');

/** 走査が壊れていないことの目安: route のファイル数と、応答の本文の数の下限 */
const MIN_SCANNED_FILES = 150;
const MIN_RESPONSE_BODIES = 1000;

// ─────────────────────────────────────────────
// リポジトリのソースに対する contract
// ─────────────────────────────────────────────
describe('API の応答の本文に生のエラー文を入れない (#1172): src/app/api のソース', () => {
  it('走査が機能している: 多数の route と応答を読んでいる', () => {
    // 走査が壊れて何も読めなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(scanned.size).toBeGreaterThan(MIN_SCANNED_FILES);
    expect(responseBodyCount).toBeGreaterThan(MIN_RESPONSE_BODIES);
    // 直した route も走査の対象に入っている
    expect(scanned.has('src/app/api/meals/route.ts')).toBe(true);
    expect(scanned.has('src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts')).toBe(true);
  });

  it('どの route も、応答の本文に DB の生のエラー文・例外の文面を入れていない (500 は internalError() で返す)', () => {
    const violations: string[] = [];
    for (const [file, findings] of scanned) {
      if (findings.length > 0) violations.push(`${file}: ${findings.length} 件\n${describeFindings(findings)}`);
    }

    expect(
      violations,
      '応答の本文に error.message / details / hint や例外の文面を入れないこと。500 は internalError(routeName, error, ctx) ' +
        "(src/lib/api/errors.ts) で返す (運営 API は { shape: 'nested' })。4xx で理由を伝えるときは固定の文を返す:\n" +
        violations.join('\n'),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 走査ロジック自体の確認 (合成ソースで検出できること / 誤検出しないこと)
// ─────────────────────────────────────────────
describe('API の応答の本文に生のエラー文を入れない (#1172): ソース解析のロジック', () => {
  const count = (source: string) => findRawErrorMessageResponses(source).length;

  describe('検出する', () => {
    it.each([
      ['{ error: error.message } (500)', `return NextResponse.json({ error: error.message }, { status: 500 });`],
      ['{ error: err.message }', `return NextResponse.json({ error: err.message }, { status: 500 });`],
      ['{ error: e.message }', `return NextResponse.json({ error: e.message }, { status: 500 });`],
      ['insertError / rpcError など *Error の名前', `return NextResponse.json({ error: insertError.message }, { status: 500 });`],
      ['result.error.message (プロパティ)', `return NextResponse.json({ error: result.error.message }, { status: 500 });`],
      ['state.insertError.message', `return NextResponse.json({ error: state.insertError.message }, { status: 500 });`],
      [
        '{ message: error.message } (運営 API の入れ子)',
        `return NextResponse.json({ error: { code: 'OP_DB_ERROR', message: error.message } }, { status: 500 });`,
      ],
      ['error?.message ?? 既定値', `return NextResponse.json({ error: error?.message ?? 'Unknown error' }, { status: 500 });`],
      ['error.message || 既定値', `return NextResponse.json({ error: error.message || 'failed' }, { status: 500 });`],
      ['文字列の連結', `return NextResponse.json({ error: 'failed: ' + aiError.message }, { status: 500 });`],
      ['テンプレート文字列', 'return NextResponse.json({ error: `failed: ${error.message}` }, { status: 500 });'],
      ['型アサーション越し', `return NextResponse.json({ error: (error as Error).message }, { status: 500 });`],
      ['非 null アサーション越し', `return NextResponse.json({ error: error!.message }, { status: 500 });`],
      ["error['message'] (要素アクセス)", `return NextResponse.json({ error: error['message'] }, { status: 500 });`],
      ['details にだけ入れた場合', `return NextResponse.json({ error: '失敗', details: error.message }, { status: 500 });`],
      ['PostgREST の details', `return NextResponse.json({ error: '失敗', details: error.details }, { status: 500 });`],
      ['PostgREST の hint', `return NextResponse.json({ error: '失敗', hint: insertError?.hint }, { status: 500 });`],
      ['配列の中', `return NextResponse.json({ errors: [error.message] }, { status: 500 });`],
      ['String(error)', `return NextResponse.json({ error: String(err) }, { status: 500 });`],
      ['JSON.stringify(result.error)', `return NextResponse.json({ error: JSON.stringify(result.error) }, { status: 500 });`],
      ['Response.json (NextResponse でない)', `return Response.json({ error: claimError.message }, { status: 500 });`],
      ['ステータスの指定が無い (200 で返る)', `return NextResponse.json({ ok: false, error: error.message });`],
      ['ステータスが 5xx の別の値', `return NextResponse.json({ error: error.message }, { status: 503 });`],
      ['ステータスが変数 ({ status })', `return NextResponse.json({ error: error.message }, { status });`],
      ['ステータスが変数 (status: code)', `return NextResponse.json({ error: error.message }, { status: code });`],
      ['ステータスの一部が 4xx でない分岐', `return NextResponse.json({ error: error.message }, { status: ok ? 400 : 500 });`],
      ['init がオブジェクトでない', `return NextResponse.json({ error: error.message }, init);`],
      ['init が spread を含む', `return NextResponse.json({ error: error.message }, { ...init });`],
      ['init に headers だけ (200 で返る)', `return NextResponse.json({ error: error.message }, { headers: {} });`],
    ])('%s', (_label, source) => {
      expect(count(source)).toBe(1);
    });

    it.each([
      [
        'catch の中で `const message = error instanceof Error ? error.message : ...` のあと { error: message }',
        `
          try {} catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            return NextResponse.json({ error: message }, { status: 500 });
          }`,
      ],
      [
        '運営 API の { error: { code, message } } (message は変数)',
        `
          try {} catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
          }`,
      ],
      [
        '変数のあとに別の変数を経由する (2 段)',
        `
          try {} catch (e) {
            const raw = e.message;
            const text = raw.trim();
            return NextResponse.json({ error: text }, { status: 500 });
          }`,
      ],
      [
        'テンプレート文字列に変数を埋め込む',
        `
          try {} catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            return NextResponse.json({ error: \`Failed: \${errorMessage}\`, code: 'X' }, { status: 500 });
          }`,
      ],
      [
        '分割代入 const { message } = error',
        `
          const { message } = error;
          return NextResponse.json({ error: message }, { status: 500 });`,
      ],
      [
        '分割代入の別名 const { message: msg } = err',
        `
          const { message: msg } = err;
          return NextResponse.json({ error: msg }, { status: 500 });`,
      ],
      [
        '分割代入 const { hint } = error',
        `
          const { hint } = error;
          return NextResponse.json({ error: '失敗', hint }, { status: 500 });`,
      ],
      [
        'result.error から取り出した変数',
        `
          const detail = result.error.message;
          return NextResponse.json({ error: detail }, { status: 500 });`,
      ],
      [
        '関数の中の変数 (外側のブロックで宣言)',
        `
          export async function POST() {
            const reason = error.message;
            if (x) {
              return NextResponse.json({ error: reason }, { status: 500 });
            }
          }`,
      ],
    ])('変数経由: %s', (_label, source) => {
      expect(count(source)).toBe(1);
    });

    it.each([
      [
        'catch で受けた例外のオブジェクトごと { error }',
        `
          try {} catch (error) {
            return NextResponse.json({ error }, { status: 500 });
          }`,
      ],
      [
        'catch で受けた例外のオブジェクトごと { error: err }',
        `
          try {} catch (err) {
            return NextResponse.json({ ok: false, error: err });
          }`,
      ],
      [
        'await の結果から取り出した error ごと',
        `
          const { data, error } = await supabase.from('t').select();
          if (error) return NextResponse.json({ error }, { status: 500 });`,
      ],
      [
        'await の結果から取り出した別名の error ごと',
        `
          const { error: rpcError } = await supabase.rpc('f');
          if (rpcError) return NextResponse.json({ error: rpcError }, { status: 500 });`,
      ],
    ])('エラーのオブジェクトごと: %s', (_label, source) => {
      expect(count(source)).toBe(1);
    });

    it.each([
      [
        '400 で DB の結果の error.message を返す',
        `
          const { error } = await supabase.from('t').insert(row);
          if (error) return NextResponse.json({ error: error.message }, { status: 400 });`,
      ],
      [
        '403 / 400 の分岐で RPC の結果のエラー文を返す',
        `
          const { data, error: rpcError } = await supabase.rpc('f');
          if (rpcError) return NextResponse.json({ error: { code, message: rpcError.message } }, { status: code === 'FORBIDDEN' ? 403 : 400 });`,
      ],
      [
        'await の結果の .error.message を 404 で返す',
        `
          const result = await supabase.from('t').select().single();
          if (result.error) return NextResponse.json({ error: result.error.message }, { status: 404 });`,
      ],
      [
        'Promise.all の結果の .error.message を 409 で返す',
        `
          const [a, b] = await Promise.all([q1, q2]);
          if (a.error) return NextResponse.json({ error: a.error.details }, { status: 409 });`,
      ],
    ])('DB の結果のエラー文は 4xx でも検出する: %s', (_label, source) => {
      expect(count(source)).toBe(1);
    });

    it.each([
      [
        'SSE: controller.enqueue に流す JSON.stringify({ error: error.message })',
        'controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: error.message })}\\n\\n`));',
      ],
      [
        'SSE: 応答の途中の大きなオブジェクトの中の error',
        'controller.enqueue(encoder.encode(`data: ${JSON.stringify({ aiMessage: { id }, error: e.message })}\\n\\n`));',
      ],
      ['writer.write に流す', `await writer.write(encoder.encode(JSON.stringify({ error: err.message })));`],
      ['new Response(JSON.stringify(...))', `return new Response(JSON.stringify({ error: error.message }), { status: 500 });`],
      ['new NextResponse(JSON.stringify(...))', `return new NextResponse(JSON.stringify({ details: error.details }));`],
    ])('ストリーム・new Response: %s', (_label, source) => {
      expect(count(source)).toBe(1);
    });

    it('1 回の応答に生のエラー文が何か所入っていても 1 件。応答ごとに数える', () => {
      expect(count(`return NextResponse.json({ error: error.message, details: error.details }, { status: 500 });`)).toBe(1);
      expect(
        count(`
          if (a) return NextResponse.json({ error: error.message }, { status: 500 });
          if (b) return NextResponse.json({ error: err.message }, { status: 500 });
          const detail = result.error.message;
          return NextResponse.json({ error: detail }, { status: 500 });
        `),
      ).toBe(3);
    });

    it('違反の行番号と、その応答の文面を返す', () => {
      const findings = findRawErrorMessageResponses(
        `import { NextResponse } from 'next/server';\n\nexport async function GET() {\n  return NextResponse.json({ error: error.message }, { status: 500 });\n}\n`,
      );

      expect(findings).toEqual([{ line: 4, text: "NextResponse.json({ error: error.message }, { status: 500 })" }]);
    });

    it('.tsx のソースも解析できる', () => {
      const findings = findRawErrorMessageResponses(
        `export const GET = () => NextResponse.json({ error: error.message }, { status: 500 });`,
        'route.tsx',
      );
      expect(findings).toHaveLength(1);
    });
  });

  describe('検出しない', () => {
    it.each([
      ['4xx (400): こちらが書いた検証メッセージ', `return NextResponse.json({ error: parseResult.error.message }, { status: 400 });`],
      [
        '4xx (400): zod の safeParse の結果 (await ではない)',
        `const parseResult = schema.safeParse(body); return NextResponse.json({ error: parseResult.error.message }, { status: 400 });`,
      ],
      ['401: AuthError の文面', `return NextResponse.json({ error: { code: 'AUTH', message: err.message } }, { status: 401 });`],
      ['403: ForbiddenError の文面', `return NextResponse.json({ error: { code: 'PERM', message: err.message } }, { status: 403 });`],
      [
        '401: catch で受けた AuthError の文面',
        `try {} catch (err) { if (err instanceof AuthError) return NextResponse.json({ error: { code: 'X', message: err.message } }, { status: 401 }); }`,
      ],
      ['422', `return NextResponse.json({ error: e.message }, { status: 422 });`],
      ['4xx の分岐 (全て 4xx)', `return NextResponse.json({ error: rpcError.message }, { status: code === 'X' ? 403 : 400 });`],
      ['ネストした 4xx の分岐', `return NextResponse.json({ error: error.message }, { status: a ? 400 : b ? 403 : 404 });`],
      ['括弧・as 越しの 4xx', `return NextResponse.json({ error: error.message }, { status: (400 as number) });`],
      ['文字列のキー "status" の 4xx', `return NextResponse.json({ error: error.message }, { 'status': 400 });`],
      [
        '4xx を入れた const のステータス ({ status })',
        `try {} catch (err) { const status = err.code === 'X' ? 404 : 422; return NextResponse.json({ error: { code: err.code, message: err.message } }, { status }); }`,
      ],
    ])('%s', (_label, source) => {
      expect(count(source)).toBe(0);
    });

    it.each([
      ['固定メッセージ', `return NextResponse.json({ error: '処理中にエラーが発生しました' }, { status: 500 });`],
      ['internalError() を使う', `return internalError('GET /api/x', error, { userId: user.id });`],
      ['エラーでない値の message', `return NextResponse.json({ message: result.message }, { status: 200 });`],
      ['成功応答の message', `return NextResponse.json({ message: data.message, ok: true });`],
      ['message というキー (値は固定)', `return NextResponse.json({ error: { code: 'X', message: '権限がありません' } }, { status: 403 });`],
      ['エラーのオブジェクトの別のプロパティ (code)', `return NextResponse.json({ error: 'failed', code: error.code }, { status: 500 });`],
      ['LLM の応答の choices[0].message', `return NextResponse.json({ content: response.choices[0]?.message?.content });`],
      ['エラーでない名前の変数', `const message = formatGreeting(); return NextResponse.json({ error: message }, { status: 500 });`],
      ['関数の引数の message (宣言が見えない)', `function fail(message: string) { return NextResponse.json({ error: message }, { status: 500 }); }`],
      ['ログにだけ使う', `logger.error('failed', error.message); return NextResponse.json({ error: 'failed' }, { status: 500 });`],
      ['JSON を返さない呼び出し', `const edge = await edgeResponse.json(); return NextResponse.redirect(error.message);`],
      ['NextResponse 以外の .json()', `return res.json({ error: error.message }, { status: 500 });`],
      ['本文が無い', `return NextResponse.json();`],
      [
        '同期の関数の結果から取り出した error (検証の文字列)',
        `const { valid, error: slotsError } = validateTargetSlots(raw); return NextResponse.json({ error: slotsError }, { status: 400 });`,
      ],
      [
        'エラーの有無だけを使う (値は固定の文)',
        `try {} catch (error) { return NextResponse.json({ error: error instanceof AuthError ? 'Unauthorized' : '失敗' }, { status: 500 }); }`,
      ],
      [
        'await の結果のエラーを条件にだけ使う',
        `const { error } = await supabase.from('t').select(); return NextResponse.json({ ok: !error });`,
      ],
      [
        'ログ用の JSON.stringify (ストリーム・応答ではない)',
        `console.error(JSON.stringify({ error: error.message })); return NextResponse.json({ error: 'failed' }, { status: 500 });`,
      ],
      [
        'SSE に固定の文を流す',
        "controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE })}\\n\\n`));",
      ],
    ])('%s', (_label, source) => {
      expect(count(source)).toBe(0);
    });

    it('コメントや文字列の中', () => {
      expect(
        count(`
          // NextResponse.json({ error: error.message }, { status: 500 }) と書かない
          /* return NextResponse.json({ error: err.message }); */
          const note = "NextResponse.json({ error: error.message })";
          return NextResponse.json({ error: 'ok' }, { status: 500 });
        `),
      ).toBe(0);
    });

    it('変数は、本文より後ろの宣言・別のスコープの宣言・直近の宣言で上書きされたものを使わない', () => {
      // 本文より後で宣言された変数
      expect(
        count(`
          const a = () => NextResponse.json({ error: message }, { status: 500 });
          const message = error.message;
        `),
      ).toBe(0);
      // 別の関数の変数 (スコープが違う)
      expect(
        count(`
          function one() { const message = error.message; return message; }
          function two() { return NextResponse.json({ error: message }, { status: 500 }); }
        `),
      ).toBe(0);
      // 内側のスコープで同名の変数が固定文字列で宣言し直されている (外側の変数は影になる)
      expect(
        count(`
          const message = error.message;
          function two() {
            const message = '固定のメッセージ';
            return NextResponse.json({ error: message }, { status: 500 });
          }
        `),
      ).toBe(0);
    });

    it('分割代入: エラーでないものの message / message・details・hint 以外のプロパティ', () => {
      expect(count(`const { message } = result; return NextResponse.json({ error: message }, { status: 500 });`)).toBe(0);
      expect(count(`const { code } = error; return NextResponse.json({ error: code }, { status: 500 });`)).toBe(0);
    });

    it('変数をたどる段数には上限がある (無限ループしない)', () => {
      expect(
        count(`
          const a = error.message;
          const b = a;
          const c = b;
          const d = c;
          const e2 = d;
          return NextResponse.json({ error: e2 }, { status: 500 });
        `),
      ).toBe(0);
    });

    it('let のステータスは読まない (後から書き換えられるため、分からないものとして数える)', () => {
      expect(
        count(`try {} catch (err) { let status = 400; status = 500; return NextResponse.json({ error: err.message }, { status }); }`),
      ).toBe(1);
    });
  });

  describe('部品', () => {
    const parseExpression = (source: string) => {
      const sf = ts.createSourceFile('x.ts', `f(${source})`, ts.ScriptTarget.Latest, true);
      const call = (sf.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression;
      return call.arguments[0];
    };

    it('resolveStatuses: 指定なしは 200、リテラルと分岐は全ての値、分からないものは null', () => {
      expect(resolveStatuses(undefined)).toEqual([200]);
      expect(resolveStatuses(parseExpression('{ status: 500 }'))).toEqual([500]);
      expect(resolveStatuses(parseExpression('{ status: a ? 403 : 400 }'))).toEqual([403, 400]);
      expect(resolveStatuses(parseExpression('{ headers: {} }'))).toEqual([200]);
      expect(resolveStatuses(parseExpression('{ status }'))).toBeNull();
      expect(resolveStatuses(parseExpression('{ status: code }'))).toBeNull();
      expect(resolveStatuses(parseExpression('{ status: a ? 400 : code }'))).toBeNull();
      expect(resolveStatuses(parseExpression('init'))).toBeNull();
    });

    it('isClientErrorOnly: 全て 400〜499 のときだけ true', () => {
      expect(isClientErrorOnly([400])).toBe(true);
      expect(isClientErrorOnly([403, 499])).toBe(true);
      expect(isClientErrorOnly([399])).toBe(false);
      expect(isClientErrorOnly([500])).toBe(false);
      expect(isClientErrorOnly([400, 500])).toBe(false);
      expect(isClientErrorOnly([200])).toBe(false);
      expect(isClientErrorOnly([])).toBe(false);
      expect(isClientErrorOnly(null)).toBe(false);
    });

    it.each([
      ['e', true],
      ['err', true],
      ['error', true],
      ['exception', true],
      ['ex', true],
      ['insertError', true],
      ['rpcErr', true],
      ['uploadError', true],
      ['result.error', true],
      ['parsed.error', true],
      ['state.insertError', true],
      ['message', false],
      ['result', false],
      ['errors', false],
      ['errorMessage', false],
      ['Errorable', false],
      ['errand', false],
    ])('isErrorLike(%s) は %s', (code, expected) => {
      const sf = ts.createSourceFile('x.ts', `(${code})`, ts.ScriptTarget.Latest, true);
      const expression = (sf.statements[0] as ts.ExpressionStatement).expression as ts.ParenthesizedExpression;
      expect(isErrorLike(expression.expression)).toBe(expected);
    });
  });
});
