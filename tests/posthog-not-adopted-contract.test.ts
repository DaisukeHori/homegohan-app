// @vitest-environment node
/**
 * #1166 PostHog (利用状況の計測) を採用しないことを守る contract テスト
 *
 * オーナー判断 (2026-10-08): PostHog による利用状況の計測は採用しない。Web・モバイルから SDK とコードを取り除いた。
 * 計測の SDK は、入れるだけで利用者の ID や操作を外部へ送れてしまう。取り除いたあとに黙って戻らないよう、次を検査する。
 *   1. ソース (Web・モバイル・共通 package・Edge Function・scripts・ルートの設定ファイル) が、PostHog の package を読み込んでいない
 *   2. package.json (ルート・apps/mobile・packages/*) の依存に、PostHog の package が無い
 *   3. 環境変数の設定例 (.env.example・apps/mobile/env.example) に、POSTHOG の変数が無い
 * CSP (next.config.mjs の connect-src) に PostHog の送信先が無いことは、src/__tests__/config/next-config-headers.test.ts が検査する。
 *
 * 走査は TypeScript の構文木で行うので、コメントや文字列の中の言及 (経緯の説明など) には反応しない。
 *
 * このテストが落ちたら: PostHog を戻す判断は、まだ出ていない。計測を足したいときは、先に「何を・どこへ・どの同意で」
 * 送るかを決めて、オーナーの判断を取り直すこと。そのうえで、この判断を書いた docs/operations/posthog-dashboard.md と
 * docs/design/operator/07-audit-monitoring.md §15 を直し、このテストを外す。
 * (ハンズオンツアーの fireAnalytics は、送り先 (adapter) を誰も注入していないので、PostHog を外したあとは何も送らない。
 *  このテストは PostHog だけを対象にしていて、adapter を注入しているかどうかまでは検査しない。)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** ソースを探すリポジトリ直下のディレクトリ (tests/ と docs/ は対象にしない)。ルート直下の設定ファイルも別に読む */
const SCAN_ROOTS = [
  'src',
  'components',
  'lib',
  'types',
  'shared',
  'scripts',
  'packages',
  'apps/mobile',
  'supabase/functions',
];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__', '.next', '.expo', 'dist', 'build', 'coverage']);
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** package 名・import のパスに posthog が入っているか (posthog-js / posthog-react-native / @posthog/core / @/lib/posthog など) */
const isPostHogName = (name: string) => /posthog/i.test(name);

function scriptKindOf(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** ソースが読み込んでいる (import / export from / require / 動的 import) module 名を返す */
function findModuleSpecifiers(source: string, fileName = 'file.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first)) {
        specifiers.push(first.text);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteral(expression)) specifiers.push(expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return specifiers;
}

/** package.json の依存のうち、PostHog の package を `dependencies.posthog-js` の形で返す */
function findPostHogDependencies(pkg: Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>): string[] {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(pkg[field] ?? {})
      .filter(isPostHogName)
      .map((name) => `${field}.${name}`),
  );
}

function collectSourceFiles(relativeDir: string): string[] {
  const absolute = path.join(ROOT, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...collectSourceFiles(relative));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

const rootConfigFiles = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name))
  .map((entry) => entry.name);
const sourceFiles = [...rootConfigFiles, ...SCAN_ROOTS.flatMap(collectSourceFiles)];

const postHogImports: string[] = [];
for (const file of sourceFiles) {
  const found = findModuleSpecifiers(fs.readFileSync(path.join(ROOT, file), 'utf-8'), file).filter(isPostHogName);
  for (const specifier of found) postHogImports.push(`${file} → ${specifier}`);
}

const readJson = (relativePath: string) => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf-8'));

/** package.json の置き場所: ルート、apps/*、packages/* (workspaces と同じ範囲) */
const manifestPaths = [
  'package.json',
  ...['apps', 'packages'].flatMap((group) =>
    fs
      .readdirSync(path.join(ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, group, entry.name, 'package.json')))
      .map((entry) => `${group}/${entry.name}/package.json`),
  ),
];

describe('PostHog は採用しない (#1166): リポジトリのソース', () => {
  it('走査が機能している: Web・モバイル・共通 package・ルートの設定ファイルを読んでいる', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(sourceFiles.length).toBeGreaterThan(300);
    expect(sourceFiles).toEqual(
      expect.arrayContaining([
        'src/app/layout.tsx',
        'apps/mobile/app/_layout.tsx',
        'packages/handson-tour-shared/src/analytics.ts',
        'next.config.mjs',
      ]),
    );
  });

  it('PostHog の package (posthog-js / posthog-react-native / @posthog/* など) を、どのソースも import しない', () => {
    expect(
      postHogImports,
      `PostHog は採用しないことになっている (#1166)。計測を足す前に、このテストの冒頭の説明を読むこと: ${postHogImports.join(', ')}`,
    ).toEqual([]);
  });
});

