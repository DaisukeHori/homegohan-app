// @vitest-environment node
/**
 * #1444 Next 15 以降の非同期の規約 (async request API) のソース走査 contract テスト (#1621 で Next 16 に合わせた)
 *
 * Next 15 では cookies() / headers() / draftMode() と、route・page・layout の params / searchParams が Promise になった。
 * Next 15 には同期のまま読む互換の道が残っていたが、Next 16 で無くなった (同期で読むと動かない)。Next 16 では、
 * 画像を作るメタデータのファイル (opengraph-image / twitter-image / icon / apple-icon) の default export が受ける
 * params と id、sitemap の default export が受ける id も Promise になった (#1621。今のコードにこれらのファイルは無い)。
 * それに合わせて lib/supabase/server.ts の createClient() も async にした。ところが、Next 14 のつもりで書かれたコードが
 * main から入ってくると (#1415 の組織チャレンジの API が実例)、テキストの衝突が無いので git は黙って取り込み、
 *   - await しない createClient() の Promise に .auth / .from を呼んで落ちる
 *   - 同期の型で受けた params は next build の route の型検査で落ちる (tsc --noEmit では落ちない)
 * という壊れ方をする。後者は next build まで流さないと見えないので、全件の vitest で先に見張る。
 *
 *   1. 本番コード (src・lib の .ts / .tsx。テスト・__tests__ は除く) で、'@/lib/supabase/server' の createClient と
 *      'next/headers' の cookies / headers / draftMode を呼ぶ式は、すべて await の直下にある
 *   2. src/app の route.ts の HTTP メソッドの handler の第 2 引数の params、page / layout / default / template の
 *      default export の第 1 引数の params / searchParams は、Promise<...> の型で受ける。
 *      handler・default export は、関数の宣言 (export async function GET)・関数を入れた変数 (export const GET = async () => …)・
 *      あとから名前を付けて export したもの (export { handler as GET } / export default Page / export { Page as default }) の
 *      どれでも、同じファイルの関数まで辿って見る (#1621)。
 *      その引数に型を書いていないもの (({ params }) => … など。変数の型や包む関数から型が決まる書き方) は、Promise かどうかを
 *      確かめられないので落とす (#1621)。同じファイルの関数まで辿れないもの (別のファイルからの再公開・export *・
 *      関数を包む呼び出し (export const GET = withX(…)) など) も「辿れない」として落とす。
 *      Next 16 で Promise になった、画像のメタデータのファイルの default export の第 1 引数の params / id と、
 *      sitemap の default export の第 1 引数の id も、同じ決まりで見る (#1621)。
 *   3. テストの next/headers のモック (vi.mock / vi.doMock の factory が返すオブジェクト) の cookies / headers / draftMode は、
 *      Promise を返す形で書く (async の関数・Promise.resolve を返す関数・vi.fn(それら)・vi.fn().mockResolvedValue(…))。
 *      同期の値を返すモックでは、本番コードが await を忘れてもテストが通ってしまう (#1621)
 *
 * 走査は TypeScript の構文木で行うので、コメントの中の createClient() や params: { ... } には反応しない。
 *
 * 限界 (このテストは見張りであって、証明ではない。すり抜ける書き方はレビューで見る):
 *  - 関数を変数に入れてから呼ぶ (const make = createClient; make()) 書き方と、名前空間の import
 *    (import * as nh from 'next/headers'; nh.cookies()) は捕まらない (今のコードには無い)。
 *  - 引数の型を別のファイルの型 (import した型。Next の PageProps<…> なども) で書いたものは、中身を辿れないので「辿れない」として落とす
 *    (同じファイルの interface / type は辿る)。
 *  - generateMetadata など、default export・HTTP メソッド以外の関数の params は見ない (今のコードには無い)。
 *  - 1 の走査の置き場は src・lib・components・shared (ルートの components/ と shared/ は今は next/headers も
 *    '@/lib/supabase/server' も import していない)。packages/ と apps/ は Next のコードではないので見ない。
 *  - 3 のモックで、factory が返すのがオブジェクトの literal でないもの (import(...) を返すなど) と、値が変数のもの
 *    (cookies: mocks.cookies など) は中身を辿れないので「辿れない」として落とす。
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** 走査する本番コードの置き場。lib/supabase/server.ts は lib にある。ルートの components/ と shared/ も Web のコード (#1621) */
const SCAN_ROOTS = ['src', 'lib', 'components', 'shared'];
/** テストの next/headers のモックを探す置き場 (テストのファイルと、テストが読み込む helpers) */
const MOCK_SCAN_ROOTS = ['tests', 'src', 'lib'];
/** App Router のファイルの置き場 */
const APP_DIR = 'src/app';

