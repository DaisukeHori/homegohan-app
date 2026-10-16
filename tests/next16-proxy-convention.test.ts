// @vitest-environment node
/**
 * #1744 Next 16 の proxy の規約と、Edge Runtime を使わないことの見張り
 *
 * Next 16 で middleware のファイルの規約は非推奨になり proxy に変わった (next build が
 * 「The "middleware" file convention is deprecated」の警告を出す)。proxy は Node.js の runtime だけで動き、
 * config に runtime を書くと next build が失敗する。middleware と proxy の両方を置くと next build が失敗する。
 * あわせて、route の runtime = 'edge' (Edge Runtime) も Next 16 で非推奨 (next build が警告を出す) なので使わない。
 *
 * 見るもの:
 *   1. src/proxy.ts があり、middleware のファイル (ルート・src/) と、ルートの proxy は無い
 *   2. src/proxy.ts は proxy という名前の関数と、matcher だけの config を export する (runtime を書かない)
 *   3. src/app の route / page / layout は runtime に edge (experimental-edge を含む) を書かない
 *   4. コードとテスト (コメントを含む) が、消えた src/middleware.ts や「Edge で動く middleware」を名指ししない
 *      (#1744 の改名を書いた注記は残してよい。設計書と CLAUDE.md はオーケストレーターの PATCH で直す)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// src/proxy.ts を import するだけなので、Supabase のクライアントは作らせない
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }));

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'src/app');
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;
/** runtime に edge (Next 15 までの experimental-edge を含む) を書いた行。コメントの中の説明は見ない */
const EDGE_RUNTIME_EXPORT = /^\s*export\s+const\s+runtime\s*=\s*['"](edge|experimental-edge)['"]/m;

/** 走査 4 の対象 (リポジトリのルートからの相対パス)。node_modules を含まない場所だけ */
const STALE_REFERENCE_SCAN_DIRS = ['src', 'lib', 'packages/shared/src', 'scripts', 'tests'];
/** 走査 4 で見ない、このファイル自身 (見張りの文字列を書いている) */
const THIS_FILE = path.join(ROOT, 'tests/next16-proxy-convention.test.ts');
/**
 * 消えた src/middleware.ts と、proxy を「Edge で動く middleware」と書く古い記述。
 * lib/supabase/middleware.ts (今もある) や src/proxy.ts は捕まえない
 */
const STALE_MIDDLEWARE_REFERENCE =
  /src\/middleware\.(?:ts|js)\b|['"`]@\/middleware['"`]|(?:middleware|ミドルウェア) ?\(Edge|Edge ランタイムの middleware|(?:ミドルウェア|middleware) ?は ?Edge/;
/** #1744 の改名・移行を書いた注記の目印 (この番号を書いた行は来歴として残してよい) */
const RENAME_NOTE = '#1744';

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return SOURCE_FILE.test(entry.name) ? [full] : [];
  });
}

describe('#1744 Next 16 の proxy の規約', () => {
  it('src/proxy.ts があり、middleware のファイルと、ルートの proxy は無い (両方あると next build が失敗する)', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/proxy.ts'))).toBe(true);
    const leftovers = ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js', 'proxy.ts', 'proxy.js'].filter(
      (file) => fs.existsSync(path.join(ROOT, file)),
    );
    expect(leftovers).toEqual([]);
  });

  it('src/proxy.ts は proxy 関数と、matcher だけの config を export する (runtime を書かない)', async () => {
    const proxyModule = await import('@/proxy');

    expect(typeof proxyModule.proxy).toBe('function');
    expect(Object.keys(proxyModule.config)).toEqual(['matcher']);
    expect(Object.keys(proxyModule).sort()).toEqual(['config', 'proxy']);
  });
});

