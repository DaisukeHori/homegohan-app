/**
 * API の失敗の本文の文に、英語だけの文や例外の文面を入れていないかを、TypeScript の構文木で読む走査の部品 (#1917)
 *
 * もとは tests/org-api-error-japanese.test.ts (#1966) の中にあった走査を、全 API の見張りで使えるように切り出したもの。
 * 走査する配下の一覧 (直し終えた配下) と、一覧の外の違反の件数の基線は tests/helpers/api-error-japanese-scope.ts にある。
 *
 * 数えるもの (コメントは見ない):
 *   本文 = `NextResponse.json(本文, …)` / `Response.json(本文, …)` の 1 つ目の引数と、BODY_TEXT_CALLS の関数の文の引数
 *     (`challengeError(code, 文, status)` の 2 つ目)
 *   本文の文 = 本文のオブジェクトの `error` / `message` の値 (値がオブジェクトなら、その中の `error` / `message` も)。
 *     値の位置 = 式そのもの・三項演算子の 2 つの枝・?? / || の両辺・括弧・as / satisfies・テンプレートの文字の部分
 *     (findErrorTexts / findValidationMessageTexts に substitutions を渡すと、テンプレートの式の部分も値として読む。renderSubstitution)。
 *     名前 (定数・変数) は、同じファイルの `const 名前 = …` と、import 元のファイルの `export const 名前 = …` を
 *     MAX_RESOLVE_DEPTH 段までたどる
 *   違反 = ラテン文字を含み日本語 (ひらがな・カタカナ・漢字・全角) を 1 文字も含まない文 / 値が `X.message` の文
 *
 * この検査の限界 (網羅はしない): 表 (オブジェクト) の要素を引いた文 (`MESSAGES[code]`)・関数の戻り値・別の関数に渡して本文にするもの・
 *   走査の対象の外のファイルが作る文は見ない。見張りであって、網羅の証明ではない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** リポジトリの根 (tests/helpers の 2 つ上) */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** API の route の根 */
export const API_ROUTES_ROOT = 'src/app/api';

/** 名前をたどる段数の上限 (定数 → 別の定数 → … の連鎖。循環で止まらないため) */
const MAX_RESOLVE_DEPTH = 4;
/** `NextResponse.json` / `Response.json` の本文の引数の位置 */
const JSON_BODY_ARGUMENT_INDEX = 0;
/** 本文の文を引数で受け取る関数と、その文の引数の位置 */
const BODY_TEXT_CALLS: ReadonlyMap<string, number> = new Map([['challengeError', 1]]);
const RESPONSE_CLASSES = new Set(['NextResponse', 'Response']);
/** 本文のうち、利用者に見せる文が入るプロパティ */
const TEXT_PROPERTIES = new Set(['error', 'message']);

const LATIN = /[A-Za-z]/;
/** ひらがな・カタカナ・CJK 統合漢字 (拡張 A を含む)・全角の英数記号 */
export const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/;

export type ErrorTextViolationKind = 'english' | 'exception-message';

export interface ErrorTextViolation {
  file: string;
  line: number;
  text: string;
  kind: ErrorTextViolationKind;
}

/** ラテン文字を含み、日本語を 1 文字も含まない */
export function isEnglishOnly(text: string): boolean {
  return LATIN.test(text) && !JAPANESE.test(text);
}

/**
 * 英字の項目名・役割名として拾う語 (英小文字で始まる snake_case・camelCase。'family_id'・'owner'・'id'・'periodType')。
 * 大文字で始まる語 ('ID'・'BAN'・'Expo')・形式の名前 ('YYYY-MM-DD')・URL やパスの一部 ('/api/x'・'example.com') は拾わない
 */
const ENGLISH_IDENTIFIER = /(?<![A-Za-z0-9_\-./:@])[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*(?:_[A-Za-z0-9]+)*(?![A-Za-z0-9_\-./])/g;
/**
 * 括弧の外にあっても項目名ではない語: JSON の値として API を呼ぶ人が送るもの ('文字列か null で'・'true か false で') と、
 * 小文字で始まる検査の名前 (健康診断の 'eGFR'。画面の項目名そのもの)
 */
const ALLOWED_ENGLISH_WORDS: ReadonlySet<string> = new Set(['null', 'true', 'false', 'eGFR']);

/** 括弧 (半角・全角) の中身を取り除く (入れ子も、変わらなくなるまで繰り返す) */
function withoutParenthesized(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(/\([^()]*\)/g, '').replace(/（[^（）]*）/g, '');
    if (next === current) return current;
    current = next;
  }
}