/** next/headers のモジュール名と、Promise を返す関数 (テストのモックも Promise を返す形で書く。#1621) */
const NEXT_HEADERS_MODULE = 'next/headers';
const NEXT_HEADERS_ASYNC_APIS: readonly string[] = ['cookies', 'headers', 'draftMode'];

/** await して使う関数 (モジュール → 関数名) */
const ASYNC_FACTORIES: Readonly<Record<string, readonly string[]>> = {
  '@/lib/supabase/server': ['createClient'],
  [NEXT_HEADERS_MODULE]: NEXT_HEADERS_ASYNC_APIS,
};

/** Route Handler として export される HTTP メソッドの名前 */
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
/** route.ts の handler で params が入る引数の位置 (第 2 引数) */
const ROUTE_CONTEXT_ARG_INDEX = 1;
/** page / layout などの default export で props が入る引数の位置 (第 1 引数) */
const PAGE_PROPS_ARG_INDEX = 0;
/** default export の第 1 引数で params / searchParams を受けるファイル (App Router の規約のファイル名) */
const PAGE_LIKE_FILE = /^(page|layout|default|template)\.(ts|tsx)$/;
const ROUTE_FILE = /^route\.(ts|tsx)$/;
/** Promise で受けなければならない props の名前 (page / layout など) */
const ASYNC_PROP_NAMES: readonly string[] = ['params', 'searchParams'];
/**
 * 画像を作るメタデータのファイル (#1621 Next 16)。default export の第 1 引数の params と id が Promise になった
 * (generateImageMetadata が受ける params は同期のまま。ここでは見ない)
 */
const IMAGE_METADATA_FILE = /^(opengraph-image|twitter-image|icon|apple-icon)\.(ts|tsx)$/;
const IMAGE_METADATA_ASYNC_PROP_NAMES: readonly string[] = ['params', 'id'];
/** sitemap のファイル (#1621 Next 16)。default export の第 1 引数の id (generateSitemaps が返した id) が Promise になった */
const SITEMAP_FILE = /^sitemap\.(ts|tsx)$/;
const SITEMAP_ASYNC_PROP_NAMES: readonly string[] = ['id'];

// ─────────────────────────────────────────────────────────────────────────────
// 構文木の走査
// ─────────────────────────────────────────────────────────────────────────────

function parse(source: string, fileName: string) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** ASYNC_FACTORIES の関数を値として import したときの、ファイルの中での名前 (別名を含む) */
function asyncFactoryLocalNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const factories = ASYNC_FACTORIES[statement.moduleSpecifier.text];
    const bindings = statement.importClause?.namedBindings;
    if (!factories || statement.importClause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      if (factories.includes((element.propertyName ?? element.name).text)) names.add(element.name.text);
    }
  }
  return names;
}

/** 括弧を外した親が await か */
function isAwaited(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isAwaitExpression(current.parent);
}

/** await されていない呼び出し (例: "createClient() @ 12 行") */
function findUnawaitedAsyncCalls(source: string, fileName = 'file.ts'): string[] {
  const sf = parse(source, fileName);
  const names = asyncFactoryLocalNames(sf);
  if (names.size === 0) return [];
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text) && !isAwaited(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push(`${node.expression.text}() @ ${line} 行`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** 型が Promise<...> か */
function isPromiseType(type: ts.TypeNode | undefined): boolean {
  return !!type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'Promise';
}

/** 型の literal / 同じファイルの interface・type alias から、プロパティの一覧を取り出す。辿れなければ null */
function membersOf(type: ts.TypeNode, sf: ts.SourceFile): ts.NodeArray<ts.TypeElement> | null {
  if (ts.isTypeLiteralNode(type)) return type.members;
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const name = type.typeName.text;
    // Readonly<{ ... }> は中身を見る (src/app/layout.tsx が使う)
    const [inner] = type.typeArguments ?? [];
    if (name === 'Readonly' && inner) return membersOf(inner, sf);
    for (const statement of sf.statements) {
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) return statement.members;
      if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) return membersOf(statement.type, sf);
    }
  }
  return null;
}

