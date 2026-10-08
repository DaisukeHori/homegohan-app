// @vitest-environment node
/**
 * #1182 環境変数の取り出しを、src/lib/env.ts / src/lib/env-required.ts に寄せておくためのソース走査 contract テスト
 *
 * 以前は `process.env.X!` が API route や Supabase クライアントの生成に散らばっていた。非 null アサーションは
 * 型の上では string にするだけで、環境変数が欠けていると undefined がそのまま Supabase クライアントや
 * fetch の URL (`undefined/functions/v1/...`) に流れ込み、変数名の分からないエラーや、無駄なリクエストになっていた。
 *
 *   1. 本番コードに `process.env.X!` / `process.env['X']!` を書かない (欠けていれば getter が変数名つきで投げる)
 *   2. env-required.ts は何も import しない / env.ts の静的な import は zod だけ
 *      (ブラウザ・Edge に zod を持ち込まない。scripts/check-env.mjs が Node.js から直接読めるようにする)
 *   3. ブラウザ向け (lib/supabase/client.ts) と Edge Runtime (middleware・cron route) のコードは env.ts に到達しない
 *   4. 一覧の全変数が .env.example に書かれている / check:env の導線がそろっている
 *
 * 走査は TypeScript の構文木で行うので、コメントや文字列の中の `process.env.X!` には反応しない。
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ENV_VARS } from '../src/lib/env';

const ROOT = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// 構文木の走査
// ─────────────────────────────────────────────────────────────────────────────

function parse(source: string, fileName: string) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** `process.env` そのものか */
function isProcessEnv(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'env' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process'
  );
}

/** `process.env.X!` / `process.env['X']!` の行番号 (1 始まり) */
function findEnvNonNullAssertions(source: string, fileName = 'file.ts'): number[] {
  const sf = parse(source, fileName);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNonNullExpression(node)) {
      const inner = node.expression;
      const isEnvRead =
        (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) && isProcessEnv(inner.expression);
      if (isEnvRead) lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

interface ModuleSpecifiers {
  /** import ... from / export ... from */
  statics: string[];
  /** import('...') と require('...') */
  dynamics: string[];
}

function findModuleSpecifiers(source: string, fileName = 'file.ts'): ModuleSpecifiers {
  const sf = parse(source, fileName);
  const found: ModuleSpecifiers = { statics: [], dynamics: [] };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.statics.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first)) found.dynamics.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. process.env.X! を書かない
// ─────────────────────────────────────────────────────────────────────────────

