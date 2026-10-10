// @vitest-environment node
/**
 * #1172 API の応答の本文に、DB の生のエラー文 (message / details / hint) や例外の文面を入れていないかの「見張り」
 *
 * 位置づけ:
 *   保証の本体は route のコードそのもの。5xx は共通のヘルパー internalError() (src/lib/api/errors.ts) で固定の文を返し、
 *   元のエラーは構造化ログ (app_logs) にだけ残す。4xx も、こちらで決めた固定の文を返す。
 *   このテストは、よくある書き方 (捕まえたエラーや DB の結果の message / details / hint を、そのまま本文に入れる) で
 *   生のエラー文を本文に戻してしまったときに気づくための見張りで、網羅はしない。
 *   捕まえられない書き方は、下の「この検査の限界」に挙げる。限界に当たる書き方をしていないことはレビューで見る。
 *
 * 数えるもの (TypeScript の構文木で読む。コメント・文字列の中は見ない。1 回の応答を 1 件と数える):
 *   応答の本文 =
 *     - `NextResponse.json(body, init)` / `Response.json(body, init)` の body
 *     - `controller.enqueue(...)` / `writer.write(...)` / `new Response(...)` / `new NextResponse(...)` の中の `JSON.stringify(body)` の body
 *   本文の中のエラー由来の値 =
 *     (1) エラーらしい名前の値の `.message` / `.details` / `.hint` (`error.message` / `insertError?.details` / `result.error['hint']`)
 *     (2) `String(エラー)` / `JSON.stringify(エラー)`
 *     (3) catch で受けた変数、または await の結果から分割代入で取り出したエラーを、そのまま値として入れたもの
 *         (`{ error }` / `{ error: rpcError }` / `[err]` / `` `${err}` `` / `'失敗: ' + err`)
 *     (4) 外 (Edge Function・外部 API) の応答の JSON の `error` (`const data = await res.json(); { message: data.error }`)。
 *         Edge Function は DB のエラー文を包んで返すことがある。利用者の要求 (`await request.json()`) は数えない
 *     (5) 上のどれかを入れた変数。同じ関数の中で、本文より前に宣言した const / let の初期値を MAX_RESOLVE_DEPTH 段までたどる
 *         (`const message = err instanceof Error ? err.message : '...'` / `const { message } = error`)
 *   「エラーらしい名前」 = `e` / `err` / `error` / `exception` / `ex`、`Error` / `Err` で終わる名前 (`insertError` / `rpcErr`)、
 *   `.error` / `.xxxError` のプロパティ (`result.error`)。
 *
 * 4xx の例外 (数えない):
 *   ステータスが 4xx だけと読める応答で、本文の中のエラー由来の値が全て次のどちらかのもの。
 *     (a) 文面をこちらで書いている例外のクラス (TRUSTED_ERROR_CLASSES) に絞り込んだ分岐の中で読んだもの
 *         (`if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: 401 })`。
 *          if の then / 三項演算子の真の側 / `&&` の右辺。条件の `||` は全ての項、`&&` はどれか 1 つの項がこの形のとき)
 *     (b) 同期の関数の結果から取り出したもの (`const parsed = schema.safeParse(body); parsed.error.message`)。検証の文面
 *   ステータスは、リテラル・リテラルの三項演算子・それを入れた const から読む。読めないものは 4xx とみなさない (数える)。
 *   catch の変数・await の結果のエラー・関数の引数は、4xx でも (a) 以外は数える
 *   (try の中で `if (error) throw error` すると、DB の生のエラーが catch に届くため)。
 *
 * この検査の限界 (捕まえない書き方。網羅は目指さない):
 *   - 文面を別の関数に渡し、その中で本文にする (`fail(error.message)` → `function fail(m) { return NextResponse.json({ error: m }) }`)
 *   - 関数が返したエラーの文面 (`const text = describe(err); { error: text }`)
 *   - 宣言の後で代入した変数 (`let message; message = error.message`)・宣言の見えない変数・MAX_RESOLVE_DEPTH 段より深い変数
 *   - エラーらしくない名前の値 (`catch (reason)` / `const failure = (await q).error; failure.message`)
 *   - 宣言の後でオブジェクトや配列に足したもの (`const list = []; list.push(error.message); { errors: list }`)
 *   - 文面を取り出す別の書き方 (`err.toString()` / `err.stack` / `err.cause` / `Object.assign({}, err)`)
 *   - 外の応答の JSON の `error` 以外のプロパティ (`data.message` / `data.detail`)、`.json()` を経ずに読んだ外の応答 (`await res.text()`)
 *   - 外の応答の JSON をまるごと返すもの (`{ result: edgeData }` / `NextResponse.json(edgeData)`。成功の応答の中に失敗の文が入ることがある。
 *     例: カタログの取り込みの stats.productErrors[].error。/api/admin/catalog/import は件数だけを返す)
 *   - 同期の関数の結果に、捕まえた例外の文面を入れて返すもの ((b) とみなして 4xx では数えない)
 *   - 絞り込んだ後で変数に別の値を代入し直すもの。逆に `if (!(err instanceof AuthError)) return ...` の後の早期 return による
 *     絞り込みは見ないので、その後ろで 4xx に文面を入れると数える (安全側)
 *   - DB に保存した文面を後で読んで返すもの (Edge Function が書く失敗の文の列は、route が絞ってから返す:
 *     weekly_menu_requests.error_message は src/lib/weekly-menu-request-error.ts、
 *     shopping_list_requests.result.error は src/lib/shopping-list-request-error.ts を通す)
 *   - src/app/api の外 (src/lib) で作った本文・結果。src/lib のヘルパーが結果に入れる文は tests/lib-raw-error-message-scan.test.ts が見る
 *
 * 直し方: route では `return internalError('GET /api/xxx', error, { userId: user.id })` (src/lib/api/errors.ts)。
 *   本文は汎用メッセージだけになり、元のエラーは構造化ログに残る。運営 API のように `error.message` を読むクライアントには
 *   `{ shape: 'nested' }` を渡す。4xx で理由を伝えるときは、こちらで決めた固定の文を返す (DB の文面を加工して返さない)。
 *
 * 走査の対象は src/app/api 配下の全ファイル (テストを除く)。1 件でもあれば失敗する。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/api';

/** エラーを受ける値の名前: e / err / error / exception / ex、または Error / Err で終わる名前 */
const ERROR_NAME = /^(?:e|err|error|exception|ex)$|(?:Error|Err)$/;
/** PostgREST のエラーが文面を持つプロパティ (例外の Error も message を持つ) */
const RAW_TEXT_PROPERTIES = new Set(['message', 'details', 'hint']);
/** `X.json(body, init)` で応答を作るクラス */
const RESPONSE_CLASSES = new Set(['NextResponse', 'Response']);
/** ストリームに書く呼び出し (この引数の中の JSON.stringify(...) は応答の本文) */
const STREAM_WRITE_METHODS = new Set(['enqueue', 'write']);
/** 外の応答の JSON のうち、相手が書いたエラー文が入るプロパティ */
const UPSTREAM_ERROR_PROPERTY = 'error';
/** 利用者からの要求 (route の引数) の名前。`await request.json()` は外の応答ではない */
const OWN_REQUEST_NAMES = new Set(['request', 'req']);
/** 変数をたどる段数の上限 (const a = e.message; const b = a; ... の連鎖)。見張りなので浅くてよい */
const MAX_RESOLVE_DEPTH = 3;
/** 4xx (クライアントの誤り) の範囲。RFC 9110 §15.5 */
const HTTP_CLIENT_ERROR_FIRST = 400;
const HTTP_CLIENT_ERROR_LAST = 499;
/** init に status が無いときのステータス (NextResponse.json の既定) */
const HTTP_DEFAULT_STATUS = 200;
/**
 * 文面をこちらで書いている例外のクラス。`err instanceof <これ>` で絞り込んだ分岐の中なら、err.message を 4xx で返してよい。
 *   AuthError / ForbiddenError: src/lib/auth/errors.ts。文面は code か、投げる側が渡した固定の文 (src/lib/auth/helpers.ts)
 *   ZodError: zod の検証の文面 (利用者の入力の誤り)
 *   CouponApplyError: src/lib/plan/coupon.ts の toCouponApplyError が、業務エラーの表 (BUSINESS_ERRORS) の固定の文だけで作る
 * ここに足すのは、文面に DB の生のエラー文が入りえないことを、そのクラスを作る箇所を全部読んで確かめたものだけ。
 * `Error` は足さない (PostgREST のエラーを throw したものも、Error として届くことがある)。
 */
