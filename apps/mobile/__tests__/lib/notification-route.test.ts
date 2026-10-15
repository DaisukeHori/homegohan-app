/**
 * #1049 F7-11: 通知をタップしたときの行き先 (src/lib/notificationRoute.ts の resolveNotificationHref)
 *
 * 行き先は通知の data.path (アプリ内のパス) か data.deep_link (homegohan:// の URL。
 * docs/design/mobile/03-push-notification.md §3.3) から決める。第三者も通知を送れるので、許す形を狭く決めている。
 *   1. homegohan:// の URL と '/' で始まるパスを、アプリ内のパスにする (path を優先)
 *   2. 画面が無い下位のパスは、一番近い上位の画面にする ('/health/blood-tests/abc' → '/health/blood-tests')
 *   3. 不正な形・ほかのスキーム・開かない画面 (設定・管理・ログインなど)・消した画面 (家族・食材・AI 相談など。#1598 / #1610) は null (遷移しない)
 *   4. NOTIFICATION_ROUTES の画面は、すべて apps/mobile/app/ に実在する
 */

import fs from 'fs';
import path from 'path';

import { NOTIFICATION_ROUTES, resolveNotificationHref } from '../../src/lib/notificationRoute';

describe('resolveNotificationHref (#1049 F7-11)', () => {
  it.each([
    [{ deep_link: 'homegohan://menus' }, '/menus'],
    [{ deep_link: 'homegohan://menus/' }, '/menus'],
    [{ path: '/comparison' }, '/comparison'],
    [{ path: '/health/blood-tests' }, '/health/blood-tests'],
    [{ deep_link: 'homegohan://profile?from=push' }, '/profile?from=push'],
    [{ path: '  /home  ' }, '/home'],
  ])('%j → %s', (data, expected) => {
    expect(resolveNotificationHref(data)).toBe(expected);
  });

  it('path と deep_link の両方があれば path を使う', () => {
    expect(resolveNotificationHref({ path: '/menus', deep_link: 'homegohan://profile' })).toBe('/menus');
  });

  it('画面が無い下位のパスは、一番近い上位の画面にする (下位のためのクエリは引き継がない)', () => {
    expect(resolveNotificationHref({ deep_link: 'homegohan://health/blood-tests/abc' })).toBe('/health/blood-tests');
    // 週の献立のネイティブの画面は消した (#1598)。献立のタブ (WebView が Web の週の献立を出す) を開く
    expect(resolveNotificationHref({ path: '/menus/weekly?x=1' })).toBe('/menus');
  });

  it.each([
    [null],
    ['homegohan://family'],
    [{}],
    [{ deep_link: 42 }],
    [{ path: '' }],
    [{ deep_link: 'https://evil.example/family' }],
    [{ deep_link: 'javascript:alert(1)' }],
    [{ path: '//evil.example/family' }],
    [{ path: 'family' }],
    [{ path: '/family/../settings' }],
    [{ path: '/family/%2e%2e' }],
    [{ path: '/family#x' }],
    [{ path: '/a//b' }],
    [{ path: '/menus?x=%20' }],
    [{ path: '/menus/a/b/c' }],
    [{ path: `/menus/${'a'.repeat(600)}` }],
  ])('不正な形 %j は null', (data) => {
    expect(resolveNotificationHref(data)).toBeNull();
  });

  it.each([
    ['/settings'],
    ['/settings/account'],
    ['/super-admin'],
    ['/org/dashboard'],
    ['/support/users'],
    ['/login'],
    ['/onboarding'],
    ['/handson-tour'],
    ['/unknown'],
    // 通常の操作で届かないネイティブの画面として消した画面 (#1598 / #1610)。下位のパスも、載せた画面に当たらなければ上位に落ちない
    ['/family'],
    ['/family/meal-requests'],
    ['/pantry'],
    ['/shopping-list'],
    ['/recipes'],
    ['/recipes/abc'],
    ['/ai'],
    ['/ai/session-123'],
    ['/health'],
    ['/health/streaks'],
    ['/health/record/2026-10-14'],
    ['/badges'],
    ['/favorites'],
  ])('通知から開かない画面・無い画面 %s は null', (target) => {
    expect(resolveNotificationHref({ path: target })).toBeNull();
    expect(resolveNotificationHref({ deep_link: `homegohan:/${target}` })).toBeNull();
  });
});

describe('NOTIFICATION_ROUTES の画面は apps/mobile/app/ に実在する (#1049 F7-11)', () => {
  const APP_DIR = path.resolve(__dirname, '../../app');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  /** 画面ファイル → URL の区間 (group と index を除き、[name] は ':' にする)。_layout は画面ではない */
  const routes = walk(APP_DIR)
    .map((file) => path.relative(APP_DIR, file).replace(/\.tsx?$/, '').split(path.sep))
    .filter((parts) => !parts[parts.length - 1].startsWith('_'))
    .map((parts) =>
      parts
        .filter((part) => !/^\(.+\)$/.test(part) && part !== 'index')
        .map((part) => (/^\[.+\]$/.test(part) ? ':' : part))
        .join('/'),
    );

  it.each(NOTIFICATION_ROUTES.map((route) => [route]))('%s', (route) => {
    const normalized = route
      .split('/')
      .filter(Boolean)
      .map((part) => (part.startsWith(':') ? ':' : part))
      .join('/');
    expect(routes).toContain(normalized);
  });
});

describe('notificationRoute.ts の説明の指し先 (#1049 の整合ゲート)', () => {
  const MOBILE_ROOT = path.resolve(__dirname, '../..');
  const REPO_ROOT = path.resolve(MOBILE_ROOT, '../..');
  const source = fs.readFileSync(path.join(MOBILE_ROOT, 'src/lib/notificationRoute.ts'), 'utf8');

  it('homegohan:// の後ろがアプリ内のパスになる根拠は、app.json の scheme (行き先の頭の DEEP_LINK_SCHEME と同じ)', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(MOBILE_ROOT, 'app.json'), 'utf8')) as { expo: { scheme: string } };
    expect(appJson.expo.scheme).toBe('homegohan');
    expect(source).toContain(`const DEEP_LINK_SCHEME = "${appJson.expo.scheme}://";`);
    expect(source).toMatch(/app\.json の scheme が "homegohan"/);
  });

  it('説明が指す設計書の節 (docs/design/mobile/<ファイル> §n.n) は、すべて実在する', () => {
    const header = source.slice(0, source.indexOf('const DEEP_LINK_SCHEME'));
    const refs = [...header.matchAll(/(0\d-[a-z-]+\.md) §(\d+\.\d+)/g)].map((m) => ({ file: m[1], section: m[2] }));
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const { file, section } of refs) {
      const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/design/mobile', file), 'utf8');
      expect(doc).toMatch(new RegExp(`^### ${section.replace('.', '\\.')} `, 'm'));
    }
  });

  it('02-deep-link.md §3.1 (受ける URL の一覧) を、パスの当て方の根拠として指さない (§3.1 にその記述は無い)', () => {
    expect(source).not.toMatch(/02-deep-link\.md §3\.1 のとおり/);
  });
});
