// @vitest-environment node
/**
 * #1182 環境変数の取り出しを、src/lib/env.ts / src/lib/env-required.ts に寄せておくためのソース走査 contract テスト
 *
 * 以前は `process.env.X!` が API route や Supabase クライアントの生成に散らばっていた。非 null アサーションは
 * 型の上では string にするだけで、環境変数が欠けていると undefined がそのまま Supabase クライアントや
 * fetch の URL (`undefined/functions/v1/...`) に流れ込み、変数名の分からないエラーや、無駄なリクエストになっていた。
 *
 *   1. 本番コードに `process.env.X!` / `process.env['X']!` を書かない (欠けていれば getter が MissingEnvError を投げる。message は固定の文で、変数名はサーバーのログに残る)
 *   2. env-required.ts は何も import しない / env.ts の静的な import は zod だけ
 *      (ブラウザ・Edge に zod を持ち込まない。scripts/check-env.mjs が Node.js から直接読めるようにする)
 *   3. ブラウザ向け (lib/supabase/client.ts) と Edge Runtime (middleware・cron route) のコードは env.ts に到達しない
 *   4. 一覧の全変数が .env.example に書かれている / check:env の導線がそろっている
 *   5. 必須の変数名を、例外 (new XxxError(...) / throw) や応答 (NextResponse.json / Response.json / new Response) の
 *      文字列に書かない。書くと 500 の本文に変数名が出うる (#1172)。以前 account/delete が自前の取り出しで
 *      'Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' を投げ、本文に返していた
 *   6. Web の本番コードが名前を書いて読む環境変数は、すべて src/lib/env.ts の一覧にある (Node.js・Next.js が入れる NODE_ENV・NEXT_RUNTIME を除く)。
 *      値を読む場所が決まっている変数 (一覧の readOnlyBy) は、そのファイルだけが読む
 *   7. 必須の変数 (Supabase の接続情報) を、テンプレートリテラルに直接埋め込まない (#1434)。
 *      以前 price-change が `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/...` と書き、欠けていると
 *      `undefined/functions/v1/...` へ通信していた (1 の非 null アサーションの検査はこれをすり抜けていた)
 *   8. 必須の変数を名前で読むのは src/lib/env-required.ts だけ (#1434)。ほかの場所は getter を使う
 *      (自前で読んで `!url` と判定すると、空白だけの値を通し、独自の文面になる)
 *
 * 走査は TypeScript の構文木で行うので、コメントや文字列の中の `process.env.X!` には反応しない。
 *
 * 限界 (このテストは見張りであって、証明ではない。すり抜ける書き方はレビューで見る):
 *  - 名前を変数にした読み取り (`process.env[name]`)・`const env = process.env; env.X` のような別名経由は、
 *    どの変数を読んでいるか決まらないので、6〜8 のどれにも引っかからない。
 *  - 7 はテンプレートの `${...}` の中に process.env の読み取りが直接書かれているものだけを見る。
 *    いったん変数に入れてから埋め込む (`const u = process.env.X; `${u}/...``)・文字列の + 連結・
 *    `String(process.env.X)` を経由する、などは 7 では捕まらない (必須の変数なら 8 が、読む場所の側で捕まえる)。
 *  - 走査の対象は PRODUCTION_ROOTS (src・lib・components・apps/mobile・packages/*\/src) の .ts / .tsx だけ。
 *    scripts/*.mjs・supabase/functions (Deno)・next.config.mjs などは見ない。
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ENV_VARS } from '../src/lib/env';
import { MISSING_ENV_SERVER_LOG_PREFIX, REQUIRED_ENV_NAMES } from '../src/lib/env-required';

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

interface EnvRead {
  name: string;
  /** 1 始まり */
  line: number;
}

/**
 * 名前を書いて読んでいる環境変数 (`process.env.X` / `process.env['X']` / `const { X } = process.env`)。
 * `process.env[name]` のように名前が変数のものは、どの変数か決まらないので拾わない (src/lib/env.ts の getOptionalEnv だけ)。
 */