const TRUSTED_ERROR_CLASSES = new Set(['AuthError', 'ForbiddenError', 'ZodError', 'CouponApplyError']);

interface Finding {
  line: number;
  text: string;
}

// ─────────────────────────────────────────────
// 構文木の小さな道具
// ─────────────────────────────────────────────

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

/** エラーらしい名前の値か: `error` / `insertError` / `result.error` */
function isErrorLike(expr: ts.Expression): boolean {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return ERROR_NAME.test(inner.text);
  if (ts.isPropertyAccessExpression(inner)) return ERROR_NAME.test(inner.name.text);
  return false;
}

/** `a.b.c` / `a['b']` / `(await x).error` の根元の式 (識別子・await など) */
function rootOf(expr: ts.Expression): ts.Expression {
  let current = unwrap(expr);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrap(current.expression);
  return current;
}

/** 識別子が「値としての参照」か (プロパティ名・キー・宣言の名前・型の名前は参照ではない) */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if ((ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === id) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  return true;
}

/** 変数の宣言 */
interface Declaration {
  initializer?: ts.Expression;
  /** 分割代入 `{ a: b } = x` で取り出したプロパティの名前 (入れ子なら外側の名前。配列なら '[]') */
  bindingProperty?: string;
  /** catch (e) の e */
  isCatchVariable?: boolean;
}

