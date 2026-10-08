/**
 * ネイティブアプリのタブ定義 (NATIVE_APP_TABS / findNativeAppTab) のテスト (#1049 F7-22)
 */

import { describe, it, expect } from 'vitest';
import { NATIVE_APP_TABS, findNativeAppTab } from './native-app-tabs';

describe('NATIVE_APP_TABS', () => {
  it('5 つのタブがあり、名前・prefix・ルートに重複が無い', () => {
    expect(NATIVE_APP_TABS).toHaveLength(5);
    expect(new Set(NATIVE_APP_TABS.map((t) => t.name)).size).toBe(5);
    expect(new Set(NATIVE_APP_TABS.map((t) => t.pathPrefix)).size).toBe(5);
    expect(new Set(NATIVE_APP_TABS.map((t) => t.route)).size).toBe(5);
  });

  it('prefix は先頭 "/" で末尾 "/" なし、ルートは (tabs) グループ配下の name、rootPath は prefix 配下', () => {
    for (const tab of NATIVE_APP_TABS) {
      expect(tab.pathPrefix).toMatch(/^\/[a-z-]+$/);
      expect(tab.route).toBe(`/(tabs)/${tab.name}`);
      expect(findNativeAppTab(tab.rootPath)?.name).toBe(tab.name);
    }
  });

  it('prefix どうしが入れ子にならない (どのパスも高々 1 つのタブに属する)', () => {
    for (const a of NATIVE_APP_TABS) {
      for (const b of NATIVE_APP_TABS) {
        if (a === b) continue;
        expect(a.pathPrefix.startsWith(`${b.pathPrefix}/`)).toBe(false);
      }
    }
  });
});

describe('findNativeAppTab', () => {
  it('prefix そのものと、その配下のパスはそのタブに属する', () => {
    expect(findNativeAppTab('/menus')?.name).toBe('menus');
    expect(findNativeAppTab('/menus/weekly')?.name).toBe('menus');
    expect(findNativeAppTab('/home')?.name).toBe('home');
    expect(findNativeAppTab('/profile/nutrition-targets')?.name).toBe('profile');
    expect(findNativeAppTab('/comparison')?.name).toBe('comparison');
  });

  it("'/meals' 配下はスキャン・食事詳細ともに meals タブ ('/meals/new' も '/meals/<id>' も)", () => {
    expect(findNativeAppTab('/meals')?.name).toBe('meals');
    expect(findNativeAppTab('/meals/new')?.name).toBe('meals');
    expect(findNativeAppTab('/meals/3f2c1c3e-aaaa-bbbb-cccc-1234567890ab')?.name).toBe('meals');
  });

  it('prefix が文字列として前方一致するだけのパスは属さない', () => {
    expect(findNativeAppTab('/homepage')).toBeNull();
    expect(findNativeAppTab('/menus-archive')).toBeNull();
    expect(findNativeAppTab('/profiles')).toBeNull();
    expect(findNativeAppTab('/meal')).toBeNull();
  });

  it('タブ以外のパスは null', () => {
    expect(findNativeAppTab('/')).toBeNull();
    expect(findNativeAppTab('/login')).toBeNull();
    expect(findNativeAppTab('/family')).toBeNull();
    expect(findNativeAppTab('/settings')).toBeNull();
    expect(findNativeAppTab('')).toBeNull();
  });

  it('大文字小文字は区別する (Web のパスは小文字)', () => {
    expect(findNativeAppTab('/Home')).toBeNull();
  });
});
