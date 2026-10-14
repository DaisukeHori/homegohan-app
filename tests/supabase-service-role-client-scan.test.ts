// @vitest-environment node
/**
 * #1162 service_role の Supabase クライアントは canonical の getSupabaseAdmin (lib/supabase/server.ts) でだけ作る、のソース走査 contract テスト
 *
 * 以前は 9 つの route (運営の強制譲渡・強制解散・候補者一覧の 6 つ、クライアントログの保存、オーナー移譲の提案、
 * 献立キューの cron) が、SUPABASE_SERVICE_ROLE_KEY を取り出して @supabase/supabase-js の createClient を自前で呼んでいた。
 * canonical の getSupabaseAdmin には「RLS を完全にバイパスするので、必ず認可チェックを先に通した後にだけ使う」という
 * 警告が書いてあるが、自前で作るコピーには伝わらない。新しい route がそのコピーを手本にすると、
 * 認可の前に service_role のクライアントを使う (権限昇格) 書き方が広がりやすい。
 *
 *   1. 本番コード (src・lib の .ts / .tsx。テスト・__tests__ は除く) で @supabase/supabase-js の createClient を
 *      値として import する (静的 import・再 export・import()・require) のは、下の一覧 (理由つき) のファイルだけ
 *   2. 一覧のうち service_role を使わないとしたファイルは、service_role の鍵の取り出し口に触れない
 *   3. @supabase/ssr のクライアント (Cookie のセッションで動く anon キーのクライアント) を作るファイルも、
 *      service_role の鍵の取り出し口に触れない
 *   4. 一覧に、もう createClient を import していないファイル (古い行) を残さない
 *
 * 走査は TypeScript の構文木で行うので、コメントの中の import や createClient には反応しない。
 *
 * 限界 (このテストは見張りであって、証明ではない。すり抜ける書き方はレビューで見る):
 *  - service_role の鍵を引数で受け取って、一覧にあるファイルの createClient に渡す書き方は捕まらない
 *    (一覧のファイルが鍵を受け取る口を作らないことは、一覧に足すときのレビューで見る)。
 *  - 走査の対象は src と lib だけ。supabase/functions (Deno の Edge Function)・scripts は見ない (#1162 の範囲外)。
 *  - 認可が service_role のクライアントより先に通ることは見ない (置き換えた route の単体テストが、認可に落ちたら
 *    getSupabaseAdmin を呼ばないことを確かめる)。
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** 走査する本番コードの置き場 (src/app・src/lib を含む)。canonical の lib/supabase/server.ts は lib にある */
const SCAN_ROOTS = ['src', 'lib'];

const SUPABASE_JS_MODULE = '@supabase/supabase-js';
const SUPABASE_SSR_MODULE = '@supabase/ssr';
const SUPABASE_JS_CLIENT_FACTORY = 'createClient';
const SUPABASE_SSR_CLIENT_FACTORIES = ['createServerClient', 'createBrowserClient'];

/**
 * service_role の鍵の取り出し口。env-required の getter と、環境変数の名前そのもの
 * (SERVICE_ROLE_JWT は Edge Function を呼ぶときの古い別名。src/lib/env-required.ts の getEdgeFunctionServiceRoleKey)
 */
const SERVICE_ROLE_KEY_SOURCES = [
  'getSupabaseServiceConfig',
  'getSupabaseServiceRoleKey',
  'getEdgeFunctionServiceRoleKey',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SERVICE_ROLE_JWT',
];

interface AllowedClientCreator {
  file: string;
  /** service_role の鍵でクライアントを作るか */
  serviceRole: boolean;
  why: string;
}