/**
 * 日本語を含む文の、括弧の外にある英字の項目名・役割名 (#1917)。
 * 項目名は「日本語の名前 (英字の項目名)」の形で括弧に入れて添える (src/lib/health-api-messages.ts の healthFieldLabel)。
 * 'family_id は必須です'・'永久 BAN は super_admin のみ' のように括弧の外に英字の項目名・役割名だけが出る文を拾う。
 * 日本語を含まない文は対象外 (英語だけの文は isEnglishOnly が拾う)
 */
export function englishIdentifiersOutsideParentheses(text: string): string[] {
  if (!JAPANESE.test(text)) return [];
  return (withoutParenthesized(text).match(ENGLISH_IDENTIFIER) ?? []).filter((word) => !ALLOWED_ENGLISH_WORDS.has(word));
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** `@/x` / 相対の import 元を、リポジトリの中のファイルの相対パスにする (見つからなければ null) */
function resolveModule(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.posix.join('src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (fs.existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

const sourceCache = new Map<string, ts.SourceFile>();

/** リポジトリの中のファイルの構文木 (同じファイルは 1 回だけ読む) */
export function sourceOf(file: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  const sf = parse(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
  sourceCache.set(file, sf);
  return sf;
}

/** ファイルの中の `const 名前 = 初期値` (どの深さでも。最初に見つかったもの) */
function findConstInitializer(sf: ts.SourceFile, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** 名前の import 元のファイル (import していなければ null) */
function importSourceOf(sf: ts.SourceFile, name: string): string | null {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (bindings.elements.some((e) => e.name.text === name)) {
      return resolveModule(sf.fileName, statement.moduleSpecifier.text);
    }
  }
  return null;
}

interface CollectedTexts {
  texts: string[];
  exceptionMessages: number;
  /** 渡すと、テンプレートの式の部分を値として読む (renderSubstitution)。渡さなければ式の部分を空白にしてつなぐ (英語だけの文の走査) */
  substitutions?: SubstitutionOptions;
}

/**
 * テンプレートの式の部分のうち、値を読み取れないものの印 (#1917 の続き)。
 * 英字の項目名の形にしてあるので、括弧の外に出ると englishIdentifiersOutsideParentheses が拾う
 * (`公開中プランでは ${keys.join(', ')} は変更できません` の keys のような、英字の値が入りうる式を見落とさない)。
 * 括弧の中の式 (`次のいずれかを指定してください (${values})`) は括弧ごと外れるので拾わない
 */
export const UNRESOLVED_SUBSTITUTION = 'unresolved_value';
/** 数として読み取れた式 (数の字・数の定数・Math の関数・数どうしの計算) の印。英字の項目名にならない */
const NUMBER_SUBSTITUTION = '0';
/** `X.join()` の区切りを省いたときの区切り (Array.prototype.join の既定) */
const DEFAULT_JOIN_SEPARATOR = ',';
/** 数どうしの計算の演算子 (両辺が数なら数) */
const ARITHMETIC_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.PlusToken,
]);

/** テンプレートの式の部分の読み方 */
export interface SubstitutionOptions {
  /**
   * 値を読み取れない式のうち、英字の項目名・値にならないと分かっているもの (substitutionKey(ファイル, 式の字面) → 理由)。
   * 印 (UNRESOLVED_SUBSTITUTION) の代わりに空にする。英字の値が入りうる式は、ここに足さずに括弧に入れるか日本語の名前にする
   */
  exempt: ReadonlyMap<string, string>;
  /** 使った見逃しの鍵を積む (古くなった一覧を見つけるため) */
  used?: Set<string>;
}

/** 見逃しの一覧の鍵 (式があるファイルと、式の字面) */
export function substitutionKey(file: string, expressionText: string): string {
  return `${file}:${expressionText}`;
}

/** 名前の `const` の初期値を、同じファイル・import 元のファイルの順に探す (見つかったファイルの構文木と初期値) */
function resolveConst(sf: ts.SourceFile, name: string): { sf: ts.SourceFile; init: ts.Expression } | null {
  const local = findConstInitializer(sf, name);
  if (local) return { sf, init: local };
  const from = importSourceOf(sf, name);
  if (!from) return null;
  const imported = sourceOf(from);
  const init = findConstInitializer(imported, name);
  return init ? { sf: imported, init } : null;
}

/** `X.join(区切り)` の X を配列の字 (`[...] as const` を含む) までたどる */
function arrayLiteralOf(sf: ts.SourceFile, node: ts.Expression, depth: number): { sf: ts.SourceFile; array: ts.ArrayLiteralExpression } | null {
  if (ts.isArrayLiteralExpression(node)) return { sf, array: node };
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return arrayLiteralOf(sf, node.expression, depth);
  }
  if (ts.isIdentifier(node) && depth < MAX_RESOLVE_DEPTH) {
    const resolved = resolveConst(sf, node.text);
    return resolved ? arrayLiteralOf(resolved.sf, resolved.init, depth + 1) : null;
  }
  return null;
}

/** `X.key` の X を、オブジェクトの字 (`{ … }` / `{ … } as const` / satisfies を含む) までたどる */
function objectLiteralOf(sf: ts.SourceFile, node: ts.Expression, depth: number): { sf: ts.SourceFile; object: ts.ObjectLiteralExpression } | null {
  if (ts.isObjectLiteralExpression(node)) return { sf, object: node };
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return objectLiteralOf(sf, node.expression, depth);
  }
  if (ts.isIdentifier(node) && depth < MAX_RESOLVE_DEPTH) {
    const resolved = resolveConst(sf, node.text);
    return resolved ? objectLiteralOf(resolved.sf, resolved.init, depth + 1) : null;
  }
  return null;
}