function statementsOf(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return undefined;
}

/** 分割代入の中から名前を探し、取り出したプロパティの名前を返す。無ければ undefined */
function findInBindingPattern(pattern: ts.BindingPattern, name: string): string | undefined {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    let property = '[]';
    if (ts.isObjectBindingPattern(pattern)) {
      const key = element.propertyName ?? element.name;
      property = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : '';
    }
    if (ts.isIdentifier(element.name) ? element.name.text === name : findInBindingPattern(element.name, name) !== undefined) {
      return property;
    }
  }
  return undefined;
}

/**
 * 識別子の、直前までに見える宣言 (catch 節の変数を含む)。
 * いちばん内側のスコープで決める (外側の同名の変数は影になる)。本文より後ろの宣言は見ない。
 */
function findDeclaration(id: ts.Identifier): Declaration | undefined {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isCatchClause(scope)) {
      const variable = scope.variableDeclaration;
      if (variable && ts.isIdentifier(variable.name) && variable.name.text === id.text) return { isCatchVariable: true };
      continue;
    }
    const statements = statementsOf(scope);
    if (!statements) continue;
    let found: Declaration | undefined;
    for (const statement of statements) {
      if (statement.end > id.getStart()) break;
      if (!ts.isVariableStatement(statement)) continue;
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name)) {
          if (name.text === id.text) found = { initializer };
        } else {
          const property = findInBindingPattern(name, id.text);
          if (property !== undefined) found = { initializer, bindingProperty: property };
        }
      }
    }
    if (found) return found;
  }
  return undefined;
}

/** 値として本文に「そのまま」出る位置か (`{ error }` / `{ error: x }` / `[x]` / `...x` / `${x}` / `'a' + x` / `x ?? 'a'`) */
function isEmittedAsValue(node: ts.Expression): boolean {
  let current: ts.Node = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isNonNullExpression(current.parent))) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) return false;
  if (ts.isShorthandPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) return true;
  if (ts.isSpreadAssignment(parent) || ts.isTemplateSpan(parent)) return true;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === current;
  if (ts.isConditionalExpression(parent)) return parent.whenTrue === current || parent.whenFalse === current;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
  }
  return false;
}

/** `String(x)` / `JSON.stringify(x)` の x か */
function isStringifiedArgument(node: ts.Expression): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  const callee = parent.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'String';
  return ts.isPropertyAccessExpression(callee) && callee.getText() === 'JSON.stringify';
}

// ─────────────────────────────────────────────
// エラー由来の値
// ─────────────────────────────────────────────

/** 本文の中で見つかったエラー由来の値 */
interface RawSource {
  /** エラーの式 (`error` / `result.error`) */
  base: ts.Expression;
  /** その文面を読んだ位置。絞り込みの判定に使う */
  at: ts.Node;
}

