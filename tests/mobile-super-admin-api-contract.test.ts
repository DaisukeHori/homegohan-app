/**
 * #1137 モバイルの運営画面 (apps/mobile/app/(super-admin)) が呼ぶ API が、サーバーに実在することの contract テスト
 *
 * 背景: モバイルの機能フラグ画面は GET / PUT /api/super-admin/feature-flags を呼んでいたが、
 * サーバーにあるのは GET / POST /api/super-admin/flags と PATCH / DELETE /api/super-admin/flags/[key] で、
 * 画面は常に失敗していた。管理者管理画面も、サーバーに無い PUT /api/super-admin/admins/[id] を呼んでいた。
 * モバイルの jest テストは API をモックするため、パスやメソッドの食い違いには気付けない。
 *
 * このテストは、(super-admin) の画面が呼ぶ api.get / post / put / patch / del のパスとメソッドを
 * TypeScript の構文木で集め、src/app/api の route.ts が実際に export している HTTP メソッドと突き合わせる。
 * 画面のパスやサーバーの route を変えてこのテストが落ちたら、もう一方を合わせて直す。
 *
 * 見るのは「パスとメソッドが実在するか」だけで、リクエスト・レスポンスの形までは見ない。
 * 形は各画面の jest テスト (apps/mobile/__tests__/super-admin) で、実際の応答の形を使って確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const API_ROOT = path.join(ROOT, 'src/app/api');
const SCREEN_ROOT = path.join(ROOT, 'apps/mobile/app/(super-admin)');

// @homegohan/core の HttpClient のメソッド名 → HTTP メソッド
const CLIENT_METHODS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  del: 'DELETE',
};
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// テンプレートリテラルの `${...}` 部分を表す目印 (パスの 1 セグメント以内に入る)
const PARAM = '\u0000';

interface ApiCall {
  file: string;
  method: string;
  path: string;
}

interface RouteFile {
  file: string;
  segments: string[];
  methods: Set<string>;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

function collectFiles(dir: string, match: (name: string) => boolean): string[] {
  // ディレクトリが無いときは空にして、下の「走査が機能している」テストに分かりやすい失敗メッセージを出させる
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      files.push(...collectFiles(full, match));
    } else if (match(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true, kind);
}

// ─────────────────────────────────────────────
// 画面側: api.<method>('/api/...') の呼び出しを集める
// ─────────────────────────────────────────────

/** 文字列リテラル / テンプレートリテラルからパスを取り出す。`${...}` は PARAM に置き換える */
function staticPathOf(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => PARAM + span.literal.text).join('');
  }
  return null;
}

function extractApiCalls(file: string): ApiCall[] {
  const sf = parse(file);
  const relative = toPosix(path.relative(ROOT, file));
  const calls: ApiCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = CLIENT_METHODS[node.expression.name.text];
      const first = node.arguments[0];
      const apiPath = method && first ? staticPathOf(first) : null;
      if (method && apiPath && apiPath.startsWith('/api/')) {
        // クエリ文字列は route の判定に関係しない
        calls.push({ file: relative, method, path: apiPath.split('?')[0] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

// ─────────────────────────────────────────────
// サーバー側: route.ts が export している HTTP メソッドを集める
// ─────────────────────────────────────────────

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function extractExportedMethods(file: string): Set<string> {
  const sf = parse(file);
  const methods = new Set<string>();
  for (const statement of sf.statements) {
    // export async function GET() {}
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
      if (HTTP_METHODS.includes(statement.name.text)) methods.add(statement.name.text);
    }
    // export const GET = ...
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && HTTP_METHODS.includes(declaration.name.text)) {
          methods.add(declaration.name.text);
        }
      }
    }
    // export { GET, handler as POST }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (HTTP_METHODS.includes(element.name.text)) methods.add(element.name.text);
      }
    }
  }
  return methods;
}

function loadRoutes(): RouteFile[] {
  return collectFiles(API_ROOT, (name) => /^route\.(ts|tsx|js|jsx)$/.test(name)).map((file) => {
    const dirSegments = toPosix(path.relative(API_ROOT, path.dirname(file))).split('/').filter(Boolean);
    return {
      file: toPosix(path.relative(ROOT, file)),
      // ルートグループ "(group)" は URL に含まれない
      segments: ['api', ...dirSegments.filter((s) => !/^\(.+\)$/.test(s))],
      methods: extractExportedMethods(file),
    };
  });
}