/** 引数の型のうち、Promise で受けていない props (既定は params / searchParams。例: "GET の params") */
function syncPropsOf(
  label: string,
  param: ts.ParameterDeclaration | undefined,
  sf: ts.SourceFile,
  asyncPropNames: readonly string[] = ASYNC_PROP_NAMES,
): string[] {
  if (!param) return [];
  // 型を書いていない引数 (({ params }) => … など) は、変数の型や包む関数から型が決まるので、ここでは Promise かを確かめられない (#1621)
  if (!param.type) return [`${label} の引数に型が無い (Promise<...> の型を書く)`];
  const members = membersOf(param.type, sf);
  if (!members) return [`${label} の引数の型を辿れない (同じファイルの型か、型の literal で書く)`];
  const found: string[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue;
    if (asyncPropNames.includes(member.name.text) && !isPromiseType(member.type)) found.push(`${label} の ${member.name.text}`);
  }
  return found;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** export された関数。params が null のものは、同じファイルの関数まで辿れなかった */
type ExportedFunction = { name: string; isDefault: boolean; params: ts.NodeArray<ts.ParameterDeclaration> | null };

/** 関数の宣言・関数式・アロー関数なら、その引数 */
function functionParams(node: ts.Node | undefined): ts.NodeArray<ts.ParameterDeclaration> | null {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node)) return functionParams(node.expression);
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node.parameters;
  return null;
}

/** 同じファイルの一番外側で宣言された名前の関数の引数 (関数の宣言か、関数を入れた const / let / var)。無ければ null */
function localFunctionParams(sf: ts.SourceFile, name: string): ts.NodeArray<ts.ParameterDeclaration> | null {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) return statement.parameters;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return functionParams(declaration.initializer);
      }
    }
  }
  return null;
}

/**
 * export された関数の名前と引数 (#1621 で、あとから名前を付けて export する書き方も辿るようにした)。
 *   - export (default) (async) function X(...) {}
 *   - export const X = (async) (...) => {} / function (...) {}   (関数でない値 (withX(...) など) は辿れない)
 *   - export default X / export default (async) (...) => {}       (X は同じファイルの関数)
 *   - export { x as GET, Page as default }                          (x は同じファイルの関数)
 *   - export { GET } from './x' / export * from './x'               (別のファイルなので辿れない。* は名前 '*' で返す)
 */
function exportedFunctions(sf: ts.SourceFile): ExportedFunction[] {
  const result: ExportedFunction[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword) && statement.body) {
      result.push({
        name: statement.name?.text ?? 'default',
        isDefault: hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
        params: statement.parameters,
      });
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        result.push({ name: declaration.name.text, isDefault: false, params: functionParams(declaration.initializer) });
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = statement.expression;
      const params = ts.isIdentifier(expression) ? localFunctionParams(sf, expression.text) : functionParams(expression);
      result.push({ name: 'default', isDefault: true, params });
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const fromOtherFile = statement.moduleSpecifier !== undefined;
      const clause = statement.exportClause;
      if (!clause) {
        result.push({ name: '*', isDefault: false, params: null });
        continue;
      }
      if (!ts.isNamedExports(clause)) continue; // export * as ns from './x' (名前空間。handler・default export にはならない)
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        const exported = element.name.text;
        const local = (element.propertyName ?? element.name).text;
        result.push({
          name: exported,
          isDefault: exported === 'default',
          params: fromOtherFile ? null : localFunctionParams(sf, local),
        });
      }
    }
  }
  return result;
}

/** default export の第 1 引数で Promise の props を受けるファイルなら、その props の名前 (それ以外は null) */
function defaultExportAsyncPropNames(base: string): readonly string[] | null {
  if (PAGE_LIKE_FILE.test(base)) return ASYNC_PROP_NAMES;
  if (IMAGE_METADATA_FILE.test(base)) return IMAGE_METADATA_ASYNC_PROP_NAMES;
  if (SITEMAP_FILE.test(base)) return SITEMAP_ASYNC_PROP_NAMES;
  return null;
}

/** 走査するファイル (route と、default export の第 1 引数で Promise の props を受けるファイル) か */
function isRequestPropsFile(base: string): boolean {
  return ROUTE_FILE.test(base) || defaultExportAsyncPropNames(base) !== null;
}