/** オブジェクトの字の、名前が key の要素の値 (`key: 値` / `'key': 値`)。無ければ null */
function propertyInitializerOf(object: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === key) return property.initializer;
  }
  return null;
}

/** テンプレートを、式の部分を値として読んだ文にする */
function renderTemplate(sf: ts.SourceFile, node: ts.TemplateExpression, depth: number, options: SubstitutionOptions): string {
  return node.head.text + node.templateSpans.map((span) => renderSubstitution(sf, span.expression, depth, options) + span.literal.text).join('');
}

/**
 * テンプレートの 1 つの式を、走査で読む文にする。文字列の字・定数 (同じファイルと import 元の const)・配列の定数の join・
 * オブジェクトの定数の要素 (`LABELS.key`)・数 (数の字・Math の関数・数どうしの計算) は値にする。見逃しの一覧にある式は空にし、それ以外の読み取れない式は印 (UNRESOLVED_SUBSTITUTION) にする
 */
function renderSubstitution(sf: ts.SourceFile, node: ts.Expression, depth: number, options: SubstitutionOptions): string {
  // 見逃しの一覧は、式の字面のまま (名前をたどる前に) 引く (`maxOffsetDays` を、初期値の関数の呼び出しでなく名前で載せられるように)
  const key = substitutionKey(sf.fileName, node.getText(sf));
  if (options.exempt.has(key)) {
    options.used?.add(key);
    return '';
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return renderTemplate(sf, node, depth, options);
  if (ts.isNumericLiteral(node)) return NUMBER_SUBSTITUTION;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    return renderSubstitution(sf, node.expression, depth, options);
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = renderSubstitution(sf, node.operand, depth, options);
    if (operand === NUMBER_SUBSTITUTION) return NUMBER_SUBSTITUTION;
  }
  if (ts.isBinaryExpression(node) && ARITHMETIC_OPERATORS.has(node.operatorToken.kind)) {
    const left = renderSubstitution(sf, node.left, depth, options);
    const right = renderSubstitution(sf, node.right, depth, options);
    if (left === NUMBER_SUBSTITUTION && right === NUMBER_SUBSTITUTION) return NUMBER_SUBSTITUTION;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Math') return NUMBER_SUBSTITUTION;
    if (callee.name.text === 'join') {
      const found = arrayLiteralOf(sf, callee.expression, depth);
      const separatorArg = node.arguments[0];
      const separator =
        separatorArg === undefined
          ? DEFAULT_JOIN_SEPARATOR
          : ts.isStringLiteral(separatorArg) || ts.isNoSubstitutionTemplateLiteral(separatorArg)
            ? separatorArg.text
            : null;
      if (found && separator !== null) {
        return found.array.elements.map((element) => renderSubstitution(found.sf, element, depth, options)).join(separator);
      }
    }
  }
  // オブジェクトの定数の要素 (`OPERATOR_ROLE_LABELS.super_admin` など。#2134 U1) は、その要素の値にする
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && depth < MAX_RESOLVE_DEPTH) {
    const found = objectLiteralOf(sf, node.expression, depth);
    const initializer = found ? propertyInitializerOf(found.object, node.name.text) : null;
    if (found && initializer) return renderSubstitution(found.sf, initializer, depth + 1, options);
  }
  if (ts.isIdentifier(node) && depth < MAX_RESOLVE_DEPTH) {
    const resolved = resolveConst(sf, node.text);
    if (resolved) return renderSubstitution(resolved.sf, resolved.init, depth + 1, options);
  }
  return ` ${UNRESOLVED_SUBSTITUTION} `;
}

