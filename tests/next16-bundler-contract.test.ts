// @vitest-environment node
/**
 * #1621 Next 16 のバンドラー: package.json の dev / build は webpack (--webpack) で動かす
 *
 * Next 16 は next dev / next build の既定のバンドラーを Turbopack に変えた。このリポジトリは Next 15 まで webpack で
 * 動かしていて、Next 16 への更新ではバンドラーを変えない (Turbopack への切り替えは別の Issue で扱う)。理由:
 *   - e2e-local のビルドの Google Fonts のモック (tests/e2e/fixtures/google-fonts-mock.cjs・#1330) が Turbopack では効かない。
 *     Turbopack はモックのファイルを自前のバンドラーで評価して node_modules を解決できず、CSS が指すフォントファイルは
 *     モックの有無に関わらず Google Fonts へ取りに行く (2026-10-16 に local-ci の e2e 段のビルドが
 *     「Can't resolve 'next/package.json'」で落ちた)
 *   - styled-jsx の変換が止まらないことの見張り (tests/next-swc-styled-jsx-transform.test.ts) は、webpack のローダーと同じ
 *     SWC の設定で変換して確かめている
 *   - 結合テスト (next dev) と e2e・本番 (next build) で同じバンドラーを使う
 * --webpack を外すと黙って Turbopack に切り替わるので、ここで固定する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const WEBPACK_FLAG = '--webpack';

type PackageJson = { scripts: Record<string, string>; dependencies: Record<string, string> };
const pkg: PackageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** コマンドの文字列を空白で語に分ける */
const wordsOf = (command: string): string[] => command.trim().split(/\s+/);

describe('#1621 package.json の dev / build は Next 16 でも webpack で動かす', () => {
  it('next は 16 系', () => {
    expect(pkg.dependencies.next).toMatch(/^16\./);
  });

  it.each([
    ['dev', 'dev'],
    ['build', 'build'],
  ])('scripts.%s は next %s に --webpack を付ける (Turbopack の --turbopack / --turbo は付けない)', (script, subcommand) => {
    const words = wordsOf(pkg.scripts[script] ?? '');
    expect(words.slice(0, 2)).toEqual(['next', subcommand]);
    expect(words).toContain(WEBPACK_FLAG);
    expect(words).not.toContain('--turbopack');
    expect(words).not.toContain('--turbo');
  });

  it('scripts.start は next start のまま (start はビルド済みのものを動かすだけで、バンドラーを選ばない)', () => {
    expect(wordsOf(pkg.scripts.start ?? '')).toEqual(['next', 'start']);
  });
});
