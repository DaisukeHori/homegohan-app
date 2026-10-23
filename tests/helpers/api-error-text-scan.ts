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
 *     値の位置 = 式そのもの・三項演算子の 2 つの枝・?? / || の両辺・括弧・as / satisfies・テンプレートの文字の部分。
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
}

/** 値の位置にある文字列を集める。名前は定数をたどる。値が `X.message` なら例外の文面として印を付ける */
function collectTexts(sf: ts.SourceFile, node: ts.Expression, depth: number, out: CollectedTexts): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.texts.push(node.text);
  } else if (ts.isTemplateExpression(node)) {
    out.texts.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
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
    const local = findConstInitializer(sf, node.text);
    if (local) {
      collectTexts(sf, local, depth + 1, out);
      return;
    }
    const from = importSourceOf(sf, node.text);
    if (from) {
      const imported = sourceOf(from);
      const init = findConstInitializer(imported, node.text);
      if (init) collectTexts(imported, init, depth + 1, out);
    }
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
function bodyTextsOf(sf: ts.SourceFile, textCalls: ReadonlyMap<string, number>): BodyTextsAt[] {
  const found: BodyTextsAt[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const body = bodyArgumentOf(node, textCalls);
      if (body) {
        const out: CollectedTexts = { texts: [], exceptionMessages: 0 };
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
 * (route の中の errorResponse(status, code, 文) のような、本文を作る自前の関数)。text は fixture 用 (findErrorTextViolations と同じ)
 */
export function findErrorTexts(
  file: string,
  options: { extraTextCalls?: ReadonlyMap<string, number>; text?: string } = {},
): ErrorTextAt[] {
  const sf = options.text === undefined ? sourceOf(file) : parse(file, options.text);
  const textCalls = new Map([...BODY_TEXT_CALLS, ...(options.extraTextCalls ?? [])]);
  return bodyTextsOf(sf, textCalls).flatMap(({ line, texts }) => texts.map((text) => ({ file, line, text })));
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