/** (3) catch の変数か、await の結果から分割代入で取り出したエラーか */
function isRawErrorObject(id: ts.Identifier): boolean {
  if (!ERROR_NAME.test(id.text)) return false;
  const declaration = findDeclaration(id);
  if (!declaration) return false;
  if (declaration.isCatchVariable) return true;
  return declaration.bindingProperty !== undefined && !!declaration.initializer && ts.isAwaitExpression(unwrap(declaration.initializer));
}

/** 式の中に、外の応答の本文を読む `x.json()` (引数なし。利用者の要求・NextResponse / Response を除く) があるか */
function containsUpstreamJsonCall(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'json' && node.arguments.length === 0) {
    const receiver = unwrap(node.expression.expression);
    if (!(ts.isIdentifier(receiver) && (OWN_REQUEST_NAMES.has(receiver.text) || RESPONSE_CLASSES.has(receiver.text)))) return true;
  }
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, (child) => (containsUpstreamJsonCall(child) ? true : undefined)) ?? false;
}

/** (4) `data.error` の data が、外の応答の JSON を入れた変数か (`const data = await res.json()`) */
function isUpstreamErrorText(node: ts.PropertyAccessExpression): boolean {
  if (node.name.text !== UPSTREAM_ERROR_PROPERTY) return false;
  const receiver = unwrap(node.expression);
  if (!ts.isIdentifier(receiver)) return false;
  const declaration = findDeclaration(receiver);
  return !!declaration?.initializer && declaration.bindingProperty === undefined && containsUpstreamJsonCall(declaration.initializer);
}

/** (5) 変数の初期値のエラー由来の値 */
function identifierRawSources(id: ts.Identifier, depth: number): RawSource[] {
  const declaration = findDeclaration(id);
  if (!declaration?.initializer || declaration.isCatchVariable) return [];
  if (declaration.bindingProperty === undefined) return rawSourcesOf(declaration.initializer, depth);
  // const { message } = error / const { details: d } = err
  const { initializer, bindingProperty } = declaration;
  return RAW_TEXT_PROPERTIES.has(bindingProperty) && isErrorLike(initializer) ? [{ base: unwrap(initializer), at: initializer }] : [];
}

/** 式の中の、エラー由来の値 (直接、または変数経由) */
function rawSourcesOf(root: ts.Node, depth = 0): RawSource[] {
  const sources: RawSource[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    // (1) error.message / err?.details / result.error['hint']
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      if (key !== undefined && RAW_TEXT_PROPERTIES.has(key) && isErrorLike(node.expression)) {
        sources.push({ base: unwrap(node.expression), at: node });
        return;
      }
    }
    // (2) String(result.error) / JSON.stringify(insertError)
    if (ts.isPropertyAccessExpression(node) && isErrorLike(node) && isStringifiedArgument(node)) {
      sources.push({ base: node, at: node });
      return;
    }
    // (4) 外の応答の JSON の error
    if (ts.isPropertyAccessExpression(node) && isUpstreamErrorText(node) && isEmittedAsValue(node)) {
      sources.push({ base: node, at: node });
      return;
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      // (2) String(err) は宣言が見えなくても名前で判定する / (3) エラーのオブジェクトそのもの
      if ((ERROR_NAME.test(node.text) && isStringifiedArgument(node)) || (isRawErrorObject(node) && isEmittedAsValue(node))) {
        sources.push({ base: node, at: node });
        return;
      }
      // (5) 変数をたどる (エラーらしい名前の変数そのものは (3) で見る)
      if (!ERROR_NAME.test(node.text) && depth < MAX_RESOLVE_DEPTH) sources.push(...identifierRawSources(node, depth + 1));
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return sources;
}

// ─────────────────────────────────────────────
// 4xx の例外
// ─────────────────────────────────────────────

/** 条件が target を TRUSTED_ERROR_CLASSES に絞り込むか (`target instanceof AuthError` / `||` は全ての項 / `&&` はどれかの項) */
function narrowsToTrustedClass(condition: ts.Expression, target: string): boolean {
  const inner = unwrap(condition);
  if (!ts.isBinaryExpression(inner)) return false;
  switch (inner.operatorToken.kind) {
    case ts.SyntaxKind.InstanceOfKeyword:
      return unwrap(inner.left).getText() === target && ts.isIdentifier(inner.right) && TRUSTED_ERROR_CLASSES.has(inner.right.text);
    case ts.SyntaxKind.BarBarToken:
      return narrowsToTrustedClass(inner.left, target) && narrowsToTrustedClass(inner.right, target);
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return narrowsToTrustedClass(inner.left, target) || narrowsToTrustedClass(inner.right, target);
    default:
      return false;
  }
}

/** (a) at が、base を TRUSTED_ERROR_CLASSES に絞り込んだ分岐の中か。関数の境界はまたがない */
function isNarrowedToTrustedClass(at: ts.Node, base: ts.Expression): boolean {
  const target = unwrap(base).getText();
  let child: ts.Node = at;
  for (let parent = at.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement === child && narrowsToTrustedClass(parent.expression, target)) return true;
    if (ts.isConditionalExpression(parent) && parent.whenTrue === child && narrowsToTrustedClass(parent.condition, target)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === child &&
      narrowsToTrustedClass(parent.left, target)
    ) {
      return true;
    }
  }
  return false;
}

