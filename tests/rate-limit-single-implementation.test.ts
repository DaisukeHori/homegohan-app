/**
 * #1197 レート制限の実装を src/lib/rate-limit.ts の 1 か所に保つためのソース走査 contract テスト
 *
 * 以前は、お問い合わせ API (src/app/api/contact/route.ts) が Upstash の Ratelimit・in-memory の数え方・
 * 限度値 (10 回/分) を自前で持っていて、共通ヘルパーとは別に直す必要があった (方針を変えると片方だけが古いまま残る)。
 * いまは route ごとに制限を作らず、共通ヘルパーのカテゴリ (RateLimitCategory) を足して使う。
 *
 * src/ 配下 (テストを除く) の全ファイルをソースとして読み、`@upstash/ratelimit` を import しているのが
 * 共通ヘルパーだけであることを確かめる。新しい制限が必要になってこのテストが落ちたら、
 * src/lib/rate-limit.ts の CATEGORY_RULES にカテゴリを足し、checkRateLimit(key, category) を呼ぶ。
 * 走査は TypeScript の構文木で行うので、コメントや文字列の中の package 名には反応しない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src';
const RATE_LIMIT_FILE = 'src/lib/rate-limit.ts';
const LIMITER_PACKAGE = '@upstash/ratelimit';

const isLimiterPackage = (specifier: string) =>
  specifier === LIMITER_PACKAGE || specifier.startsWith(`${LIMITER_PACKAGE}/`);

/** ソースが読み込んでいる (import / export from / require / 動的 import) module 名を返す */
function findModuleSpecifiers(source: string, fileName = 'file.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const limiterImporters: string[] = [];
let scannedFileCount = 0;
for (const file of collectSourceFiles(path.join(ROOT, SCAN_ROOT))) {
  scannedFileCount += 1;
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  if (findModuleSpecifiers(fs.readFileSync(file, 'utf-8'), relative).some(isLimiterPackage)) {
    limiterImporters.push(relative);
  }
}

describe('レート制限の実装は src/lib/rate-limit.ts に 1 つだけ (#1197): リポジトリのソース', () => {
  it('走査が機能している: 共通ヘルパーが Ratelimit を import していることを検出する', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(scannedFileCount).toBeGreaterThan(100);
    expect(limiterImporters).toContain(RATE_LIMIT_FILE);
  });

  it('@upstash/ratelimit を import するのは共通ヘルパーだけ (route などが独自の制限を作らない)', () => {
    const others = limiterImporters.filter((file) => file !== RATE_LIMIT_FILE);

    expect(
      others,
      `${LIMITER_PACKAGE} を直接使わず、${RATE_LIMIT_FILE} の CATEGORY_RULES にカテゴリを足して ` +
        `checkRateLimit(key, category) を呼ぶこと: ${others.join(', ')}`,
    ).toEqual([]);
  });
});

describe('レート制限の実装は src/lib/rate-limit.ts に 1 つだけ (#1197): ソース解析のロジック', () => {
  it('import / export from / require / 動的 import のどれも検出する', () => {
    const specifiers = findModuleSpecifiers(`
      import { Ratelimit } from '@upstash/ratelimit';
      export { Ratelimit as RL } from '@upstash/ratelimit';
      const a = require('@upstash/ratelimit');
      const b = await import('@upstash/ratelimit');
      import c = require('@upstash/ratelimit');
    `);

    expect(specifiers.filter(isLimiterPackage)).toHaveLength(5);
  });

  it('サブパスの import も検出し、別の package (@upstash/redis など) は対象にしない', () => {
    expect(isLimiterPackage('@upstash/ratelimit/dist/index')).toBe(true);
    expect(isLimiterPackage('@upstash/redis')).toBe(false);
    expect(isLimiterPackage('@upstash/ratelimit-extra')).toBe(false);
  });

  it('コメントや文字列の中の package 名には反応しない', () => {
    const specifiers = findModuleSpecifiers(`
      // import { Ratelimit } from '@upstash/ratelimit';
      /* const a = require('@upstash/ratelimit'); */
      const note = "@upstash/ratelimit を使う";
      export const mention = '@upstash/ratelimit';
    `);

    expect(specifiers).toEqual([]);
  });
});