function findEnvReads(source: string, fileName = 'file.ts'): EnvRead[] {
  const sf = parse(source, fileName);
  const reads: EnvRead[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
      reads.push({ name: node.name.text, line: lineOf(node) });
    }
    if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
      reads.push({ name: node.argumentExpression.text, line: lineOf(node) });
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isProcessEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) reads.push({ name: key.text, line: lineOf(element) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return reads;
}

/**
 * テンプレートリテラルの `${...}` の中で、names のどれかを名前で直接読んでいる行 (1 始まり)。
 * `${process.env.X}` / `${process.env['X']}` / `${process.env.X ?? ''}` のように、`${...}` の式の中に読み取りがあれば拾う。
 * いったん変数に入れてから埋め込むもの・文字列の + 連結は拾わない (冒頭の「限界」)。
 */
function findEnvReadsInTemplates(source: string, names: readonly string[], fileName = 'file.ts'): number[] {
  const sf = parse(source, fileName);
  const lines = new Set<number>();
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const isNamedRead = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression) && names.includes(node.name.text)) ||
    (ts.isElementAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      names.includes(node.argumentExpression.text));
  const scanSpan = (node: ts.Node): void => {
    if (isNamedRead(node)) lines.add(lineOf(node));
    ts.forEachChild(node, scanSpan);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) node.templateSpans.forEach((span) => scanSpan(span.expression));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...lines].sort((a, b) => a - b);
}

/** 呼び出し先の名前 (`Foo` / `a.b`)。それ以外の形は null */
function calleeName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) return `${node.expression.text}.${node.name.text}`;
  return null;
}

/** 応答を作る呼び出し (本文が利用者に届く) */
const RESPONSE_CALLS = new Set(['NextResponse.json', 'Response.json']);
const RESPONSE_CONSTRUCTORS = new Set(['Response', 'NextResponse']);

/**
 * 例外 (throw 文・`new XxxError(...)`) と応答 (`NextResponse.json(...)` など) の引数の文字列に、
 * names のどれかが書かれている行 (1 始まり)。コメントや、それ以外の場所の文字列 (console.error など) は見ない。
 */
