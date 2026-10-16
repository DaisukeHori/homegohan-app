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