/** 本番コードの置き場 (テスト・__tests__ は除く)。apps/mobile も含める */
const PRODUCTION_ROOTS = [
  'src',
  'lib',
  'components',
  'apps/mobile/src',
  'apps/mobile/app',
  ...fs
    .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src`),
];

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

describe('走査の仕組みの確認 (検出が空振りしないこと)', () => {
  it('process.env.X! と process.env["X"]! を見つけ、コメント・文字列・非アサーションの読み取りは見つけない', () => {
    const source = [
      'const a = process.env.FOO!;', // 1
      "const b = process.env['BAR']!;", // 2
      'const c = process.env.BAZ;', // 3: 読み取りだけ
      'const d = process.env.QUX ?? "";', // 4
      '// process.env.COMMENTED!', // 5: コメント
      'const e = "process.env.IN_STRING!";', // 6: 文字列
      'const f = other.env.NOT_PROCESS!;', // 7: process ではない
    ].join('\n');

    expect(findEnvNonNullAssertions(source)).toEqual([1, 2]);
  });

  it('import / export from / 動的 import / require を静的と動的に分けて拾う', () => {
    const source = [
      "import { z } from 'zod';",
      "import type { A } from './a';",
      "export { b } from './b';",
      "const c = import('./c');",
      "const d = require('d');",
    ].join('\n');

    expect(findModuleSpecifiers(source)).toEqual({ statics: ['zod', './a', './b'], dynamics: ['./c', 'd'] });
  });
});

describe('本番コードに `process.env.X!` を書かない (#1182)', () => {
  const files = PRODUCTION_ROOTS.flatMap((root) => collectProductionFiles(path.join(ROOT, root)));

  it('走査の対象が空でない (置き場の名前が変わっても空振りしない)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((file) => file.endsWith(path.join('lib', 'supabase', 'server.ts')))).toBe(true);
    expect(files.some((file) => file.endsWith(path.join('src', 'lib', 'env.ts')))).toBe(true);
    expect(files.some((file) => file.includes(path.join('apps', 'mobile', 'src')))).toBe(true);
  });

  it('非 null アサーションつきの環境変数の読み取りが 1 つも無い', () => {
    const offenders = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      // 構文木の解析は重いので、process.env に触れていないファイルは読み飛ばす
      if (!/process\s*\.\s*env/.test(source)) return [];
      return findEnvNonNullAssertions(source, file).map((line) => `${path.relative(ROOT, file)}:${line}`);
    });

    // 失敗したら、`process.env.X!` を src/lib/env-required.ts の getSupabaseUrl() などか、
    // src/lib/env.ts の getOptionalEnv() に置き換える (欠けていれば変数名つきで投げる / undefined を返す)
    expect(offenders).toEqual([]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. env-required.ts / env.ts の依存
// ─────────────────────────────────────────────────────────────────────────────

describe('env-required.ts と env.ts の依存 (#1182)', () => {
  it('env-required.ts は何も import しない (ブラウザ・Edge に何も持ち込まない)', () => {
    expect(findModuleSpecifiers(readRepoFile('src/lib/env-required.ts'), 'env-required.ts')).toEqual({
      statics: [],
      dynamics: [],
    });
  });

  it('env.ts の静的な import は zod だけ (scripts/check-env.mjs が Node.js から直接読める)。動的に読むのは db-logger だけ', () => {
    const { statics, dynamics } = findModuleSpecifiers(readRepoFile('src/lib/env.ts'), 'env.ts');

    expect(statics).toEqual(['zod']);
    expect(dynamics).toEqual(['./db-logger']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ブラウザ・Edge のコードが env.ts (zod) に到達しない
// ─────────────────────────────────────────────────────────────────────────────

/** 他のファイルへの import を、リポジトリの中のファイルに解決する (node_modules などは null) */
function resolveRepoImport(from: string, specifier: string): string | null {
  const bases: string[] = [];
  if (specifier.startsWith('.')) {
    bases.push(path.resolve(path.dirname(from), specifier));
  } else if (specifier.startsWith('@/')) {
    // tsconfig の paths: @/* → ./src/* → ./*
    bases.push(path.join(ROOT, 'src', specifier.slice(2)), path.join(ROOT, specifier.slice(2)));
  } else {
    return null;
  }
  for (const base of bases) {
    for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const candidate = base + suffix;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

/** entry から静的 import をたどって到達できる、リポジトリ内のファイルの集合 */
function reachableFiles(entry: string): Map<string, string | null> {
  // 値は「どのファイルから来たか」(経路を示すため)
  const seen = new Map<string, string | null>([[entry, null]]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    const { statics } = findModuleSpecifiers(fs.readFileSync(file, 'utf-8'), file);
    for (const specifier of statics) {
      const resolved = resolveRepoImport(file, specifier);
      if (resolved && !seen.has(resolved)) {
        seen.set(resolved, file);
        stack.push(resolved);
      }
    }
  }
  return seen;
}

function importChain(seen: Map<string, string | null>, target: string): string {
  const chain: string[] = [];
  for (let current: string | null | undefined = target; current; current = seen.get(current)) {
    chain.unshift(path.relative(ROOT, current));
  }
  return chain.join(' -> ');
}

describe('ブラウザ・Edge Runtime のコードは zod を持つ src/lib/env.ts に到達しない (#1182)', () => {
  // zod は最小のスキーマでも minify 後に約 59 KB (gzip 約 16 KB)。ブラウザ向けのバンドルは全ページの JS に、
  // Edge のバンドルは middleware の全リクエストに効く。必須の変数は何も import しない env-required.ts から取り出す
  const ENTRIES = [
    { file: 'lib/supabase/client.ts', why: 'ブラウザの Supabase クライアント (ほぼ全ページの JS に入る)' },
    { file: 'lib/supabase/middleware.ts', why: 'src/middleware.ts が呼ぶ Edge Runtime のコード' },
    { file: 'src/middleware.ts', why: 'Edge Runtime の middleware' },
    { file: 'src/app/api/cron/process-menu-queue/route.ts', why: "export const runtime = 'edge' の route" },
  ];
  const ENV_FILE = path.join(ROOT, 'src/lib/env.ts');

  it.each(ENTRIES)('$file ($why) から静的 import をたどっても env.ts に着かない', ({ file }) => {
    const seen = reachableFiles(path.join(ROOT, file));

    expect(seen.size).toBeGreaterThan(1);
    expect(seen.has(ENV_FILE) ? importChain(seen, ENV_FILE) : null).toBeNull();
  });

  it.each(ENTRIES)('$file は env-required.ts から必須の環境変数を取り出している', ({ file }) => {
    const seen = reachableFiles(path.join(ROOT, file));

    expect(seen.has(path.join(ROOT, 'src/lib/env-required.ts'))).toBe(true);
  });

  it('到達性の確認が空振りしない: env.ts を import するファイルからは env.ts に着く', () => {
    const probe = path.join(ROOT, 'src/__tests__/lib/env.test.ts');

    expect(reachableFiles(probe).has(ENV_FILE)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 導線: .env.example・check:env
// ─────────────────────────────────────────────────────────────────────────────

describe('.env.example と check:env の導線 (#1182)', () => {
  it('一覧の全変数が .env.example に書かれている (コメントアウトした例でもよい)', () => {
    const example = readRepoFile('.env.example');
    const undocumented = ENV_VARS.filter((entry) => !new RegExp(`^#?\\s*${entry.name}=`, 'm').test(example)).map(
      (entry) => entry.name,
    );

    // 失敗したら、足した変数を .env.example に書く (必須か任意か、無いと何が起きるかは src/lib/env.ts に書いてある)
    expect(undocumented).toEqual([]);
  });

  it('npm run check:env が scripts/check-env.mjs を指し、古い check-env.sh は無い', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };

    expect(pkg.scripts['check:env']).toContain('scripts/check-env.mjs');
    expect(fs.existsSync(path.join(ROOT, 'scripts/check-env.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'scripts/lib/check-env.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'check-env.sh'))).toBe(false);
  });

  it('ENV_SETUP.md と .env.example が check:env の使い方を案内している', () => {
    expect(readRepoFile('ENV_SETUP.md')).toContain('npm run check:env');
    expect(readRepoFile('.env.example')).toContain('npm run check:env');
  });
});