describe('PostHog は採用しない (#1166): 依存と設定例', () => {
  it('走査が機能している: ルート・apps/mobile・packages/* の package.json を読んでいる', () => {
    expect(manifestPaths).toEqual(
      expect.arrayContaining([
        'package.json',
        'apps/mobile/package.json',
        'packages/shared/package.json',
        'packages/handson-tour-shared/package.json',
      ]),
    );
  });

  it.each(manifestPaths)('%s の依存に PostHog の package が無い', (manifest) => {
    expect(findPostHogDependencies(readJson(manifest))).toEqual([]);
  });

  it.each(['.env.example', 'apps/mobile/env.example'])('%s に POSTHOG の環境変数が無い', (envExample) => {
    const lines = fs
      .readFileSync(path.join(ROOT, envExample), 'utf-8')
      .split('\n')
      .filter((line) => isPostHogName(line));

    expect(lines).toEqual([]);
  });
});

describe('PostHog は採用しない (#1166): ソース解析のロジック', () => {
  it('import / export from / require / 動的 import のどれも検出する', () => {
    const specifiers = findModuleSpecifiers(`
      import posthog from 'posthog-js';
      export { PostHog } from 'posthog-react-native';
      const a = require('posthog-node');
      const b = await import('@posthog/core');
      import c = require('posthog-js/react');
    `);

    expect(specifiers.filter(isPostHogName)).toHaveLength(5);
  });

  it('自前のラッパー (@/lib/posthog) や Deno 形式 (npm: / URL) の import も検出し、無関係の package は対象にしない', () => {
    expect(isPostHogName('@/lib/posthog')).toBe(true);
    expect(isPostHogName('../src/providers/PostHogProvider')).toBe(true);
    expect(isPostHogName('npm:posthog-js@1.257.0')).toBe(true);
    expect(isPostHogName('https://esm.sh/posthog-js')).toBe(true);
    expect(isPostHogName('@homegohan/shared')).toBe(false);
    expect(isPostHogName('@homegohan/handson-tour-shared')).toBe(false);
    expect(isPostHogName('react')).toBe(false);
  });

  it('コメントや文字列の中の言及には反応しない (経緯の説明を書ける)', () => {
    const specifiers = findModuleSpecifiers(`
      // import posthog from 'posthog-js';
      /* const a = require('posthog-node'); */
      const note = "PostHog (posthog-js) は採用しない (#1166)";
      export const mention = 'posthog-react-native';
    `);

    expect(specifiers).toEqual([]);
  });

  it('拡張子に合わせた構文で読む: .ts を TSX として読むと、総称型のアロー関数や型アサーションの後ろの import を見落とす', () => {
    expect(findModuleSpecifiers(`const id = <T>(x: T) => x;\nimport p from 'posthog-js';`, 'a.ts')).toEqual([
      'posthog-js',
    ]);
    expect(findModuleSpecifiers(`const a = <string>foo;\nconst m = await import('posthog-js');`, 'a.ts')).toEqual([
      'posthog-js',
    ]);
    expect(findModuleSpecifiers(`const id = <T,>(x: T) => x;\nimport p from 'posthog-js';`, 'a.tsx')).toEqual([
      'posthog-js',
    ]);
    expect(findModuleSpecifiers(`const p = require('posthog-js');`, 'a.cjs')).toEqual(['posthog-js']);
  });

  it('package.json の 4 種類の依存欄のどれに入っていても検出する', () => {
    expect(
      findPostHogDependencies({
        dependencies: { 'posthog-js': '^1.257.0', react: '^18.3.1' },
        devDependencies: { 'posthog-node': '^4.0.0' },
        peerDependencies: { '@posthog/types': '*' },
        optionalDependencies: { 'posthog-react-native': '^3.3.10' },
      }),
    ).toEqual([
      'dependencies.posthog-js',
      'devDependencies.posthog-node',
      'peerDependencies.@posthog/types',
      'optionalDependencies.posthog-react-native',
    ]);
    expect(findPostHogDependencies({ dependencies: { react: '^18.3.1' } })).toEqual([]);
    expect(findPostHogDependencies({})).toEqual([]);
  });
});
