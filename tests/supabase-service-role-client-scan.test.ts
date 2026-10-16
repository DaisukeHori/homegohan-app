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
 * 所要時間 (#1814): 以前は src と lib の全ファイルを、規則ごとに構文木にしていた (1 ファイルを 2 回以上)。
 * 今は (a) 構文木を作る前に本文を文字列で見て、どの規則にも違反しえないファイルは構文木にしない
 * (理由は mayViolateAnyRule のコメント) (b) 構文木は 1 ファイル 1 回だけ作り、規則の間で使い回す。
 * どちらも検査の意味は変えない (コメントの中の文字列で絞り込みを通っても、構文木の検査で反応しない)。
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

/** canonical の getSupabaseAdmin があるファイル */
const CANONICAL_FILE = 'lib/supabase/server.ts';

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
    file: CANONICAL_FILE,
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

/**
 * 構文木の使い回し (#1814)。同じファイル名・同じ本文なら、前に作った構文木を返す。
 * 走査では規則ごとに同じファイルを何度も調べるので、1 ファイル 1 回だけ作る。
 * 本文が違えば (確認の仕組みのテストで同じ仮のファイル名に別の本文を渡すとき) 作り直す。
 * 走査は node.text だけを読み、親をたどらないので、親の参照は張らない (setParentNodes = false)
 */
const parsedFiles = new Map<string, { source: string; sourceFile: ts.SourceFile }>();

function parse(source: string, fileName: string): ts.SourceFile {
  const cached = parsedFiles.get(fileName);
  if (cached && cached.source === source) return cached.sourceFile;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  parsedFiles.set(fileName, { source, sourceFile });
  return sourceFile;
}

/** 構文木を作る前の絞り込みで探す文字列。モジュール名と、service_role の鍵の取り出し口の名前 */
const PREFILTER_NEEDLES: readonly string[] = [SUPABASE_JS_MODULE, SUPABASE_SSR_MODULE, ...SERVICE_ROLE_KEY_SOURCES];

/** 文字列・識別子の中で、書いた文字と値の文字を食い違わせる唯一の手段 (エスケープ) の印 */
const ESCAPE_MARK = '\\';

/**
 * 本文を文字列で見て、どれかの規則に違反しうるか (構文木を作る前の絞り込み・#1814)。
 * false のファイルは、どの規則にも違反しえない:
 *  - 規則 1 (createClient の import の一覧) と規則 3 (@supabase/ssr のクライアント) は、値が
 *    '@supabase/supabase-js' か '@supabase/ssr' の文字列 (import・export の from・import()・require の引数) が
 *    コメントの外にあるときにだけ反応する。値がそれと同じ文字列は、本文にもその文字が並ぶ
 *  - 規則 2 と規則 3 の鍵の取り出し口は、規則 1 か規則 3 に当たったファイル (と一覧のファイル) でだけ調べる。
 *    名前を含むかも見るのは念のため (含むファイルは構文木で調べる)
 *  - 規則 4 (古い行) と規則 2 は一覧のファイルを名指しで調べるので、この絞り込みを通さない
 *  - 値と本文の文字が食い違うのは、エスケープ ('\u0040supabase/…'・'\x40…'・'@supabase\/…'・行の継続・
 *    識別子の \u…) を使ったときだけ。どれもバックスラッシュを含むので、バックスラッシュを含むファイルは
 *    名前を含まなくても構文木で調べる (確認の仕組みのテストに例がある)
 * 名前を含んでいても、それがコメントの中だけなら構文木の検査で反応しない (絞り込みは調べる範囲を減らすだけ)
 */
function mayViolateAnyRule(source: string): boolean {
  return source.includes(ESCAPE_MARK) || PREFILTER_NEEDLES.some((needle) => source.includes(needle));
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

  it('構文木を作る前の絞り込みは、モジュール名・鍵の取り出し口の名前・エスケープを含むファイルを通し、ほかは通さない (#1814)', () => {
    expect(mayViolateAnyRule("import { createClient } from '@supabase/supabase-js';")).toBe(true);
    expect(mayViolateAnyRule("import { createServerClient } from '@supabase/ssr';")).toBe(true);
    for (const name of SERVICE_ROLE_KEY_SOURCES) {
      expect(mayViolateAnyRule(`const key = ${name};`)).toBe(true);
    }
    // コメントの中だけでも通す (反応するかどうかは構文木の検査が決める)
    expect(mayViolateAnyRule("// import { createClient } from '@supabase/supabase-js';")).toBe(true);
    expect(mayViolateAnyRule("import { createClient } from '@/lib/supabase/server';\nexport const x = 1;")).toBe(false);
    expect(mayViolateAnyRule('export const supabaseUrl = getSupabaseUrl();')).toBe(false);
  });

  it('エスケープで書いたモジュール名・鍵の名前も、絞り込みを通って構文木の検査で見つかる (#1814)', () => {
    // 本文の文字はモジュール名と違うが、値は同じ。バックスラッシュを含むので絞り込みを通す
    const escapedModule = "import { createClient } from '\\u0040supabase/supabase-js';";
    const escapedSlash = "import { createServerClient } from '@supabase\\/ssr';";
    const escapedKey = 'const key = process.env.\\u0053UPABASE_SERVICE_ROLE_KEY;';

    expect(escapedModule.includes(SUPABASE_JS_MODULE)).toBe(false);
    expect(mayViolateAnyRule(escapedModule)).toBe(true);
    expect(createsSupabaseJsClient(escapedModule)).toBe(true);
    expect(escapedSlash.includes(SUPABASE_SSR_MODULE)).toBe(false);
    expect(mayViolateAnyRule(escapedSlash)).toBe(true);
    expect(createsSsrClient(escapedSlash)).toBe(true);
    expect(PREFILTER_NEEDLES.some((needle) => escapedKey.includes(needle))).toBe(false);
    expect(mayViolateAnyRule(escapedKey)).toBe(true);
    expect(findServiceRoleKeySources(escapedKey)).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
  });

  it('同じファイル名でも本文が変われば構文木を作り直す (使い回しで古い結果を返さない・#1814)', () => {
    expect(createsSupabaseJsClient("import { createClient } from '@supabase/supabase-js';", 'same.ts')).toBe(true);
    expect(createsSupabaseJsClient("import type { SupabaseClient } from '@supabase/supabase-js';", 'same.ts')).toBe(false);
    expect(createsSupabaseJsClient("import { createClient } from '@supabase/supabase-js';", 'same.ts')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 本番コードの走査
// ─────────────────────────────────────────────────────────────────────────────

describe('service_role の Supabase クライアントは canonical の getSupabaseAdmin でだけ作る (#1162)', () => {
  const files = SCAN_ROOTS.flatMap((root) => collectProductionFiles(path.join(ROOT, root)));
  const sources = new Map(files.map((file) => [relativeOf(file), fs.readFileSync(file, 'utf-8')]));
  const allowlisted = new Map(SUPABASE_JS_CLIENT_ALLOWLIST.map((entry) => [entry.file, entry]));
  // 規則 1 と規則 3 で構文木にするのは、絞り込みを通ったファイルだけ (#1814。理由は mayViolateAnyRule)
  const candidates = [...sources.entries()].filter(([, source]) => mayViolateAnyRule(source));

  it('走査の対象が空でない (置き場の名前が変わっても空振りしない)', () => {
    expect(sources.has(CANONICAL_FILE)).toBe(true);
    expect(sources.has('src/lib/env-required.ts')).toBe(true);
    expect([...sources.keys()].some((file) => file.startsWith('src/app/api/'))).toBe(true);
    expect([...sources.keys()].some((file) => file.startsWith('src/lib/'))).toBe(true);
  });

  it('絞り込みは、一覧のファイル・canonical を落とさず、全体より少ない (#1814)', () => {
    const candidateFiles = new Set(candidates.map(([file]) => file));

    for (const entry of SUPABASE_JS_CLIENT_ALLOWLIST) expect(candidateFiles.has(entry.file)).toBe(true);
    expect(candidateFiles.has(CANONICAL_FILE)).toBe(true);
    expect(candidateFiles.size).toBeLessThan(sources.size);
  });

  it('@supabase/supabase-js の createClient を import するのは、理由つきの一覧のファイルだけ', () => {
    const offenders = candidates
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

  it('@supabase/ssr のクライアントを作るファイルは、service_role の鍵の取り出し口に触れない (canonical を除く)', () => {
    const ssrFiles = candidates.filter(([file, source]) => createsSsrClient(source, file));
    const offenders = ssrFiles
      // canonical は Cookie のセッションのクライアント (createClient。anon キー) と getSupabaseAdmin を同じファイルに持つ
      .filter(([file]) => file !== CANONICAL_FILE)
      .map(([file, source]) => ({ file, serviceRoleKeySources: findServiceRoleKeySources(source, file) }))
      .filter((entry) => entry.serviceRoleKeySources.length > 0);

    expect(ssrFiles.map(([file]) => file)).toContain(CANONICAL_FILE);
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
    const source = sources.get(CANONICAL_FILE) ?? '';

    expect(source).toMatch(/export function getSupabaseAdmin\(\)/);
    expect(findServiceRoleKeySources(source, CANONICAL_FILE)).toEqual(['getSupabaseServiceRoleKey']);
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