describe('#1744 Edge Runtime を使わない (Next 16 で非推奨)', () => {
  const files = listSourceFiles(APP_DIR);

  it('走査が空振りしていない (src/app の route を拾えている)', () => {
    expect(files).toContain(path.join(APP_DIR, 'api/cron/process-menu-queue/route.ts'));
  });

  it('src/app の route / page / layout は runtime に edge を書かない', () => {
    const edgeFiles = files.filter((file) => EDGE_RUNTIME_EXPORT.test(fs.readFileSync(file, 'utf8'))).map((file) => path.relative(ROOT, file));
    expect(edgeFiles).toEqual([]);
  });

  it('見張りが空回りしていない: runtime = edge の行は捕まえ、nodejs やコメントの中の説明は捕まえない', () => {
    expect(EDGE_RUNTIME_EXPORT.test("export const runtime = 'edge';")).toBe(true);
    expect(EDGE_RUNTIME_EXPORT.test('export const runtime = "experimental-edge"')).toBe(true);
    expect(EDGE_RUNTIME_EXPORT.test("export const runtime = 'nodejs';")).toBe(false);
    expect(EDGE_RUNTIME_EXPORT.test("// runtime = 'edge' は使わない")).toBe(false);
  });
});

describe('#1744 消えた src/middleware.ts と「Edge で動く middleware」を名指ししない', () => {
  const files = STALE_REFERENCE_SCAN_DIRS.flatMap((dir) => listSourceFiles(path.join(ROOT, dir))).filter((file) => file !== THIS_FILE);

  it('走査が空振りしていない (proxy が読むコードとテストを拾えている)', () => {
    expect(files).toContain(path.join(ROOT, 'src/proxy.ts'));
    expect(files).toContain(path.join(ROOT, 'lib/supabase/middleware.ts'));
    expect(files).toContain(path.join(ROOT, 'tests/env-source-scan.test.ts'));
  });

  it('コードとテストに、消えた src/middleware.ts や「Edge で動く middleware」の記述が残っていない', () => {
    const leftovers = files.flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          STALE_MIDDLEWARE_REFERENCE.test(line) && !line.includes(RENAME_NOTE) ? [`${path.relative(ROOT, file)}:${index + 1}`] : [],
        ),
    );
    expect(leftovers).toEqual([]);
  });

  it('見張りが空回りしていない: 古い記述は捕まえ、今あるファイルの名前は捕まえない', () => {
    // 2026-10-16 の R1 で見つかった古い記述の形 (設計書の行と、同じ型のコメント)
    expect(STALE_MIDDLEWARE_REFERENCE.test('`src/middleware.ts:9-19` は `is_native_app` の Cookie を付けるだけ')).toBe(true);
    expect(STALE_MIDDLEWARE_REFERENCE.test('`src/middleware.ts` の `config.matcher`')).toBe(true);
    expect(STALE_MIDDLEWARE_REFERENCE.test("import { config } from '@/middleware';")).toBe(true);
    expect(STALE_MIDDLEWARE_REFERENCE.test('// 他のインスタンスとミドルウェア (Edge。メモリは別) には、最大 30 秒で反映される')).toBe(true);
    expect(STALE_MIDDLEWARE_REFERENCE.test(' * middleware (Edge) からも読むので、Node の部品をここに置かない')).toBe(true);
    expect(STALE_MIDDLEWARE_REFERENCE.test(' * ここは副作用のない関数だけを置く (Edge ランタイムの middleware から import される)')).toBe(true);
    expect(STALE_MIDDLEWARE_REFERENCE.test('(ミドルウェアは Edge、API route は Node で、メモリは別)')).toBe(true);
    // 今あるファイルと、改名の注記
    expect(STALE_MIDDLEWARE_REFERENCE.test("import { updateSession } from '@/lib/supabase/middleware';")).toBe(false);
    expect(STALE_MIDDLEWARE_REFERENCE.test('`lib/supabase/middleware.ts:431` の `resolveOnboardingRedirect`')).toBe(false);
    expect(STALE_MIDDLEWARE_REFERENCE.test("import { proxy, config } from '@/proxy';")).toBe(false);
    expect('// #1744 で src/middleware.ts から改名'.includes(RENAME_NOTE)).toBe(true);
  });
});