/** 値の位置にある文字列を集める。名前は定数をたどる。値が `X.message` なら例外の文面として印を付ける */
function collectTexts(sf: ts.SourceFile, node: ts.Expression, depth: number, out: CollectedTexts): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.texts.push(node.text);
  } else if (ts.isTemplateExpression(node)) {
    out.texts.push(
      out.substitutions
        ? renderTemplate(sf, node, depth, out.substitutions)
        : [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '),
    );
  } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    collectTexts(sf, node.expression, depth, out);
  } else if (ts.isConditionalExpression(node)) {
    collectTexts(sf, node.whenTrue, depth, out);
    collectTexts(sf, node.whenFalse, depth, out);
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      collectTexts(sf, node.left, depth, out);
      collectTexts(sf, node.right, depth, out);
    }
  } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') {
    out.exceptionMessages += 1;
  } else if (ts.isIdentifier(node) && depth < MAX_RESOLVE_DEPTH) {
    const resolved = resolveConst(sf, node.text);
    if (resolved) collectTexts(resolved.sf, resolved.init, depth + 1, out);
  }
}

/** 本文のオブジェクトの error / message の値を集める (値がオブジェクトなら中も) */
function collectBodyTexts(sf: ts.SourceFile, body: ts.Expression, out: CollectedTexts): void {
  if (!ts.isObjectLiteralExpression(body)) return;
  for (const property of body.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (!name || !TEXT_PROPERTIES.has(name)) continue;
      if (ts.isObjectLiteralExpression(property.initializer)) collectBodyTexts(sf, property.initializer, out);
      else collectTexts(sf, property.initializer, 0, out);
    } else if (ts.isShorthandPropertyAssignment(property) && TEXT_PROPERTIES.has(property.name.text)) {
      collectTexts(sf, property.name, 0, out);
    }
  }
}

/** 本文を作る呼び出しなら、文の入る引数と、それが本文のオブジェクトか文そのものか (textCalls = 文を引数で受け取る関数と引数の位置) */
function bodyArgumentOf(
  node: ts.CallExpression,
  textCalls: ReadonlyMap<string, number> = BODY_TEXT_CALLS,
): { arg: ts.Expression; isObjectBody: boolean } | null {
  const callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'json' &&
    ts.isIdentifier(callee.expression) &&
    RESPONSE_CLASSES.has(callee.expression.text)
  ) {
    const arg = node.arguments[JSON_BODY_ARGUMENT_INDEX];
    return arg ? { arg, isObjectBody: true } : null;
  }
  if (ts.isIdentifier(callee)) {
    const index = textCalls.get(callee.text);
    const arg = index === undefined ? undefined : node.arguments[index];
    return arg ? { arg, isObjectBody: false } : null;
  }
  return null;
}

/** 本文の 1 つの呼び出しから集めた文 (空白をつめたもの) と、例外の文面の数 */
interface BodyTextsAt {
  line: number;
  texts: string[];
  exceptionMessages: number;
}

