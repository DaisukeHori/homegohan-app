/**
 * ネイティブアプリのタブ定義が 1 か所に集約されていることの契約テスト (#1049 F7-22)
 *
 * タブ間の移動を判定する場所は 2 つある (ネイティブの WebViewScreen と Web の NativeAppTabRouter)。
 * 以前はそれぞれが別々の一覧を持っていて、'/meals' と '/meals/new' が食い違っていた。
 * 今は両方が @homegohan/shared の NATIVE_APP_TABS だけを見る。
 * ここでは、その配線が崩れていないこと (別の一覧が再び生えていないこと) と、
 * 表がネイティブのタブ画面と食い違っていないことを、ソースを読んで確かめる。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { NATIVE_APP_TABS } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
/** コメントを除く (説明文の中の '/meals/new' などを一覧と取り違えないため) */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('NATIVE_APP_TABS とタブ画面 (apps/mobile/app/(tabs))', () => {
  const layout = read('apps/mobile/app/(tabs)/_layout.tsx');

  for (const tab of NATIVE_APP_TABS) {
    it(`${tab.name} タブ: 画面ファイルがあり、WebViewScreen に rootPath (${tab.rootPath}) を渡している`, () => {
      const file = path.join(ROOT, 'apps/mobile/app/(tabs)', `${tab.name}.tsx`);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain(`path="${tab.rootPath}"`);
    });

    it(`${tab.name} タブ: タブバーに登録されている`, () => {
      expect(layout).toContain(`name="${tab.name}"`);
    });
  }
});

describe('タブの一覧を持つ 2 か所が、共通の表だけを見ている', () => {
  it('Web の NativeAppTabRouter は @homegohan/shared の findNativeAppTab を使い、自前の一覧を持たない', () => {
    const source = withoutComments(read('src/components/native-app/NativeAppTabRouter.tsx'));
    expect(source).toContain("from '@homegohan/shared'");
    expect(source).toContain('findNativeAppTab');
    expect(source).not.toMatch(/TAB_PATHS\s*=/);
    // パスの文字列リテラルを直に並べた一覧が無い
    expect(source).not.toMatch(/['"]\/menus['"]/);
    expect(source).not.toMatch(/['"]\/meals(?:\/new)?['"]/);
  });

  it('ネイティブの WebViewScreen は NATIVE_APP_TABS から TAB_ROUTES を作り、自前の一覧を持たない', () => {
    const source = withoutComments(read('apps/mobile/src/components/web/WebViewScreen.tsx'));
    expect(source).toContain("from '@homegohan/shared'");
    expect(source).toContain('NATIVE_APP_TABS');
    expect(source).not.toMatch(/pathPrefix:\s*['"]\//);
    expect(source).not.toMatch(/tab:\s*['"]\/\(tabs\)/);
  });
});