/** route.ts / page.tsx などで、Promise で受けていない params / searchParams (画像のメタデータ・sitemap は params / id) */
function findSyncRequestProps(source: string, fileName: string): string[] {
  const base = path.basename(fileName);
  const sf = parse(source, fileName);
  const found: string[] = [];
  const defaultPropNames = defaultExportAsyncPropNames(base);
  for (const fn of exportedFunctions(sf)) {
    if (ROUTE_FILE.test(base) && fn.name === '*') {
      found.push('export * の handler を辿れない (同じファイルの関数で書く)');
      continue;
    }
    if (ROUTE_FILE.test(base) && HTTP_METHODS.includes(fn.name)) {
      if (!fn.params) found.push(`${fn.name} の handler を辿れない (同じファイルの関数で書く)`);
      else found.push(...syncPropsOf(fn.name, fn.params[ROUTE_CONTEXT_ARG_INDEX], sf));
    }
    if (defaultPropNames && fn.isDefault) {
      if (!fn.params) found.push('default export を辿れない (同じファイルの関数で書く)');
      else found.push(...syncPropsOf('default export', fn.params[PAGE_PROPS_ARG_INDEX], sf, defaultPropNames));
    }
  }
  return found;
}

function collectProductionFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectProductionFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const relativeOf = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

// ─────────────────────────────────────────────────────────────────────────────
// テストの next/headers のモック (#1621)
// ─────────────────────────────────────────────────────────────────────────────

/** モックを登録する vitest の関数 (vi.mock / vi.doMock) */
const MOCK_REGISTRARS = ['mock', 'doMock'];
/** モックの関数の呼び出しのうち、Promise を返すようにするもの (vi.fn().mockResolvedValue(…) など) */
const PROMISE_MOCK_METHODS = ['mockResolvedValue', 'mockResolvedValueOnce', 'mockRejectedValue', 'mockRejectedValueOnce'];
/** モックの関数の呼び出しのうち、渡した関数で振る舞いを決めるもの (渡した関数が Promise を返す形かを見る) */
const IMPLEMENTATION_MOCK_METHODS = ['mockImplementation', 'mockImplementationOnce'];
/** Promise を作る static メソッド (() => Promise.resolve(…) の形) */
const PROMISE_STATIC_METHODS = ['resolve', 'reject', 'all', 'allSettled', 'race', 'any'];

const unwrapParens = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrapParens(node.expression) : node;

/** vi.<name> の参照か */
function isViMember(node: ts.Expression, names: readonly string[]): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'vi' && names.includes(node.name.text);
}

/** 式が Promise を作る (Promise.resolve(…) / new Promise(…)) か */
function isPromiseConstruction(node: ts.Expression): boolean {
  const expression = unwrapParens(node);
  if (ts.isNewExpression(expression)) return ts.isIdentifier(expression.expression) && expression.expression.text === 'Promise';
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'Promise' &&
    PROMISE_STATIC_METHODS.includes(expression.expression.name.text)
  );
}

/**
 * モックの値が、呼ぶと Promise を返す形か。
 * async の関数・Promise.resolve(…) を返すアロー関数・vi.fn(それら)・vi.fn().mockResolvedValue(…) など・mockImplementation(それら)
 */
function isPromiseReturningMock(node: ts.Expression): boolean {
  const expression = unwrapParens(node);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    if (hasModifier(expression, ts.SyntaxKind.AsyncKeyword)) return true;
    return ts.isArrowFunction(expression) && !ts.isBlock(expression.body) && isPromiseConstruction(expression.body);
  }
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const [firstArg] = expression.arguments;
  if (isViMember(callee, ['fn'])) return firstArg !== undefined && isPromiseReturningMock(firstArg);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (PROMISE_MOCK_METHODS.includes(callee.name.text)) return true;
  if (IMPLEMENTATION_MOCK_METHODS.includes(callee.name.text)) return firstArg !== undefined && isPromiseReturningMock(firstArg);
  return false;
}

/** vi.mock の factory が返すオブジェクトの literal (辿れなければ null) */
function factoryObjectLiteral(factory: ts.Expression): ts.ObjectLiteralExpression | null {
  const fn = unwrapParens(factory);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  if (!ts.isBlock(fn.body)) {
    const body = unwrapParens(fn.body);
    return ts.isObjectLiteralExpression(body) ? body : null;
  }
  const returns = fn.body.statements.filter(ts.isReturnStatement);
  const [only] = returns;
  if (returns.length !== 1 || !only.expression) return null;
  const value = unwrapParens(only.expression);
  return ts.isObjectLiteralExpression(value) ? value : null;
}