/** ファイルの失敗の本文を作る呼び出しごとに、本文の文を集める */
function bodyTextsOf(
  sf: ts.SourceFile,
  textCalls: ReadonlyMap<string, number>,
  substitutions?: SubstitutionOptions,
): BodyTextsAt[] {
  const found: BodyTextsAt[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const body = bodyArgumentOf(node, textCalls);
      if (body) {
        const out: CollectedTexts = { texts: [], exceptionMessages: 0, substitutions };
        if (body.isObjectBody) collectBodyTexts(sf, body.arg, out);
        else collectTexts(sf, body.arg, 0, out);
        found.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          texts: out.texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length > 0),
          exceptionMessages: out.exceptionMessages,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * 1 つのファイルの失敗の本文の文から、違反を集める。
 * text を渡すと、そのファイルの中身の代わりに text を読む (fixture 用。結果はキャッシュしない)
 */
export function findErrorTextViolations(file: string, text?: string): ErrorTextViolation[] {
  const sf = text === undefined ? sourceOf(file) : parse(file, text);
  const findings: ErrorTextViolation[] = [];
  for (const { line, texts, exceptionMessages } of bodyTextsOf(sf, BODY_TEXT_CALLS)) {
    for (const t of texts) {
      if (isEnglishOnly(t)) findings.push({ file, line, text: t, kind: 'english' });
    }
    for (let i = 0; i < exceptionMessages; i += 1) {
      findings.push({ file, line, text: '<X.message>', kind: 'exception-message' });
    }
  }
  return findings;
}

/** 失敗の本文の 1 つの文の場所と中身 */
export interface ErrorTextAt {
  file: string;
  line: number;
  text: string;
}

/**
 * 1 つのファイルの失敗の本文の文を、全部集める (違反かどうかは見ない)。
 * extraTextCalls を渡すと、BODY_TEXT_CALLS に加えて、その関数 (名前 → 文の引数の位置) の文も集める
 * (route の中の errorResponse(status, code, 文) のような、本文を作る自前の関数)。text は fixture 用 (findErrorTextViolations と同じ)。
 * substitutions を渡すと、テンプレートの式の部分を値として読む (renderSubstitution。読み取れない式は UNRESOLVED_SUBSTITUTION)
 */
export function findErrorTexts(
  file: string,
  options: { extraTextCalls?: ReadonlyMap<string, number>; text?: string; substitutions?: SubstitutionOptions } = {},
): ErrorTextAt[] {
  const sf = options.text === undefined ? sourceOf(file) : parse(file, options.text);
  const textCalls = new Map([...BODY_TEXT_CALLS, ...(options.extraTextCalls ?? [])]);
  return bodyTextsOf(sf, textCalls, options.substitutions).flatMap(({ line, texts }) => texts.map((text) => ({ file, line, text })));
}

/**
 * Zod の検証の文を受け取るメソッド。`.min(1, '文')`・`.refine(fn, '文')` のように文字列の引数で受け取るか、
 * `z.enum(値, { message: '文' })`・`.refine(fn, { message })`・`ctx.addIssue({ code, message })` のようにオブジェクトの引数で受け取る
 */
const ZOD_MESSAGE_METHODS: ReadonlySet<string> = new Set([
  'min', 'max', 'length', 'email', 'uuid', 'url', 'regex', 'int', 'positive', 'negative', 'nonnegative', 'nonpositive',
  'nonempty', 'datetime', 'date', 'time', 'refine', 'superRefine', 'startsWith', 'endsWith', 'gte', 'lte', 'gt', 'lt',
  'multipleOf', 'finite', 'safe', 'enum', 'string', 'number', 'boolean', 'object', 'array', 'literal', 'union', 'custom',
  'check', 'addIssue',
]);
/** Zod の名前空間 (`z.xxx(…)` は、メソッドの名前に関わらず文の引数を見る) */
const ZOD_NAMESPACE = 'z';
/** Zod のオプションのうち、検証の文が入るプロパティ (v4 は message と error) */
const ZOD_MESSAGE_PROPERTIES: ReadonlySet<string> = new Set(['message', 'error']);

/** `a.b().c` の根の式 (`z.string().min` なら `z`) */
function chainRootOf(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) current = current.expression;
  return current;
}

/** Zod の呼び出しの 1 つの引数から、検証の文を集める (オブジェクトなら message / error の値) */
function collectZodArgumentTexts(sf: ts.SourceFile, arg: ts.Expression, out: CollectedTexts): void {
  if (!ts.isObjectLiteralExpression(arg)) {
    collectTexts(sf, arg, 0, out);
    return;
  }
  for (const property of arg.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && ZOD_MESSAGE_PROPERTIES.has(property.name.text)) {
      collectTexts(sf, property.initializer, 0, out);
    } else if (ts.isShorthandPropertyAssignment(property) && ZOD_MESSAGE_PROPERTIES.has(property.name.text)) {
      collectTexts(sf, property.name, 0, out);
    }
  }
}

