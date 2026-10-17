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
 *   - apps/mobile の app/・src/ のコードが、相対パスで apps/mobile の外を読んでいるもの (supabase/functions/_shared など)
 *     → そのファイルを含むパターンがあること
 * GitHub には接続しない (ファイルを読むだけ)。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'mobile-test.yml');
const MOBILE = path.join(ROOT, 'apps', 'mobile');
const PACKAGES = path.join(ROOT, 'packages');
/** apps/mobile のうち、アプリのコードが入っているディレクトリ (テストと設定ファイルは数えない) */
const MOBILE_CODE_DIRS = ['app', 'src'];
const CODE_FILE = /\.(ts|tsx|js|jsx)$/;
/** import / export ... from '...' と require('...') の指し先 */
const IMPORT_SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

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

  it('モバイルのコードが相対パスで読む apps/mobile の外のファイルは、すべて paths に入っている', () => {
    const outside = new Set<string>();
    for (const dir of MOBILE_CODE_DIRS) {
      for (const file of walk(path.join(MOBILE, dir))) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(IMPORT_SPECIFIER)) {
          const specifier = match[1];
          if (!specifier.startsWith('.')) continue;
          const target = path.relative(ROOT, path.resolve(path.dirname(file), specifier));
          if (!target.startsWith(`apps${path.sep}mobile${path.sep}`)) outside.add(target.split(path.sep).join('/'));
        }
      }
    }
    // 数え方が壊れて 0 件になり、空のまま通るのを防ぐ (supabase/functions/_shared を読んでいる)
    expect([...outside].some((target) => target.startsWith('supabase/functions/_shared/'))).toBe(true);
    const missing = [...outside].filter((target) => !covers(patterns, target)).sort();
    expect(missing).toEqual([]);
  });
});