/** テストの next/headers のモックのうち、cookies / headers / draftMode が Promise を返す形でないもの (例: "cookies @ 12 行") */
function findSyncNextHeadersMocks(source: string, fileName = 'file.test.ts'): string[] {
  const sf = parse(source, fileName);
  const found: string[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isViMember(node.expression, MOCK_REGISTRARS)) {
      const [moduleArg, factory] = node.arguments;
      if (moduleArg && ts.isStringLiteralLike(moduleArg) && moduleArg.text === NEXT_HEADERS_MODULE) {
        const object = factory ? factoryObjectLiteral(factory) : null;
        if (!factory) found.push(`factory が無い (自動のモックは同期で undefined を返す) @ ${lineOf(node)} 行`);
        else if (!object) found.push(`factory が返すオブジェクトを辿れない (オブジェクトの literal を返す) @ ${lineOf(node)} 行`);
        for (const property of object?.properties ?? []) {
          const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
          if (name === null || !NEXT_HEADERS_ASYNC_APIS.includes(name)) continue;
          const ok =
            (ts.isPropertyAssignment(property) && isPromiseReturningMock(property.initializer)) ||
            (ts.isMethodDeclaration(property) && hasModifier(property, ts.SyntaxKind.AsyncKeyword));
          if (!ok) found.push(`${name} @ ${lineOf(property)} 行`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** next/headers のモックを探すファイル (テスト・helpers を含む .ts / .tsx) */
function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// 検出の仕組みの確認
// ─────────────────────────────────────────────────────────────────────────────

describe('走査の仕組みの確認 (検出が空振りしないこと)', () => {
  it('await していない createClient() / cookies() / headers() を見つける (別名の import を含む)', () => {
    const imp = "import { createClient } from '@/lib/supabase/server';\n";
    expect(findUnawaitedAsyncCalls(`${imp}export async function GET() { const supabase = createClient(); }`)).toEqual([
      'createClient() @ 2 行',
    ]);
    expect(
      findUnawaitedAsyncCalls(
        "import { createClient as make } from '@/lib/supabase/server';\nasync function f() { return make().from('x'); }",
      ),
    ).toEqual(['make() @ 2 行']);
    expect(
      findUnawaitedAsyncCalls("import { cookies, headers } from 'next/headers';\nfunction f() { cookies().get('a'); headers(); }"),
    ).toEqual(['cookies() @ 2 行', 'headers() @ 2 行']);
  });

  it('await したもの・コメントの中・別のモジュールの createClient には反応しない', () => {
    const imp = "import { createClient } from '@/lib/supabase/server';\n";
    expect(findUnawaitedAsyncCalls(`${imp}async function f() { const s = await createClient(); const t = (await (createClient())); }`)).toEqual([]);
    expect(findUnawaitedAsyncCalls(`${imp}// const supabase = createClient();\n/* createClient() */`)).toEqual([]);
    expect(findUnawaitedAsyncCalls("import { createClient } from '@/lib/supabase/client';\nconst s = createClient();")).toEqual([]);
    expect(findUnawaitedAsyncCalls("import type { createClient } from '@/lib/supabase/server';\nconst s = createClient();")).toEqual([]);
  });

  it('route の handler の同期の params を見つけ、Promise で受けたものには反応しない', () => {
    expect(
      findSyncRequestProps('export async function GET(_r: Request, { params }: { params: { id: string } }) {}', 'route.ts'),
    ).toEqual(['GET の params']);
    expect(
      findSyncRequestProps(
        'type Ctx = { params: { id: string } };\nexport const DELETE = async (_r: Request, ctx: Ctx) => {};',
        'route.ts',
      ),
    ).toEqual(['DELETE の params']);
    expect(
      findSyncRequestProps('export async function POST(_r: Request, props: { params: Promise<{ id: string }> }) {}', 'route.ts'),
    ).toEqual([]);
    // route.ts の中の、handler でない関数の params には反応しない
    expect(findSyncRequestProps('async function handle(r: Request, params: { id: string }) {}', 'route.ts')).toEqual([]);
  });

  it('page / layout の default export の同期の params / searchParams を見つける', () => {
    expect(
      findSyncRequestProps(
        'export default async function Page({ params, searchParams }: { params: { id: string }; searchParams: { q?: string } }) {}',
        'page.tsx',
      ),
    ).toEqual(['default export の params', 'default export の searchParams']);
    expect(
      findSyncRequestProps(
        'interface Props { params: Promise<{ id: string }>; children: unknown }\nexport default function Layout(props: Props) {}',
        'layout.tsx',
      ),
    ).toEqual([]);
    expect(
      findSyncRequestProps('export default function Layout({ params }: Readonly<{ params: { id: string } }>) {}', 'layout.tsx'),
    ).toEqual(['default export の params']);
    expect(findSyncRequestProps("import type { Props } from './x';\nexport default function Page(p: Props) {}", 'page.tsx')).toEqual([
      'default export の引数の型を辿れない (同じファイルの型か、型の literal で書く)',
    ]);
  });
});

describe('走査の仕組みの確認: あとから名前を付けた export と、型を書いていない引数 (#1621)', () => {
  it('export { handler as GET } は同じファイルの関数まで辿り、同期の params・型の無い引数を見つける', () => {
    expect(
      findSyncRequestProps(
        'async function handler(_r: Request, { params }: { params: { id: string } }) {}\nexport { handler as GET, handler as POST };',
        'route.ts',
      ),
    ).toEqual(['GET の params', 'POST の params']);
    expect(
      findSyncRequestProps('const handler = async (_r: Request, { params }) => {};\nexport { handler as DELETE };', 'route.ts'),
    ).toEqual(['DELETE の引数に型が無い (Promise<...> の型を書く)']);
    expect(
      findSyncRequestProps(
        'async function GET(_r: Request, ctx: { params: Promise<{ id: string }> }) {}\nexport { GET };',
        'route.ts',
      ),
    ).toEqual([]);
  });

  it('型を書いていない handler の第 2 引数・page の第 1 引数を見つける (変数の型や包む関数から型が決まる書き方)', () => {
    expect(findSyncRequestProps('export async function GET(_r: Request, { params }) {}', 'route.ts')).toEqual([
      'GET の引数に型が無い (Promise<...> の型を書く)',
    ]);
    expect(
      findSyncRequestProps('type H = (r: Request, c: { params: { id: string } }) => void;\nexport const PATCH: H = async (_r, { params }) => {};', 'route.ts'),
    ).toEqual(['PATCH の引数に型が無い (Promise<...> の型を書く)']);
    expect(findSyncRequestProps('export default function Page({ params }) { return null; }', 'page.tsx')).toEqual([
      'default export の引数に型が無い (Promise<...> の型を書く)',
    ]);
    // 引数が無い・第 2 引数が無いものには反応しない
    expect(findSyncRequestProps('export async function GET(_r: Request) {}\nexport default function Page() {}', 'route.ts')).toEqual([]);
    expect(findSyncRequestProps('export default function Page() { return null; }', 'page.tsx')).toEqual([]);
  });

  it('export default Page / export { Page as default } / export default (props) => は、同じファイルの関数まで辿る', () => {
    expect(
      findSyncRequestProps(
        'function Page({ params }: { params: { id: string } }) { return null; }\nexport default Page;',
        'page.tsx',
      ),
    ).toEqual(['default export の params']);
    expect(
      findSyncRequestProps(
        'const Layout = ({ params }: { params: { slug: string } }) => null;\nexport { Layout as default };',
        'layout.tsx',
      ),
    ).toEqual(['default export の params']);
    expect(findSyncRequestProps('export default (props: { searchParams: { q: string } }) => null;', 'page.tsx')).toEqual([
      'default export の searchParams',
    ]);
    expect(
      findSyncRequestProps(
        'function Page(props: { params: Promise<{ id: string }> }) { return null; }\nexport default Page;',
        'page.tsx',
      ),
    ).toEqual([]);
  });

  it('同じファイルの関数まで辿れない handler・default export を落とす (別のファイルからの再公開・export *・包む呼び出し)', () => {
    expect(findSyncRequestProps("export { GET } from './shared';", 'route.ts')).toEqual([
      'GET の handler を辿れない (同じファイルの関数で書く)',
    ]);
    expect(findSyncRequestProps("export * from './shared';", 'route.ts')).toEqual([
      'export * の handler を辿れない (同じファイルの関数で書く)',
    ]);
    expect(findSyncRequestProps("import { withAuth } from './auth';\nexport const GET = withAuth(async () => {});", 'route.ts')).toEqual([
      'GET の handler を辿れない (同じファイルの関数で書く)',
    ]);
    expect(findSyncRequestProps("import Page from './view';\nexport default Page;", 'page.tsx')).toEqual([
      'default export を辿れない (同じファイルの関数で書く)',
    ]);
    expect(findSyncRequestProps("export { default } from './view';", 'page.tsx')).toEqual([
      'default export を辿れない (同じファイルの関数で書く)',
    ]);
    // HTTP メソッドでない export (route の設定の値・型) には反応しない
    expect(
      findSyncRequestProps(
        "export const dynamic = 'force-dynamic';\nexport const runtime = 'nodejs';\nexport type { Foo } from './types';\nexport async function GET() {}",
        'route.ts',
      ),
    ).toEqual([]);
  });
});

describe('走査の仕組みの確認: テストの next/headers のモック (#1621)', () => {
  it('同期の値を返す cookies / headers / draftMode のモックを見つける', () => {
    expect(
      findSyncNextHeadersMocks(
        [
          "vi.mock('next/headers', () => ({",
          '  cookies: () => ({ getAll: () => [] }),',
          '  headers: vi.fn(() => new Headers()),',
          '  draftMode: () => ({ isEnabled: false }),',
          '}));',
        ].join('\n'),
      ),
    ).toEqual(['cookies @ 2 行', 'headers @ 3 行', 'draftMode @ 4 行']);
    expect(findSyncNextHeadersMocks("vi.doMock('next/headers', () => { return { headers: () => new Headers() }; });")).toEqual([
      'headers @ 1 行',
    ]);
    expect(findSyncNextHeadersMocks("vi.mock('next/headers', () => ({ cookies() { return { getAll: () => [] }; } }));")).toEqual([
      'cookies @ 1 行',
    ]);
  });

  it('Promise を返す形のモックには反応しない', () => {
    expect(
      findSyncNextHeadersMocks(
        [
          "vi.mock('next/headers', async () => ({",
          '  cookies: async () => ({ getAll: () => [] }),',
          '  headers: vi.fn(async () => new Headers()),',
          '  draftMode: () => Promise.resolve({ isEnabled: false }),',
          '}));',
          "vi.doMock('next/headers', () => ({",
          '  cookies: vi.fn().mockResolvedValue({ getAll: () => [] }),',
          '  headers: vi.fn().mockImplementation(async () => new Headers()),',
          '  async draftMode() { return { isEnabled: false }; },',
          '  unrelated: () => 1,',
          '}));',
        ].join('\n'),
      ),
    ).toEqual([]);
    // next/headers 以外のモック・コメント・文字列の中には反応しない
    expect(findSyncNextHeadersMocks("vi.mock('next/navigation', () => ({ headers: () => 1 }));")).toEqual([]);
    expect(findSyncNextHeadersMocks("// vi.mock('next/headers', () => ({ cookies: () => 1 }));\nconst s = \"vi.mock('next/headers')\";")).toEqual([]);
  });

  it('辿れないモック (factory が無い・オブジェクトの literal を返さない・値が変数) を落とす', () => {
    expect(findSyncNextHeadersMocks("vi.mock('next/headers');")).toEqual(['factory が無い (自動のモックは同期で undefined を返す) @ 1 行']);
    expect(findSyncNextHeadersMocks("vi.mock('next/headers', () => import('./helpers/next-headers'));")).toEqual([
      'factory が返すオブジェクトを辿れない (オブジェクトの literal を返す) @ 1 行',
    ]);
    expect(findSyncNextHeadersMocks("vi.mock('next/headers', () => ({ cookies: mocks.cookies }));")).toEqual(['cookies @ 1 行']);
  });
});

describe('走査の仕組みの確認: Next 16 で Promise になった画像のメタデータの params / id と sitemap の id (#1621)', () => {
  it('opengraph-image / twitter-image / icon / apple-icon の default export の同期の params / id を見つける', () => {
    for (const fileName of ['opengraph-image.tsx', 'twitter-image.tsx', 'icon.tsx', 'apple-icon.ts']) {
      expect(
        findSyncRequestProps(
          'export default async function Image({ params, id }: { params: { slug: string }; id: string }) { return null; }',
          fileName,
        ),
      ).toEqual(['default export の params', 'default export の id']);
    }
    expect(findSyncRequestProps('export default function Image({ params }) { return null; }', 'opengraph-image.tsx')).toEqual([
      'default export の引数に型が無い (Promise<...> の型を書く)',
    ]);
  });

  it('画像のメタデータの params / id を Promise で受けたもの・引数の無いものには反応しない', () => {
    expect(
      findSyncRequestProps(
        'export default async function Image(props: { params: Promise<{ slug: string }>; id: Promise<string> }) { return null; }',
        'opengraph-image.tsx',
      ),
    ).toEqual([]);
    expect(findSyncRequestProps('export default function Icon() { return null; }', 'icon.tsx')).toEqual([]);
  });

  it('sitemap の default export の同期の id を見つけ、Promise で受けたものには反応しない', () => {
    expect(findSyncRequestProps('export default async function sitemap({ id }: { id: number }) { return []; }', 'sitemap.ts')).toEqual([
      'default export の id',
    ]);
    expect(findSyncRequestProps('export default async function sitemap(props: { id: Promise<string> }) { return []; }', 'sitemap.ts')).toEqual(
      [],
    );
    expect(findSyncRequestProps('export default function sitemap() { return []; }', 'sitemap.ts')).toEqual([]);
  });

  it('画像のメタデータ・sitemap のファイルは、page の searchParams の決まりでは見ない (それぞれの props の名前だけを見る)', () => {
    expect(
      findSyncRequestProps('export default function Image(props: { searchParams: { q: string } }) { return null; }', 'opengraph-image.tsx'),
    ).toEqual([]);
    expect(findSyncRequestProps('export default function sitemap(props: { params: { a: string } }) { return []; }', 'sitemap.ts')).toEqual([]);
  });

  it('走査の対象のファイル名を見分ける (robots・manifest など、引数で Promise を受けないファイルは見ない)', () => {
    for (const base of ['route.ts', 'page.tsx', 'layout.tsx', 'opengraph-image.tsx', 'twitter-image.ts', 'icon.tsx', 'apple-icon.tsx', 'sitemap.ts']) {
      expect(isRequestPropsFile(base), base).toBe(true);
    }
    for (const base of ['robots.ts', 'manifest.ts', 'opengraph-image.alt.txt', 'icons.tsx', 'sitemaps.ts']) {
      expect(isRequestPropsFile(base), base).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 本番コードの走査
// ─────────────────────────────────────────────────────────────────────────────

describe('本番コードは Next 15 以降 (Next 16) の非同期の規約に従う (#1444・#1621)', () => {
  const files = SCAN_ROOTS.flatMap((root) => collectProductionFiles(path.join(ROOT, root)));

  it('走査の対象が空でない (置き場を見失っていない)', () => {
    expect(files.some((file) => relativeOf(file) === 'lib/supabase/server.ts')).toBe(true);
    expect(files.filter((file) => ROUTE_FILE.test(path.basename(file))).length).toBeGreaterThan(0);
  });

  it("'@/lib/supabase/server' の createClient と 'next/headers' の cookies / headers / draftMode は、すべて await して呼ぶ", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      // 構文木を作る前に、対象のモジュールを import していないファイルを外す (速さのため)
      if (!Object.keys(ASYNC_FACTORIES).some((moduleName) => source.includes(moduleName))) continue;
      for (const call of findUnawaitedAsyncCalls(source, file)) violations.push(`${relativeOf(file)}: ${call}`);
    }
    expect(violations).toEqual([]);
  });

  it('src/app の route の handler の params と、page / layout の params / searchParams (画像のメタデータの params / id・sitemap の id) は Promise で受ける', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relativeOf(file);
      const base = path.basename(file);
      if (!rel.startsWith(`${APP_DIR}/`) || !isRequestPropsFile(base)) continue;
      for (const prop of findSyncRequestProps(fs.readFileSync(file, 'utf8'), file)) violations.push(`${rel}: ${prop}`);
    }
    expect(violations).toEqual([]);
  });
});

describe('テストの next/headers のモックは Promise を返す形で書く (#1621)', () => {
  const files = MOCK_SCAN_ROOTS.flatMap((root) => collectSourceFiles(path.join(ROOT, root)));
  // 構文木を作る前に、next/headers をモックしうるファイルだけに絞る (速さのため)
  const mockFiles = files.filter((file) => fs.readFileSync(file, 'utf8').includes(NEXT_HEADERS_MODULE));

  it('走査の対象が空でない (#1621 で直したモックのファイルを拾う)', () => {
    const rels = mockFiles.map(relativeOf);
    expect(rels).toContain('tests/admin-fetch-base-url.test.ts');
    expect(rels).toContain('tests/admin-fetch-forwarded-headers.test.ts');
  });

  it('vi.mock / vi.doMock の next/headers の cookies / headers / draftMode は、どれも Promise を返す', () => {
    const violations: string[] = [];
    for (const file of mockFiles) {
      for (const mock of findSyncNextHeadersMocks(fs.readFileSync(file, 'utf8'), file)) violations.push(`${relativeOf(file)}: ${mock}`);
    }
    expect(violations).toEqual([]);
  });
});