/**
 * 1 つのファイルの Zod の検証の文を全部集める (#1917 の続き)。
 * Zod の文は、日本語を含めば src/lib/super-admin/validation-errors.ts の validationMessageOf などがそのまま本文の message にするので、
 * 画面に出る。文字列の引数と、オプションのオブジェクトの message / error を、同じファイルと import 元の const までたどって集める。
 * 限界: Zod の外の関数が作る文・表 (オブジェクト) から引く文・関数で作る文 (`error: (issue) => …`) は見ない。text は fixture 用
 */
export function findValidationMessageTexts(
  file: string,
  options: { text?: string; substitutions?: SubstitutionOptions } = {},
): ErrorTextAt[] {
  const sf = options.text === undefined ? sourceOf(file) : parse(file, options.text);
  const found: ErrorTextAt[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const root = chainRootOf(node.expression);
      const isZodCall =
        ZOD_MESSAGE_METHODS.has(node.expression.name.text) || (ts.isIdentifier(root) && root.text === ZOD_NAMESPACE);
      if (isZodCall) {
        for (const arg of node.arguments) {
          const out: CollectedTexts = { texts: [], exceptionMessages: 0, substitutions: options.substitutions };
          collectZodArgumentTexts(sf, arg, out);
          const line = sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1;
          for (const text of out.texts) {
            const normalized = text.replace(/\s+/g, ' ').trim();
            if (normalized.length > 0) found.push({ file, line, text: normalized });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** dir の下のファイルのうち accept(名前) が真のもの (リポジトリの根からの相対パス。並べて返す) */
export function walkFiles(dir: string, accept: (name: string) => boolean): string[] {
  const result: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (accept(entry.name)) result.push(child);
    }
  };
  walk(dir);
  return result.sort();
}

/** dir の下の route.ts */
export function routeFilesUnder(dir: string): string[] {
  return walkFiles(dir, (name) => name === 'route.ts');
}

/** file が dir の下にあるか (区切りの / で切る。`src/app/api/org` は `src/app/api/organizations` を含まない) */
export function isUnderDir(file: string, dir: string): boolean {
  return file.startsWith(`${dir}/`);
}

/** `src/app/api/<最初の区切り>` (番兵が件数をまとめる単位) */
export function apiTopLevelDirOf(file: string): string {
  const rest = file.slice(API_ROUTES_ROOT.length + 1);
  const first = rest.split('/')[0];
  return `${API_ROUTES_ROOT}/${first}`;
}

/** 画面の `/api/...` の文字列 (テンプレートの式は `*` にする。? 以降は外す) */
export function collectApiPaths(file: string): string[] {
  const sf = sourceOf(file);
  const paths: string[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) {
      text = [node.head.text, ...node.templateSpans.map((s) => `*${s.literal.text}`)].join('');
    }
    if (text !== null && text.startsWith('/api/')) paths.push(text.split('?')[0]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return paths;
}

/** `/api/org/members/*\/remove` を route のファイル (動的な区切り [x] も一致) に当てる */
export function routeFileOf(apiPath: string, routeFiles: readonly string[]): string | null {
  const segments = apiPath.replace(/^\/api\//, '').split('/').filter(Boolean);
  return (
    routeFiles.find((file) => {
      const routeSegments = file.replace(/^src\/app\/api\//, '').replace(/\/route\.ts$/, '').split('/');
      return (
        routeSegments.length === segments.length &&
        routeSegments.every((seg, i) => seg === segments[i] || (/^\[[^\]]+\]$/.test(seg) && segments[i] === '*'))
      );
    }) ?? null
  );
}

/** ファイルの文字列リテラル (コメントは含まない) */
export function stringLiteralsOf(file: string): string[] {
  const sf = sourceOf(file);
  const literals: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return literals;
}

/** ファイルの文字列の文字の部分 (文字列リテラルと、テンプレートの式の外の部分。コメントは含まない) */
export function textPartsOf(file: string): string[] {
  const sf = sourceOf(file);
  const parts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) parts.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) parts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return parts;
}
