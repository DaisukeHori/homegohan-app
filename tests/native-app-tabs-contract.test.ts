/**
 * ネイティブアプリのタブの表が 1 か所にまとまっていることと、ログアウトで WebView から消す Cookie の一覧が
 * Web の実際の Cookie の名前と食い違っていないことの突合 (#1612 / #1049 F7-22・F7-16)
 *
 * タブ間の移動を判定する所は 2 つある (ネイティブの WebViewScreen と Web の NativeAppTabRouter)。
 * 以前はそれぞれが別々の一覧を持っていて、'/meals' と '/meals/new' が食い違い、Web が送った tab-navigate が読み捨てられていた。
 * 今は両方が @homegohan/shared の NATIVE_APP_TABS だけを見る。ここでは、
 *   - 表がネイティブのタブの画面 (apps/mobile/app/(tabs)) と食い違っていない
 *   - 2 か所が表だけを見ていて、別の一覧が再び生えていない
 *   - ログアウトで消す Cookie の接頭辞 (USER_SCOPED_COOKIE_NAME_PREFIXES) が、Web の Supabase の認証の Cookie の名前に当たる
 * を、ソースを読んで確かめる。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  NATIVE_APP_TABS,
  SUPABASE_AUTH_COOKIE_NAME_PREFIX,
  USER_SCOPED_COOKIE_NAME_PREFIXES,
} from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
/** コメントを除く (説明の文の中の '/meals/new' などを一覧と取り違えないため) */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const WEB_ROUTER = 'src/components/native-app/NativeAppTabRouter.tsx';
const MOBILE_SCREEN = 'apps/mobile/src/components/web/WebViewScreen.tsx';

describe('NATIVE_APP_TABS とタブの画面 (apps/mobile/app/(tabs))', () => {
  const layout = read('apps/mobile/app/(tabs)/_layout.tsx');

  for (const tab of NATIVE_APP_TABS) {
    it(`${tab.name} のタブ: 画面のファイルがあり、WebViewScreen に rootPath (${tab.rootPath}) を渡している`, () => {
      const file = path.join(ROOT, 'apps/mobile/app/(tabs)', `${tab.name}.tsx`);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain(`path="${tab.rootPath}"`);
    });

    it(`${tab.name} のタブ: タブバーに登録され、ルートが (tabs) の下の画面の名前と一致する`, () => {
      expect(layout).toContain(`name="${tab.name}"`);
      expect(tab.route).toBe(`/(tabs)/${tab.name}`);
    });
  }

  it('WebViewScreen を出すタブの画面は、すべて表にある (表に無いタブが増えていない)', () => {
    const dir = path.join(ROOT, 'apps/mobile/app/(tabs)');
    const screensWithWebView = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.tsx') && !file.startsWith('_'))
      .filter((file) => fs.readFileSync(path.join(dir, file), 'utf8').includes('<WebViewScreen'))
      .map((file) => file.replace(/\.tsx$/, ''))
      .sort();
    expect(screensWithWebView).toEqual(NATIVE_APP_TABS.map((tab) => tab.name).sort());
  });
});

describe('タブの一覧を持っていた 2 か所が、共通の表だけを見ている', () => {
  it('Web の NativeAppTabRouter は @homegohan/shared の findNativeAppTab を使い、自前の一覧を持たない', () => {
    const source = withoutComments(read(WEB_ROUTER));
    expect(source).toMatch(/from '@homegohan\/shared'/);
    expect(source).toContain('findNativeAppTab(');
    expect(source).not.toMatch(/TAB_PATHS\s*=/);
    // タブのパスの文字列を直に並べた一覧が無い
    for (const tab of NATIVE_APP_TABS) {
      expect(source).not.toContain(`'${tab.pathPrefix}'`);
      expect(source).not.toContain(`"${tab.pathPrefix}"`);
    }
    expect(source).not.toContain("'/meals/new'");
  });

  it('ネイティブの WebViewScreen は NATIVE_APP_TABS と findNativeAppTabByPathPrefix を使い、自前の一覧を持たない', () => {
    const source = withoutComments(read(MOBILE_SCREEN));
    expect(source).toMatch(/from '@homegohan\/shared'/);
    expect(source).toContain('NATIVE_APP_TABS');
    expect(source).toContain('findNativeAppTabByPathPrefix(');
    expect(source).not.toMatch(/TAB_ROUTES\s*[:=]/);
    expect(source).not.toMatch(/pathPrefix:\s*['"]\//);
    expect(source).not.toMatch(/['"]\/\(tabs\)\/(menus|meals|comparison|profile)['"]/);
  });
});

describe('ログアウトで WebView から消す Cookie の接頭辞 (#1612 / #1049 F7-16)', () => {
  // Web の Supabase のクライアントを作る所 (ブラウザ・サーバー・middleware)
  const WEB_SUPABASE_CLIENTS = ['lib/supabase/client.ts', 'lib/supabase/server.ts', 'lib/supabase/middleware.ts'];

  it('Web の Supabase のクライアントは Cookie の名前を変えていない (既定の sb-<ref>-auth-token のまま)', () => {
    for (const file of WEB_SUPABASE_CLIENTS) {
      const source = withoutComments(read(file));
      expect(source, file).toMatch(/createBrowserClient|createServerClient/);
      expect(source, file).not.toMatch(/\bcookieOptions\b/);
      expect(source, file).not.toMatch(/\bstorageKey\b/);
    }
  });

  it('消す接頭辞は Supabase の既定の認証の Cookie の名前 (チャンク・code-verifier を含む) に当たり、is_native_app には当たらない', () => {
    expect(USER_SCOPED_COOKIE_NAME_PREFIXES).toContain(SUPABASE_AUTH_COOKIE_NAME_PREFIX);
    const supabaseCookieNames = [
      'sb-abcdefghijklmnop-auth-token',
      'sb-abcdefghijklmnop-auth-token.0',
      'sb-abcdefghijklmnop-auth-token.1',
      'sb-abcdefghijklmnop-auth-token-code-verifier',
    ];
    for (const name of supabaseCookieNames) {
      expect(USER_SCOPED_COOKIE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))).toBe(true);
    }
    expect(USER_SCOPED_COOKIE_NAME_PREFIXES.some((prefix) => 'is_native_app'.startsWith(prefix))).toBe(false);
  });

  it('モバイルの注入の掃除は、この一覧を packages/shared から読む (一覧を写さない)', () => {
    const source = withoutComments(read('apps/mobile/src/lib/webViewUserStorageCleanup.ts'));
    expect(source).toContain('USER_SCOPED_COOKIE_NAME_PREFIXES');
    expect(source).not.toMatch(/['"]sb-['"]/);
  });
});