/** @supabase/supabase-js の createClient を値として import してよいファイル (リポジトリの根からの相対パス) */
const SUPABASE_JS_CLIENT_ALLOWLIST: readonly AllowedClientCreator[] = [
  {
    file: 'lib/supabase/server.ts',
    serviceRole: true,
    why: 'canonical の getSupabaseAdmin (#1028 / #1162)。service_role のクライアントはここでだけ作る',
  },
  {
    file: 'src/lib/db-logger.ts',
    serviceRole: true,
    why:
      'ブラウザ向けのページ (src/app/(main)/meals/new/page.tsx の logToServer) からも import されるので、' +
      'next/headers を読む lib/supabase/server.ts を import できない。app_logs への insert にだけ使い、' +
      '接続情報が欠けていれば例外を投げずに null を返す (ログを書く処理で本処理を止めない)',
  },
  {
    file: 'src/app/api/health/route.ts',
    serviceRole: false,
    why: 'anon キーで DB の疎通だけを確かめる (service_role は使わない)',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 構文木の走査
// ─────────────────────────────────────────────────────────────────────────────

function parse(source: string, fileName: string) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** import { a, b as c } / export { a } from の、型だけでない名前 (別名の元の名前) */
function valueBindingNames(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): string[] {
  return elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text);
}

/**
 * module から factories のどれかを値として取り込んでいるか。
 * 名前空間 import (import * as x)・import()・require は、どの名前を使うか決まらないので取り込んでいるとみなす
 */
function importsValueFrom(source: string, moduleName: string, factories: readonly string[], fileName = 'file.ts'): boolean {
  const sf = parse(source, fileName);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === moduleName) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly && clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) found = true;
        else if (valueBindingNames(clause.namedBindings.elements).some((name) => factories.includes(name))) found = true;
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === moduleName
    ) {
      // export * from / export { createClient } from
      if (!node.exportClause || (ts.isNamedExports(node.exportClause) && valueBindingNames(node.exportClause.elements).some((name) => factories.includes(name)))) {
        found = true;
      }
    }
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first) && first.text === moduleName) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** service_role の鍵の取り出し口 (識別子・プロパティ名・文字列) のうち、コメントの外に現れるもの */
function findServiceRoleKeySources(source: string, fileName = 'file.ts'): string[] {
  const sf = parse(source, fileName);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && SERVICE_ROLE_KEY_SOURCES.includes(node.text)) {
      found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found].sort();
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

const createsSupabaseJsClient = (source: string, fileName?: string) =>
  importsValueFrom(source, SUPABASE_JS_MODULE, [SUPABASE_JS_CLIENT_FACTORY], fileName);
const createsSsrClient = (source: string, fileName?: string) =>
  importsValueFrom(source, SUPABASE_SSR_MODULE, SUPABASE_SSR_CLIENT_FACTORIES, fileName);

// ─────────────────────────────────────────────────────────────────────────────
// 検出の仕組みの確認
// ─────────────────────────────────────────────────────────────────────────────