/** route のセグメント列がリクエストのパスに一致するか (Next.js の動的セグメントを考慮する) */
function matchesRoute(routeSegments: string[], requestSegments: string[]): boolean {
  let i = 0;
  for (const segment of routeSegments) {
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) return true; // [[...slug]]: 0 個以上
    if (/^\[\.\.\..+\]$/.test(segment)) return requestSegments.length > i; // [...slug]: 1 個以上
    if (i >= requestSegments.length) return false;
    // 動的セグメント [id] は何にでも一致する。静的セグメントは完全一致だけ
    // (`${...}` を含むセグメントは、静的セグメントには一致させない)
    if (!/^\[.+\]$/.test(segment) && segment !== requestSegments[i]) return false;
    i++;
  }
  return i === requestSegments.length;
}

const routes = loadRoutes();

/** そのパスに一致する route が export している HTTP メソッドの和集合 */
function methodsServedAt(requestPath: string): Set<string> {
  const requestSegments = requestPath.split('/').filter(Boolean);
  const served = new Set<string>();
  for (const route of routes) {
    if (matchesRoute(route.segments, requestSegments)) route.methods.forEach((m) => served.add(m));
  }
  return served;
}

const displayPath = (p: string) => p.split(PARAM).join('${...}');

const calls: ApiCall[] = collectFiles(SCREEN_ROOT, (name) => /\.(ts|tsx)$/.test(name))
  .sort()
  .flatMap(extractApiCalls);

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────
describe('モバイルの運営画面 ((super-admin)) が呼ぶ API はサーバーに実在する (#1137)', () => {
  it('走査が機能している: 画面の API 呼び出しと、サーバーの route を検出している', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(
      fs.existsSync(SCREEN_ROOT),
      `${toPosix(path.relative(ROOT, SCREEN_ROOT))} が無い。画面を移動したならこのテストの SCREEN_ROOT も直す。画面ごと消したならこのテストも消す`,
    ).toBe(true);
    expect(fs.existsSync(API_ROOT), `${toPosix(path.relative(ROOT, API_ROOT))} が無い`).toBe(true);

    const screens = new Set(calls.map((c) => c.file));
    expect([...screens]).toEqual(
      expect.arrayContaining([
        'apps/mobile/app/(super-admin)/super-admin/admins.tsx',
        'apps/mobile/app/(super-admin)/super-admin/database.tsx',
        'apps/mobile/app/(super-admin)/super-admin/feature-flags.tsx',
        'apps/mobile/app/(super-admin)/super-admin/settings.tsx',
      ]),
    );
    expect(routes.length).toBeGreaterThan(50);

    // 実在する route は、メソッドごとに検出できる
    expect([...methodsServedAt('/api/super-admin/flags')].sort()).toEqual(['GET', 'POST']);
    expect([...methodsServedAt(`/api/super-admin/flags/${PARAM}`)].sort()).toEqual(['DELETE', 'PATCH']);
    expect([...methodsServedAt(`/api/admin/users/${PARAM}/role`)].sort()).toEqual(['PATCH', 'PUT']);
  });

  it('走査が機能している: 過去に食い違っていたパスとメソッドは「無い」と判定する', () => {
    // #1137 で見つかった、画面だけが呼んでいてサーバーに無かったもの
    expect(methodsServedAt('/api/super-admin/feature-flags').size).toBe(0);
    expect(methodsServedAt(`/api/super-admin/admins/${PARAM}`).size).toBe(0);
    // パスは実在しても、メソッドが無いものは無い (flags は GET / POST。PUT は無い)
    expect(methodsServedAt('/api/super-admin/flags').has('PUT')).toBe(false);
  });

  for (const call of calls) {
    it(`${call.method} ${displayPath(call.path)} (${path.basename(call.file)}) に対応する route.ts がある`, () => {
      const served = methodsServedAt(call.path);
      const hint =
        served.size === 0
          ? 'そのパスの route.ts がサーバーに無い'
          : `そのパスの route.ts は ${[...served].sort().join(' / ')} だけを export している`;
      expect(served.has(call.method), `${call.method} ${displayPath(call.path)}: ${hint}`).toBe(true);
    });
  }
});
