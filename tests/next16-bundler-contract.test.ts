// @vitest-environment node
/**
 * #1745 Next 16 のバンドラー: package.json の dev / build は Next 16 の既定の Turbopack で動かす
 *
 * #1621 の Next 16 への更新では、dev / build に --webpack を付けて webpack のままにしていた。e2e のビルドの Google Fonts の
 * モック (tests/e2e/fixtures/google-fonts-mock.cjs・#1330) が Turbopack で効かなかったため。#1745 で、モックを Turbopack でも
 * 効く形 (他のモジュールを読まない・CSS の URL をそのままキーに並べる・フォントファイルを指さない) にして、Turbopack に移った。
 * モックが Turbopack の求める形であることは tests/e2e-google-fonts-mock.test.ts が確かめる。
 *
 * ここで見張ること:
 *   - dev / build に --webpack を付け直さない (結合テスト (next dev) と e2e・本番 (next build) で同じ Turbopack を使う)
 *   - next.config に webpack() の設定を足さない (Turbopack では使われない。Next 16 は webpack() があると Turbopack の
 *     next build を止める)
 *   - e2e のビルドが、モックを読む環境変数 NEXT_FONT_GOOGLE_MOCKED_RESPONSES を付けて npm run build する
 *     (local-ci.sh と e2e-local.yml。付け忘れると e2e のビルドが Google Fonts へ取りに行く)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const WEBPACK_FLAG = '--webpack';
const MOCK_ENV = 'NEXT_FONT_GOOGLE_MOCKED_RESPONSES';
const MOCK_FILE = 'tests/e2e/fixtures/google-fonts-mock.cjs';

type PackageJson = { scripts: Record<string, string>; dependencies: Record<string, string> };
const pkg: PackageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** コマンドの文字列を空白で語に分ける */
const wordsOf = (command: string): string[] => command.trim().split(/\s+/);

describe('#1745 package.json の dev / build は Next 16 の既定の Turbopack で動かす', () => {
  it('next は 16 系 (next dev / next build の既定のバンドラーが Turbopack の版)', () => {
    expect(pkg.dependencies.next).toMatch(/^16\./);
  });

  it.each([
    ['dev', 'dev'],
    ['build', 'build'],
  ])('scripts.%s は next %s で、--webpack を付けない', (script, subcommand) => {
    const words = wordsOf(pkg.scripts[script] ?? '');
    expect(words.slice(0, 2)).toEqual(['next', subcommand]);
    expect(words).not.toContain(WEBPACK_FLAG);
  });

  it('scripts.start は next start のまま (start はビルド済みのものを動かすだけで、バンドラーを選ばない)', () => {
    expect(wordsOf(pkg.scripts.start ?? '')).toEqual(['next', 'start']);
  });

  it('npm scripts のどこにも --webpack が無い (別の名前の scripts で webpack に戻していない)', () => {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(wordsOf(command), `scripts.${name}`).not.toContain(WEBPACK_FLAG);
    }
  });

  it('next.config.mjs に webpack() の設定が無い (Turbopack では使われず、Next 16 は Turbopack の build を止める)', () => {
    expect(read('next.config.mjs')).not.toMatch(/\bwebpack\s*(\(|:)/);
  });

  it.each([['scripts/local-ci.sh'], ['.github/workflows/e2e-local.yml']])(
    '%s の e2e のビルドは、モックの環境変数を付けて npm run build する',
    (file) => {
      const text = read(file);
      expect(text).toContain(`${MOCK_ENV}`);
      expect(text).toContain(MOCK_FILE);
      expect(text).toMatch(/npm run build/);
      expect(text).not.toMatch(/next build --webpack/);
    },
  );
});