describe('走査の仕組みの確認 (検出が空振りしないこと)', () => {
  it('createClient の値の import (別名・再 export・import()・require・名前空間) を見つける', () => {
    expect(createsSupabaseJsClient("import { createClient } from '@supabase/supabase-js';")).toBe(true);
    expect(createsSupabaseJsClient("import { createClient as make } from '@supabase/supabase-js';")).toBe(true);
    expect(createsSupabaseJsClient("import { type User, createClient } from '@supabase/supabase-js';")).toBe(true);
    expect(createsSupabaseJsClient("export { createClient } from '@supabase/supabase-js';")).toBe(true);
    expect(createsSupabaseJsClient("export * from '@supabase/supabase-js';")).toBe(true);
    expect(createsSupabaseJsClient("const { createClient } = await import('@supabase/supabase-js');")).toBe(true);
    expect(createsSupabaseJsClient("const supabase = require('@supabase/supabase-js');")).toBe(true);
    expect(createsSupabaseJsClient("import * as supabase from '@supabase/supabase-js';")).toBe(true);
  });

  it('コメントの中・型だけの import・別のモジュールの createClient には反応しない', () => {
    expect(createsSupabaseJsClient("// import { createClient } from '@supabase/supabase-js';")).toBe(false);
    expect(createsSupabaseJsClient("/* const { createClient } = await import('@supabase/supabase-js'); */")).toBe(false);
    expect(createsSupabaseJsClient("import type { SupabaseClient } from '@supabase/supabase-js';")).toBe(false);
    expect(createsSupabaseJsClient("import { type SupabaseClient, type User } from '@supabase/supabase-js';")).toBe(false);
    expect(createsSupabaseJsClient("import { createClient } from '@/lib/supabase/server';")).toBe(false);
  });

  it('@supabase/ssr のクライアントの import を見つけ、型だけの import には反応しない', () => {
    expect(createsSsrClient("import { createServerClient, type CookieOptions } from '@supabase/ssr';")).toBe(true);
    expect(createsSsrClient("import { createBrowserClient } from '@supabase/ssr';")).toBe(true);
    expect(createsSsrClient("import type { CookieOptions } from '@supabase/ssr';")).toBe(false);
  });

  it('service_role の鍵の取り出し口を、コメントの外にあるものだけ見つける', () => {
    const source = [
      "import { getSupabaseServiceConfig } from '@/lib/env-required';",
      'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      "const legacy = process.env['SERVICE_ROLE_JWT'];",
      '// getEdgeFunctionServiceRoleKey() はコメントなので数えない',
      '/* getSupabaseServiceRoleKey() も数えない */',
    ].join('\n');

    expect(findServiceRoleKeySources(source)).toEqual(['SERVICE_ROLE_JWT', 'SUPABASE_SERVICE_ROLE_KEY', 'getSupabaseServiceConfig']);
    expect(findServiceRoleKeySources("import { getSupabaseAnonKey } from '@/lib/env-required';")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 本番コードの走査
// ─────────────────────────────────────────────────────────────────────────────

describe('service_role の Supabase クライアントは canonical の getSupabaseAdmin でだけ作る (#1162)', () => {
  const files = SCAN_ROOTS.flatMap((root) => collectProductionFiles(path.join(ROOT, root)));
  const sources = new Map(files.map((file) => [relativeOf(file), fs.readFileSync(file, 'utf-8')]));
  const allowlisted = new Map(SUPABASE_JS_CLIENT_ALLOWLIST.map((entry) => [entry.file, entry]));

  it('走査の対象が空でない (置き場の名前が変わっても空振りしない)', () => {
    expect(sources.has('lib/supabase/server.ts')).toBe(true);
    expect(sources.has('src/lib/env-required.ts')).toBe(true);
    expect([...sources.keys()].some((file) => file.startsWith('src/app/api/'))).toBe(true);
    expect([...sources.keys()].some((file) => file.startsWith('src/lib/'))).toBe(true);
  });

  it('@supabase/supabase-js の createClient を import するのは、理由つきの一覧のファイルだけ', () => {
    const offenders = [...sources.entries()]
      .filter(([file, source]) => createsSupabaseJsClient(source, file) && !allowlisted.has(file))
      .map(([file, source]) => ({ file, serviceRoleKeySources: findServiceRoleKeySources(source, file) }));

    // service_role のクライアントは import { getSupabaseAdmin } from '@/lib/supabase/server' で作る (認可を先に通したあと)
    expect(offenders).toEqual([]);
  });

  it('一覧のうち service_role を使わないファイルは、service_role の鍵の取り出し口に触れない', () => {
    const offenders = SUPABASE_JS_CLIENT_ALLOWLIST.filter((entry) => !entry.serviceRole)
      .map((entry) => ({ file: entry.file, serviceRoleKeySources: findServiceRoleKeySources(sources.get(entry.file) ?? '', entry.file) }))
      .filter((entry) => entry.serviceRoleKeySources.length > 0);

    expect(offenders).toEqual([]);
  });

  it('@supabase/ssr のクライアントを作るファイルは、service_role の鍵の取り出し口に触れない', () => {
    const ssrFiles = [...sources.entries()].filter(([file, source]) => createsSsrClient(source, file));
    const offenders = ssrFiles
      .map(([file, source]) => ({ file, serviceRoleKeySources: findServiceRoleKeySources(source, file) }))
      .filter((entry) => entry.serviceRoleKeySources.length > 0);

    expect(ssrFiles.map(([file]) => file)).toContain('lib/supabase/server.ts');
    expect(offenders).toEqual([]);
  });

  it('一覧に古い行が無い (どの行のファイルも存在し、まだ createClient を import している)', () => {
    const stale = SUPABASE_JS_CLIENT_ALLOWLIST.filter((entry) => {
      const source = sources.get(entry.file);
      return source === undefined || !createsSupabaseJsClient(source, entry.file);
    }).map((entry) => entry.file);

    expect(stale).toEqual([]);
  });

  it('canonical の lib/supabase/server.ts が getSupabaseAdmin を export し、service_role の鍵で作る', () => {
    const source = sources.get('lib/supabase/server.ts') ?? '';

    expect(source).toMatch(/export function getSupabaseAdmin\(\)/);
    expect(findServiceRoleKeySources(source, 'lib/supabase/server.ts')).toEqual(['getSupabaseServiceRoleKey']);
  });

  // 以前 service_role のクライアントを自前で作っていた route。canonical から取り込んでいることを確かめる
  // (自前の作り方に戻すと上の一覧の検査でも落ちる。ここは置き換えた先が canonical であることの確認)
  const REPLACED_ROUTES = [
    'src/app/api/operator/membership/family/[id]/candidates/route.ts',
    'src/app/api/operator/membership/family/[id]/dissolve/route.ts',
    'src/app/api/operator/membership/family/[id]/transfer/route.ts',
    'src/app/api/operator/membership/org/[id]/candidates/route.ts',
    'src/app/api/operator/membership/org/[id]/dissolve/route.ts',
    'src/app/api/operator/membership/org/[id]/transfer/route.ts',
    'src/app/api/log/route.ts',
    'src/app/api/org/owner-transfer/propose/route.ts',
    'src/app/api/cron/process-menu-queue/route.ts',
  ];

  it.each(REPLACED_ROUTES)('%s は canonical の getSupabaseAdmin を import して使う', (file) => {
    const source = sources.get(file);

    expect(source).toBeDefined();
    expect(importsValueFrom(source ?? '', '@/lib/supabase/server', ['getSupabaseAdmin'], file)).toBe(true);
    expect(createsSupabaseJsClient(source ?? '', file)).toBe(false);
  });
});