function findEnvNamesInErrorsOrResponses(source: string, names: readonly string[], fileName = 'file.ts'): number[] {
  const sf = parse(source, fileName);
  const lines = new Set<number>();
  const scanStrings = (node: ts.Node): void => {
    const text =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)
        ? node.text
        : null;
    if (text !== null && names.some((name) => text.includes(name))) {
      lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, scanStrings);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) scanStrings(node.expression);
    if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name && (/Error$/.test(name) || RESPONSE_CONSTRUCTORS.has(name))) node.arguments?.forEach(scanStrings);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && RESPONSE_CALLS.has(name)) node.arguments.forEach(scanStrings);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...lines].sort((a, b) => a - b);
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

  it('名前を書いた環境変数の読み取り (ドット・添字・分割代入) を見つけ、コメント・文字列・名前が変数の読み取りは見つけない', () => {
    const source = [
      'const a = process.env.FOO;', // 1
      "const b = process.env['BAR'] ?? '';", // 2
      'const { BAZ, QUX: renamed } = process.env;', // 3: 分割代入 (2 つ)
      'export function f(v = process.env.DEFAULT_PARAM) { return v; }', // 4: 引数の既定値
      '// process.env.COMMENTED', // 5: コメント
      'const e = "process.env.IN_STRING";', // 6: 文字列
      'const g = process.env[name];', // 7: 名前が変数
      'const h = other.env.NOT_PROCESS;', // 8: process ではない
    ].join('\n');

    expect(findEnvReads(source)).toEqual([
      { name: 'FOO', line: 1 },
      { name: 'BAR', line: 2 },
      { name: 'BAZ', line: 3 },
      { name: 'QUX', line: 3 },
      { name: 'DEFAULT_PARAM', line: 4 },
    ]);
  });

  it('テンプレートリテラルに直接埋め込んだ必須の変数の読み取りを見つけ、ほかの書き方・任意の変数は見つけない (#1434)', () => {
    const source = [
      'const a = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/x`;', // 1
      "const b = { Authorization: `Bearer ${process.env['SUPABASE_SERVICE_ROLE_KEY']}` };", // 2: 添字
      "const c = `x ${y} ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''}`;", // 3: 2 つ目の ${} の中・?? つき
      'const d = `${process.env.NEXT_PUBLIC_APP_URL}/path`;', // 4: 任意の変数 (対象外)
      'const e = "${process.env.NEXT_PUBLIC_SUPABASE_URL}";', // 5: ふつうの文字列
      '// `${process.env.SUPABASE_SERVICE_ROLE_KEY}`', // 6: コメント
      'const u = process.env.NEXT_PUBLIC_SUPABASE_URL; const f = `${u}/x`;', // 7: 変数経由 (限界。8 が捕まえる)
      'const g = `${getSupabaseUrl()}/functions/v1/x`;', // 8: getter
      'const h = `${fn(process.env.SUPABASE_SERVICE_ROLE_KEY)}`;', // 9: ${} の中の式の奥
    ].join('\n');

    expect(findEnvReadsInTemplates(source, REQUIRED_ENV_NAMES)).toEqual([1, 2, 3, 9]);
  });

  it('例外・応答の文字列に書かれた必須の変数名を見つけ、ログ・コメント・変数の読み取りは見つけない', () => {
    const source = [
      "throw new Error('env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');", // 1
      'const e = new TypeError(`no SUPABASE_SERVICE_ROLE_KEY for ${x}`);', // 2: テンプレートの先頭
      "return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is missing' }, { status: 500 });", // 3
      "return Response.json({ detail: `x ${y} NEXT_PUBLIC_SUPABASE_ANON_KEY` });", // 4: テンプレートの末尾
      "return new Response('NEXT_PUBLIC_SUPABASE_URL', { status: 500 });", // 5
      "throw 'NEXT_PUBLIC_SUPABASE_URL';", // 6: 文字列をそのまま投げる
      "console.error('Missing SUPABASE_SERVICE_ROLE_KEY');", // 7: ログは対象外
      '// throw new Error("SUPABASE_SERVICE_ROLE_KEY")', // 8: コメント
      'const v = process.env.SUPABASE_SERVICE_ROLE_KEY;', // 9: 読み取り
      "throw new Error('Missing a required environment variable');", // 10: 名前なし
      "return NextResponse.json({ error: 'SUPABASE_URL' });", // 11: 一覧に無い名前
    ].join('\n');

    expect(findEnvNamesInErrorsOrResponses(source, REQUIRED_ENV_NAMES)).toEqual([1, 2, 3, 4, 5, 6]);
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
    // src/lib/env.ts の getOptionalEnv() に置き換える (欠けていれば MissingEnvError を投げる / undefined を返す)
    expect(offenders).toEqual([]);
  }, 30_000);

  it('必須の変数名を、例外・応答の文字列に書いていない (500 の本文に変数名が出うる。#1172)', () => {
    const offenders = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      // 構文木の解析は重いので、必須の変数名を含まないファイルは読み飛ばす
      if (!REQUIRED_ENV_NAMES.some((name) => source.includes(name))) return [];
      return findEnvNamesInErrorsOrResponses(source, REQUIRED_ENV_NAMES, file).map(
        (line) => `${path.relative(ROOT, file)}:${line}`,
      );
    });

    // 失敗したら、自前で取り出して名前入りの文を投げるのをやめ、src/lib/env-required.ts の getter
    // (service_role のクライアントは lib/supabase/server.ts の getSupabaseAdmin()) を使う。
    // 欠けていれば MissingEnvError (message は固定の文) になり、変数名はサーバーのログにだけ残る
    expect(offenders).toEqual([]);
  }, 30_000);

  it('必須の変数を、テンプレートリテラルに直接埋め込んでいない (`undefined/functions/v1/...` になりうる。#1434)', () => {
    const offenders = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      // 構文木の解析は重いので、必須の変数名を含まないファイルは読み飛ばす
      if (!REQUIRED_ENV_NAMES.some((name) => source.includes(name))) return [];
      return findEnvReadsInTemplates(source, REQUIRED_ENV_NAMES, file).map((line) => `${path.relative(ROOT, file)}:${line}`);
    });

    // 失敗したら、src/lib/env-required.ts の getSupabaseServiceConfig() などで取り出してから埋め込む
    // (欠けていれば MissingEnvError を投げ、変数名はサーバーのログに残る)
    expect(offenders).toEqual([]);
  }, 30_000);

  it('必須の変数を名前で読むのは src/lib/env-required.ts だけ (ほかの場所は getter を使う。#1434)', () => {
    const readers = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      // 構文木の解析は重いので、必須の変数名を含まないファイルは読み飛ばす
      if (!REQUIRED_ENV_NAMES.some((name) => source.includes(name))) return [];
      return findEnvReads(source, file)
        .filter((read) => (REQUIRED_ENV_NAMES as readonly string[]).includes(read.name))
        .map((read) => `${path.relative(ROOT, file)}:${read.line} ${read.name}`);
    });
    const outside = readers.filter((reader) => !reader.startsWith('src/lib/env-required.ts:'));

    // 走査が空振りしていないこと: env-required.ts が 3 つとも読んでいる
    expect(readers.filter((reader) => reader.startsWith('src/lib/env-required.ts:'))).toHaveLength(REQUIRED_ENV_NAMES.length);
    // 失敗したら、`process.env.X` と `!url` の自前の判定をやめ、src/lib/env-required.ts の getter
    // (getSupabaseUrl() / getSupabaseServiceConfig() など) を使う。欠けていてよい場所 (ログ・死活監視など) では
    // isMissingEnvError() で受けて縮退する
    expect(outside).toEqual([]);
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

  it('ENV_SETUP.md と CLAUDE.md が、欠けた変数名の出るサーバーのログの行を、コードと同じ文で案内している', () => {
    expect(readRepoFile('ENV_SETUP.md')).toContain(MISSING_ENV_SERVER_LOG_PREFIX);
    expect(readRepoFile('CLAUDE.md')).toContain(MISSING_ENV_SERVER_LOG_PREFIX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 本番コードで読む環境変数は、すべて一覧にある / 値を読む場所が決まっている変数は、そのファイルだけが読む
// ─────────────────────────────────────────────────────────────────────────────

describe('本番コードで読む環境変数は src/lib/env.ts の一覧にある (#1182)', () => {
  /** Web の本番コードの置き場。モバイル (apps/mobile) の変数は apps/mobile/src/lib/env.ts が持つので除く */
  const WEB_ROOTS = PRODUCTION_ROOTS.filter((root) => !root.startsWith('apps/mobile'));
  /** 一覧に載せない変数: Node.js・Next.js が入れるもの (設定する変数ではないので check:env の案内に出さない) */
  const RUNTIME_PROVIDED = new Set(['NODE_ENV', 'NEXT_RUNTIME']);

  function envReadsByFile(roots: readonly string[]): Map<string, EnvRead[]> {
    const byFile = new Map<string, EnvRead[]>();
    for (const file of roots.flatMap((root) => collectProductionFiles(path.join(ROOT, root)))) {
      const source = fs.readFileSync(file, 'utf-8');
      // 構文木の解析は重いので、process.env に触れていないファイルは読み飛ばす
      if (!/process\s*\.\s*env/.test(source)) continue;
      const reads = findEnvReads(source, file);
      if (reads.length > 0) byFile.set(path.relative(ROOT, file), reads);
    }
    return byFile;
  }

  const listed = new Set<string>(ENV_VARS.map((entry) => entry.name));

  it('Web の本番コードが名前を書いて読む環境変数は、すべて一覧にある (Node.js・Next.js が入れるものを除く)', () => {
    const byFile = envReadsByFile(WEB_ROOTS);
    const unlisted = [...byFile.entries()].flatMap(([file, reads]) =>
      reads
        .filter((read) => !listed.has(read.name) && !RUNTIME_PROVIDED.has(read.name))
        .map((read) => `${file}:${read.line} ${read.name}`),
    );

    // 走査が空振りしていないこと: 一覧の変数を読んでいる箇所が見つかる
    expect(byFile.size).toBeGreaterThan(10);
    expect(byFile.get('src/lib/env-required.ts')?.map((read) => read.name)).toContain('NEXT_PUBLIC_SUPABASE_URL');
    // 失敗したら、その変数を src/lib/env.ts の一覧と .env.example に足す (必須か任意か・無いと何が起きるかを書く)。
    // 一覧に無いと、npm run check:env がその変数を案内できない (#1174 の LEGAL_CONSENT_* が一覧から漏れていた)
    expect(unlisted).toEqual([]);
  }, 30_000);

  it('値を読む場所が決まっている変数 (一覧の readOnlyBy) は、本番コードではそのファイルだけが読む', () => {
    const byFile = envReadsByFile(PRODUCTION_ROOTS);
    const sealed = ENV_VARS.filter((entry) => entry.readOnlyBy !== undefined);

    // 走査が空振りしていないこと: 値を読む場所が決まっている変数がある
    expect(sealed.length).toBeGreaterThan(0);
    for (const entry of sealed) {
      const readers = [...byFile.entries()]
        .filter(([, reads]) => reads.some((read) => read.name === entry.name))
        .map(([file]) => file);

      // 読み方 (定数時間の比較・on だけを有効とみなす など) を 1 か所に集めておくため、ほかのファイルで直接読まない
      expect(readers, entry.name).toEqual([entry.readOnlyBy]);
    }
  }, 30_000);
});