/** (b) 同期の関数の結果から取り出したものか (`const parsed = schema.safeParse(body); parsed.error`) */
function isSyncCallResult(base: ts.Expression): boolean {
  const root = rootOf(base);
  if (!ts.isIdentifier(root)) return false;
  const initializer = findDeclaration(root)?.initializer;
  return !!initializer && ts.isCallExpression(unwrap(initializer));
}

/** 4xx の本文に入れてよい、こちらが書いた文面か */
function isOwnWording(source: RawSource): boolean {
  return isNarrowedToTrustedClass(source.at, source.base) || isSyncCallResult(source.base);
}

/** 数値リテラル・その三項演算子・それを入れた const の取りうる値。分からなければ null */
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
    const list = declaration?.initializer?.parent?.parent;
    // let は後から書き換えられるので読まない (const だけ)
    if (declaration?.initializer && declaration.bindingProperty === undefined && list && ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) {
      return numericValues(declaration.initializer, depth + 1);
    }
  }
  return null;
}

/** init (第 2 引数) の取りうるステータス。指定が無ければ既定の 200。分からなければ null */
function statusesOf(init: ts.Expression | undefined): number[] | null {
  if (!init) return [HTTP_DEFAULT_STATUS];
  const literal = unwrap(init);
  if (!ts.isObjectLiteralExpression(literal)) return null;
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'status') return numericValues(property.name);
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'status') {
      return numericValues(property.initializer);
    }
  }
  return [HTTP_DEFAULT_STATUS];
}

function isClientErrorOnly(statuses: number[] | null): boolean {
  return !!statuses && statuses.length > 0 && statuses.every((s) => s >= HTTP_CLIENT_ERROR_FIRST && s <= HTTP_CLIENT_ERROR_LAST);
}

// ─────────────────────────────────────────────
// 応答の本文と走査
// ─────────────────────────────────────────────

interface ResponseBody {
  call: ts.Node;
  body: ts.Expression;
  /** 取りうるステータス。ストリームの途中など、分からなければ null */
  statuses: number[] | null;
}

/** `JSON.stringify(x)` が、ストリームへの書き込み・new Response(...) の引数の中にあるか */
function isStreamedJsonStringify(node: ts.CallExpression): boolean {
  if (node.expression.getText() !== 'JSON.stringify') return false;
  for (let current: ts.Node | undefined = node.parent; current && !ts.isStatement(current); current = current.parent) {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && STREAM_WRITE_METHODS.has(current.expression.name.text)) return true;
    if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && RESPONSE_CLASSES.has(current.expression.text)) return true;
  }
  return false;
}

function responseBodiesOf(sf: ts.SourceFile): ResponseBody[] {
  const bodies: ResponseBody[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'json' && ts.isIdentifier(callee.expression) && RESPONSE_CLASSES.has(callee.expression.text)) {
        bodies.push({ call: node, body: node.arguments[0], statuses: statusesOf(node.arguments[1]) });
      } else if (isStreamedJsonStringify(node)) {
        bodies.push({ call: node, body: node.arguments[0], statuses: null });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bodies;
}

function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function findingsOf(sf: ts.SourceFile, bodies: ResponseBody[] = responseBodiesOf(sf)): Finding[] {
  const findings: Finding[] = [];
  for (const { call, body, statuses } of bodies) {
    const sources = rawSourcesOf(body);
    if (sources.length === 0) continue;
    if (isClientErrorOnly(statuses) && sources.every(isOwnWording)) continue;
    const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf));
    findings.push({ line: line + 1, text: call.getText(sf).replace(/\s+/g, ' ').slice(0, 140) });
  }
  return findings;
}

