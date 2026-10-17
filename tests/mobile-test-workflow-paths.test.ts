// @vitest-environment node
/**
 * tests/mobile-test-workflow-paths.test.ts
 *
 * .github/workflows/mobile-test.yml (モバイルの jest) の `on.pull_request.paths` が、モバイルが読むリポジトリ内の
 * apps/mobile の外のコードをすべて含んでいるかを調べる (#1574)。
 *
 * 以前は packages/shared/** が無く、パスワードの規則やアカウント変更の文言のように shared だけを変える PR では、
 * モバイルの jest が走らなかった。同じ型の抜けを作らないよう、必要な範囲はモバイルの依存と import から数える:
 *   - apps/mobile/package.json の依存のうち、このリポジトリのワークスペース (packages/<dir>) にあるもの → packages/<dir>/**
 *   - apps/mobile の app/・src/ のコードが、相対パスで apps/mobile の外を読んでいるもの (supabase/functions/_shared・
 *     lib/slot-builder.ts など) と、そのファイルがさらに読むもの → そのファイルを含むパターンがあること。
 *     jest が実際に読み込む import だけを数える (`import type` は実行時に消えるので数えない)
 * GitHub には接続しない (ファイルを読むだけ)。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'mobile-test.yml');
const MOBILE = path.join(ROOT, 'apps', 'mobile');
const PACKAGES = path.join(ROOT, 'packages');
/** apps/mobile のうち、アプリのコードが入っているディレクトリ (テストと設定ファイルは数えない) */
const MOBILE_CODE_DIRS = ['app', 'src'];
const CODE_FILE = /\.(ts|tsx|js|jsx)$/;
/** 拡張子を省いた import の指し先を、実際のファイルに解決するときに試す後ろの部分 (TypeScript・Metro と同じ順) */
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
/** ルートの tsconfig の paths の `@/*` (src/ → ルートの順に探す。vitest.config.ts の at-alias と同じ) */
const AT_ALIAS_PREFIX = '@/';
const AT_ALIAS_BASES = ['src', '.'];

function workflowPaths(): string[] {
  const doc = yaml.load(readFileSync(WORKFLOW, 'utf8')) as { on?: { pull_request?: { paths?: unknown } } };
  const paths = doc.on?.pull_request?.paths;
  if (!Array.isArray(paths)) throw new Error('mobile-test.yml の on.pull_request.paths が配列ではありません');
  return paths.map(String);
}

/** `dir/**` の形のパターンが、リポジトリのルートからの相対パス file を含むか (このワークフローが使う形だけを扱う) */
function covers(patterns: readonly string[], file: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === file) return true;
    if (!pattern.endsWith('/**')) return false;
    return file.startsWith(pattern.slice(0, -'**'.length));
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_FILE.test(name)) out.push(full);
  }
  return out;
}

/** 実行時に読み込む import の指し先 (`import type`・`export type` は数えない。require と import() は数える) */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isRequire || node.expression.kind === ts.SyntaxKind.ImportKeyword) out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** 指し先を、リポジトリの中の実際のファイル (絶対パス) にする。パッケージ (node_modules・ワークスペース) は null */
function resolveInRepo(fromFile: string, specifier: string): string | null {
  const bases = specifier.startsWith('.')
    ? [path.resolve(path.dirname(fromFile), specifier)]
    : specifier.startsWith(AT_ALIAS_PREFIX)
      ? AT_ALIAS_BASES.map((base) => path.join(ROOT, base, specifier.slice(AT_ALIAS_PREFIX.length)))
      : [];
  for (const base of bases) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${base}${suffix}`;
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

function toRepoPath(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function workspacePackageDirs(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const dir of readdirSync(PACKAGES)) {
    const manifest = path.join(PACKAGES, dir, 'package.json');
    try {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (name) byName.set(name, dir);
    } catch {
      // package.json の無いディレクトリはワークスペースではない
    }
  }
  return byName;
}

describe('mobile-test.yml の paths (#1574)', () => {
  const patterns = workflowPaths();

  it('packages/shared/** を含む (shared だけを変える PR でもモバイルの jest を回す)', () => {
    expect(patterns).toContain('packages/shared/**');
  });

  it('モバイルが依存するワークスペースのパッケージは、すべて paths に入っている', () => {
    const manifest = JSON.parse(readFileSync(path.join(MOBILE, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    const workspaces = workspacePackageDirs();
    const used = deps.filter((dep) => workspaces.has(dep)).map((dep) => `packages/${workspaces.get(dep)}/`);
    // 数え方が壊れて 0 件になり、空のまま通るのを防ぐ (少なくとも shared と core は使っている)
    expect(used).toEqual(expect.arrayContaining(['packages/shared/', 'packages/core/']));
    const missing = used.filter((dir) => !covers(patterns, `${dir}package.json`));
    expect(missing).toEqual([]);
  });

  it('モバイルのコードが実行時に読む apps/mobile の外のファイル (読んだ先がさらに読むものを含む) は、すべて paths に入っている', () => {
    const mobilePrefix = `${toRepoPath(MOBILE)}/`;
    const outside = new Set<string>();
    const queue: string[] = [];
    const enqueueImportsOf = (file: string) => {
      for (const specifier of runtimeSpecifiers(file)) {
        const target = resolveInRepo(file, specifier);
        if (!target) continue;
        const repoPath = toRepoPath(target);
        if (repoPath.startsWith(mobilePrefix) || outside.has(repoPath)) continue;
        outside.add(repoPath);
        queue.push(target);
      }
    };
    for (const dir of MOBILE_CODE_DIRS) {
      for (const file of walk(path.join(MOBILE, dir))) enqueueImportsOf(file);
    }
    // apps/mobile の外のファイルがさらに読むもの (@/ の指し先も含む)。ワークスペースのパッケージは上の it が受け持つ
    // (走査の途中で queue に足されたものも、この for が順に読む)
    for (let i = 0; i < queue.length; i++) enqueueImportsOf(queue[i]);

    // 数え方が壊れて 0 件になり、空のまま通るのを防ぐ (supabase/functions/_shared と lib/slot-builder.ts を読んでいる)
    expect([...outside].some((target) => target.startsWith('supabase/functions/_shared/'))).toBe(true);
    expect(outside.has('lib/slot-builder.ts')).toBe(true);
    const missing = [...outside].filter((target) => !covers(patterns, target)).sort();
    expect(missing).toEqual([]);
  });

  it('import type だけで読むファイル (jest では読み込まれない) は数えない', () => {
    // apps/mobile は types/domain.ts を import type でだけ読む。数えると、jest に関係の無い型の変更でも回すことになる
    const typeOnly = readFileSync(path.join(MOBILE, 'src', 'hooks', 'useV4MenuGeneration.ts'), 'utf8');
    expect(typeOnly).toMatch(/import type \{[^}]*\} from "(\.\.\/)+types\/domain"/);
    expect(runtimeSpecifiers(path.join(MOBILE, 'src', 'hooks', 'useV4MenuGeneration.ts'))).not.toContain('../../../../types/domain');
  });
});
