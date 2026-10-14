// @vitest-environment node
/**
 * #1444 Next 15 の非同期の規約 (async request API) のソース走査 contract テスト
 *
 * Next 15 では cookies() / headers() / draftMode() と、route・page・layout の params / searchParams が Promise になった。
 * それに合わせて lib/supabase/server.ts の createClient() も async にした。ところが、Next 14 のつもりで書かれたコードが
 * main から入ってくると (#1415 の組織チャレンジの API が実例)、テキストの衝突が無いので git は黙って取り込み、
 *   - await しない createClient() の Promise に .auth / .from を呼んで落ちる
 *   - 同期の型で受けた params は next build の route の型検査で落ちる (tsc --noEmit では落ちない)
 * という壊れ方をする。後者は next build まで流さないと見えないので、全件の vitest で先に見張る。
 *
 *   1. 本番コード (src・lib の .ts / .tsx。テスト・__tests__ は除く) で、'@/lib/supabase/server' の createClient と
 *      'next/headers' の cookies / headers / draftMode を呼ぶ式は、すべて await の直下にある
 *   2. src/app の route.ts の HTTP メソッドの handler の第 2 引数の params、page / layout / default / template の
 *      default export の第 1 引数の params / searchParams は、Promise<...> の型で受ける
 *
 * 走査は TypeScript の構文木で行うので、コメントの中の createClient() や params: { ... } には反応しない。
 *
 * 限界 (このテストは見張りであって、証明ではない。すり抜ける書き方はレビューで見る):
 *  - 関数を変数に入れてから呼ぶ (const make = createClient; make()) 書き方は捕まらない。
 *  - 引数の型を別のファイルの型 (import した型) で書いたものは、中身を辿れないので「辿れない」として落とす
 *    (同じファイルの interface / type は辿る)。
 *  - generateMetadata など、default export 以外の関数の params は見ない (今のコードには無い)。
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** 走査する本番コードの置き場。lib/supabase/server.ts は lib にある */
const SCAN_ROOTS = ['src', 'lib'];
/** App Router のファイルの置き場 */
const APP_DIR = 'src/app';

/** await して使う関数 (モジュール → 関数名) */
const ASYNC_FACTORIES: Readonly<Record<string, readonly string[]>> = {
  '@/lib/supabase/server': ['createClient'],
  'next/headers': ['cookies', 'headers', 'draftMode'],
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
/** Promise で受けなければならない props の名前 */
const ASYNC_PROP_NAMES = ['params', 'searchParams'];

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

/** 引数の型のうち、Promise で受けていない params / searchParams (例: "GET の params") */
function syncPropsOf(label: string, param: ts.ParameterDeclaration | undefined, sf: ts.SourceFile): string[] {
  if (!param?.type) return [];
  const members = membersOf(param.type, sf);
  if (!members) return [`${label} の引数の型を辿れない (同じファイルの型か、型の literal で書く)`];
  const found: string[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue;
    if (ASYNC_PROP_NAMES.includes(member.name.text) && !isPromiseType(member.type)) found.push(`${label} の ${member.name.text}`);
  }
  return found;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** 関数の宣言・export const X = (async) (...) => の、名前と引数 */
function exportedFunctions(sf: ts.SourceFile): { name: string; isDefault: boolean; params: ts.NodeArray<ts.ParameterDeclaration> }[] {
  const result: { name: string; isDefault: boolean; params: ts.NodeArray<ts.ParameterDeclaration> }[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      result.push({
        name: statement.name?.text ?? 'default',
        isDefault: hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
        params: statement.parameters,
      });
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          result.push({ name: declaration.name.text, isDefault: false, params: init.parameters });
        }
      }
    }
  }
  return result;
}

/** route.ts / page.tsx などで、Promise で受けていない params / searchParams */
function findSyncRequestProps(source: string, fileName: string): string[] {
  const base = path.basename(fileName);
  const sf = parse(source, fileName);
  const found: string[] = [];
  for (const fn of exportedFunctions(sf)) {
    if (ROUTE_FILE.test(base) && HTTP_METHODS.includes(fn.name)) {
      found.push(...syncPropsOf(fn.name, fn.params[ROUTE_CONTEXT_ARG_INDEX], sf));
    }
    if (PAGE_LIKE_FILE.test(base) && fn.isDefault) {
      found.push(...syncPropsOf('default export', fn.params[PAGE_PROPS_ARG_INDEX], sf));
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

// ─────────────────────────────────────────────────────────────────────────────
// 本番コードの走査
// ─────────────────────────────────────────────────────────────────────────────

describe('本番コードは Next 15 の非同期の規約に従う (#1444)', () => {
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

  it('src/app の route の handler の params と、page / layout の params / searchParams は Promise で受ける', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relativeOf(file);
      const base = path.basename(file);
      if (!rel.startsWith(`${APP_DIR}/`) || !(ROUTE_FILE.test(base) || PAGE_LIKE_FILE.test(base))) continue;
      for (const prop of findSyncRequestProps(fs.readFileSync(file, 'utf8'), file)) violations.push(`${rel}: ${prop}`);
    }
    expect(violations).toEqual([]);
  });
});