/** ソースの中で、エラー由来の値を本文に入れている応答を探す */
function findRawErrorMessageResponses(source: string, fileName = 'route.ts'): Finding[] {
  return findingsOf(parseSource(source, fileName));
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') files.push(...collectSourceFiles(full));
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

/** 走査が壊れていないことの目安 (2026-10 時点で route のファイルは 190 超・応答の本文は 1,000 超。大きく減ったら走査を疑う) */
const MIN_SCANNED_FILES = 150;
const MIN_RESPONSE_BODIES = 1000;

// ─────────────────────────────────────────────
// リポジトリのソースに対する contract
// ─────────────────────────────────────────────
describe('API の応答の本文に生のエラー文を入れない (#1172): src/app/api のソース', () => {
  it('走査が機能している: 多数の route と応答を読んでいる', () => {
    expect(scanned.size).toBeGreaterThan(MIN_SCANNED_FILES);
    expect(responseBodyCount).toBeGreaterThan(MIN_RESPONSE_BODIES);
    expect(scanned.has('src/app/api/meals/route.ts')).toBe(true);
    expect(scanned.has('src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts')).toBe(true);
  });

  it('どの route も、応答の本文に DB の生のエラー文・例外の文面を入れていない (500 は internalError() で返す)', () => {
    const violations = [...scanned]
      .filter(([, findings]) => findings.length > 0)
      .map(([file, findings]) => `${file}: ${findings.length} 件\n${findings.map((f) => `    L${f.line}: ${f.text}`).join('\n')}`);
    expect(
      violations,
      '応答の本文に error.message / details / hint や例外の文面を入れないこと。500 は internalError(routeName, error, ctx) ' +
        "(src/lib/api/errors.ts) で返す (運営 API は { shape: 'nested' })。4xx で理由を伝えるときは固定の文を返す:\n" +
        violations.join('\n'),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 見張りの動作の確認 (合成ソース)
// ─────────────────────────────────────────────
describe('API の応答の本文に生のエラー文を入れない (#1172): 見張りの動作', () => {
  const count = (source: string) => findRawErrorMessageResponses(source).length;

  it.each([
    // (1) 文面のプロパティ
    ['500 で error.message', `return NextResponse.json({ error: error.message }, { status: 500 });`],
    ['*Error の名前・?. ・既定値', `return NextResponse.json({ error: insertError?.message ?? 'failed' }, { status: 500 });`],
    ['result.error の details', `return NextResponse.json({ error: '失敗', details: result.error.details }, { status: 500 });`],
    ["要素アクセスの hint", `return NextResponse.json({ hint: rpcError['hint'] }, { status: 500 });`],
    ['運営 API の入れ子・テンプレート文字列', 'return NextResponse.json({ error: { code: "X", message: `失敗: ${(e as Error).message}` } }, { status: 500 });'],
    ['Response.json', `return Response.json({ error: claimError.message }, { status: 500 });`],
    // (2) 文字列にする
    ['String(err)', `return NextResponse.json({ error: String(err) }, { status: 500 });`],
    ['JSON.stringify(result.error)', `return NextResponse.json({ error: JSON.stringify(result.error) }, { status: 500 });`],
    // (3) エラーのオブジェクトそのもの
    ['catch の変数ごと', `try {} catch (error) { return NextResponse.json({ error }, { status: 500 }); }`],
    ['catch の変数をテンプレート文字列に', 'try {} catch (err) { return NextResponse.json({ error: `失敗: ${err}` }, { status: 500 }); }'],
    ['await の結果から取り出した error ごと', `const { error: rpcError } = await supabase.rpc('f'); return NextResponse.json({ error: rpcError }, { status: 500 });`],
    // (4) 外の応答の JSON の error
    ['Edge Function の応答の error', `const edgeData = await edgeRes.json(); return NextResponse.json({ error: { message: edgeData.error ?? 'x' } }, { status: 502 });`],
    ['外の応答の error は 4xx でも数える', `const json = await res.json(); return NextResponse.json({ error: json.error }, { status: 400 });`],
    // (5) 変数経由
    ['catch の中で message を変数に入れる', `try {} catch (error) { const message = error instanceof Error ? error.message : 'x'; return NextResponse.json({ error: message }, { status: 500 }); }`],
    ['変数を 2 段たどる', `try {} catch (e) { const raw = e.message; const text = raw.trim(); return NextResponse.json({ error: text }, { status: 500 }); }`],
    ['分割代入 const { message: msg } = err', `const { message: msg } = err; return NextResponse.json({ error: msg }, { status: 500 });`],
    // ストリーム・new Response
    ['SSE の enqueue', 'controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: error.message })}\\n\\n`));'],
    ['writer.write', `await writer.write(encoder.encode(JSON.stringify({ error: err.message })));`],
    ['new Response(JSON.stringify(...))', `return new Response(JSON.stringify({ error: error.message }), { status: 500 });`],
    // 4xx でも数える
    ['DB の結果の error.message を 400 で', `const { error } = await supabase.from('t').insert(row); if (error) return NextResponse.json({ error: error.message }, { status: 400 });`],
    ['await の結果の .error を 404 で', `const result = await q; return NextResponse.json({ error: result.error.message }, { status: 404 });`],
    ['catch の変数の文面を 400 で (instanceof Error は絞り込みとみなさない)', `try {} catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : 'x' }, { status: 400 }); }`],
    ['AuthError の else 側で読んだ文面', `try {} catch (err) { return NextResponse.json({ error: err instanceof AuthError ? 'x' : err.message }, { status: 401 }); }`],
    ['|| の片方だけが文面を書くクラス', `try {} catch (err) { if (err instanceof AuthError || err instanceof Error) return NextResponse.json({ error: err.message }, { status: 401 }); }`],
    ['絞り込みは関数の境界をまたがない', `try {} catch (err) { if (err instanceof AuthError) { return later(() => NextResponse.json({ error: err.message }, { status: 401 })); } }`],
    ['関数の引数の文面を 400 で', `return run().catch((err) => NextResponse.json({ error: err.message }, { status: 400 }));`],
    ['絞り込んでいても 500', `try {} catch (err) { if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: 500 }); }`],
    // ステータスが 4xx と読めない
    ['ステータスの指定が無い (200)', `const parsed = schema.safeParse(body); return NextResponse.json({ ok: false, error: parsed.error.message });`],
    ['ステータスが変数', `const parsed = schema.safeParse(body); return NextResponse.json({ error: parsed.error.message }, { status: code });`],
    ['ステータスの一部が 5xx', `const parsed = schema.safeParse(body); return NextResponse.json({ error: parsed.error.message }, { status: ok ? 400 : 500 });`],
    ['init が spread を含む', `const parsed = schema.safeParse(body); return NextResponse.json({ error: parsed.error.message }, { ...init });`],
    ['let のステータス', `const parsed = schema.safeParse(body); let status = 400; status = 500; return NextResponse.json({ error: parsed.error.message }, { status });`],
  ])('数える: %s', (_label, source) => {
    expect(count(source)).toBe(1);
  });

  it.each([
    ['固定の文', `return NextResponse.json({ error: '処理中にエラーが発生しました' }, { status: 500 });`],
    ['internalError()', `return internalError('GET /api/x', error, { userId: user.id });`],
    ['エラーでない値の message', `return NextResponse.json({ message: result.message, content: response.choices[0]?.message?.content });`],
    ['エラーの code', `return NextResponse.json({ error: 'failed', code: error.code }, { status: 500 });`],
    ['ログにだけ使う', `logger.error('failed', error.message); console.error(JSON.stringify({ e: error.message })); return NextResponse.json({ error: 'x' }, { status: 500 });`],
    ['エラーの有無だけを使う', `const { error } = await q; return NextResponse.json({ ok: !error });`],
    ['コメントと文字列の中', `// NextResponse.json({ error: error.message })\nconst note = "NextResponse.json({ error: err.message })"; return NextResponse.json({ error: 'ok' }, { status: 500 });`],
    ['SSE に固定の文', 'controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: INTERNAL_ERROR_MESSAGE })}\\n\\n`));'],
    ['外の応答の error 以外 (成功の message)', `const edgeData = await edgeRes.json(); return NextResponse.json({ ok: true, message: edgeData.message ?? '完了' });`],
    ['利用者の要求の本文の error', `const body = await request.json(); return NextResponse.json({ echo: body.error }, { status: 400 });`],
    // 4xx の例外 (a): 文面をこちらで書いている例外のクラスに絞り込む
    ['AuthError に絞り込んだ if の中 (401)', `try {} catch (err) { if (err instanceof AuthError) { return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: 401 }); } }`],
    ['三項演算子で ForbiddenError に絞り込む (403)', `try {} catch (err) { return NextResponse.json({ error: err instanceof ForbiddenError ? err.message : 'x' }, { status: 403 }); }`],
    ['|| で 2 クラス・ステータスも分岐', `try {} catch (err) { if (err instanceof AuthError || err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: err instanceof AuthError ? 401 : 403 }); }`],
    ['&& の右辺', `try {} catch (err) { return NextResponse.json({ error: (err instanceof ZodError && err.message) || 'x' }, { status: 400 }); }`],
    ['CouponApplyError と 4xx の const のステータス', `try {} catch (err) { if (err instanceof CouponApplyError) { const status = err.code === 'NF' ? 404 : 422; return NextResponse.json({ error: err.message }, { status }); } }`],
    // 4xx の例外 (b): 同期の関数の結果 (検証の文面)
    ['zod の safeParse の結果を 400 で', `const parsed = schema.safeParse(body); return NextResponse.json({ error: parsed.error.message }, { status: 400 });`],
    ['同期の関数から分割代入した error を 4xx の分岐で', `const { error: slotsError } = validateTargetSlots(raw); return NextResponse.json({ error: slotsError }, { status: a ? 400 : 422 });`],
    // 変数のたどり方
    ['本文より後ろの宣言', `const a = () => NextResponse.json({ error: message }, { status: 500 }); const message = error.message;`],
    ['内側のスコープで固定の文に宣言し直した変数', `const message = error.message; function two() { const message = '固定'; return NextResponse.json({ error: message }, { status: 500 }); }`],
  ])('数えない: %s', (_label, source) => {
    expect(count(source)).toBe(0);
  });

  // 冒頭の「この検査の限界」の例が、実際に捕まえない書き方であることを固定する (説明と動作がずれないように)。
  // ここに並ぶ書き方は route に書かない。捕まえるように直したら、この表と冒頭の一覧から外す
  it.each([
    ['別の関数に渡して本文にする', `function fail(m: string) { return NextResponse.json({ error: m }, { status: 500 }); } fail(error.message);`],
    ['関数が返したエラーの文面', `try {} catch (err) { const text = describe(err); return NextResponse.json({ error: text }, { status: 500 }); }`],
    ['宣言の後で代入した変数', `let message; message = error.message; return NextResponse.json({ error: message }, { status: 500 });`],
    ['エラーらしくない名前', `try {} catch (reason) { return NextResponse.json({ error: reason.message }, { status: 500 }); }`],
    ['宣言の後で配列に足したもの', `const list = []; list.push(error.message); return NextResponse.json({ errors: list }, { status: 500 });`],
    ['err.toString() / err.stack', `try {} catch (err) { return NextResponse.json({ error: err.toString(), stack: err.stack }, { status: 500 }); }`],
    ['外の応答の JSON の error 以外', `const data = await res.json(); return NextResponse.json({ error: data.message }, { status: 502 });`],
    ['外の応答の JSON をまるごと', `const edgeData = await edgeRes.json(); return NextResponse.json({ ok: true, result: edgeData });`],
    ['同期の関数の結果は 4xx で数えない', `try {} catch (err) { const r = toResult(err); return NextResponse.json({ error: r.error.message }, { status: 400 }); }`],
  ])('この検査の限界 (捕まえない): %s', (_label, source) => {
    expect(count(source)).toBe(0);
  });

  it('1 回の応答に何か所入っていても 1 件。違反の行番号と応答の文面を返す (.tsx も読む)', () => {
    expect(count(`return NextResponse.json({ error: error.message, details: error.details }, { status: 500 });`)).toBe(1);
    expect(
      findRawErrorMessageResponses(
        `import { NextResponse } from 'next/server';\n\nexport async function GET() {\n  return NextResponse.json({ error: error.message }, { status: 500 });\n}\n`,
        'route.tsx',
      ),
    ).toEqual([{ line: 4, text: 'NextResponse.json({ error: error.message }, { status: 500 })' }]);
  });
});
