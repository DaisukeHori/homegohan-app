/**
 * #1049 F7-11: 通知をタップしたときの行き先 (src/lib/notificationRoute.ts の resolveNotificationHref)
 *
 * 行き先は通知の data.path (アプリ内のパス) か data.deep_link (homegohan:// の URL。
 * docs/design/mobile/03-push-notification.md §3.3) から決める。第三者も通知を送れるので、許す形を狭く決めている。
 *   1. homegohan:// の URL と '/' で始まるパスを、アプリ内のパスにする (path を優先)
 *   2. 画面が無い下位のパスは、一番近い上位の画面にする ('/health/blood-tests/abc' → '/health/blood-tests')
 *   3. 不正な形・ほかのスキーム・開かない画面 (設定・管理・ログインなど)・消した画面 (家族・食材・AI 相談など。#1598 / #1610) は null (遷移しない)
 *   4. NOTIFICATION_ROUTES の画面は、すべて apps/mobile/app/ に実在する
 *   5. 静的な区間は動的な区間 (':name') より優先して当たる。'/meals/:id' を載せても '/meals/new' は '/meals/:id' 扱いにならない (#1612)
 */

import fs from 'fs';
import path from 'path';

import {
  NOTIFICATION_CLOSED_STATIC_ROUTES,
  NOTIFICATION_ROUTES,
  NOTIFICATION_ROUTE_TABLE,
  findNotificationRoute,
  resolveNotificationHref,
  type NotificationRouteTable,
} from '../../src/lib/notificationRoute';

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

describe('静的な区間を動的な区間より優先して当てる (#1612)', () => {
  /** '/meals/:id' (動的な区間の画面) と、その静的な兄弟 '/meals/new' を載せた表 */
  const withStaticSibling: NotificationRouteTable = {
    // 動的な画面を先に載せても、静的な兄弟が優先する (載せた順に頼らない)
    routes: ['/meals', '/meals/:id', '/meals/new'],
    closedStaticRoutes: [],
  };
  /** '/meals/new' は通知から開かない表 */
  const withClosedSibling: NotificationRouteTable = {
    routes: ['/meals', '/meals/:id'],
    closedStaticRoutes: ['/meals/new'],
  };

  it('動的な区間の画面は、静的な兄弟でない任意の 1 区間に当たる', () => {
    expect(findNotificationRoute(['meals', 'abc'], withStaticSibling)).toBe('/meals/:id');
    expect(resolveNotificationHref({ path: '/meals/abc?from=push' }, withStaticSibling)).toBe('/meals/abc?from=push');
  });

  it('静的な兄弟 /meals/new は /meals/:id 扱いにならず、静的な画面に当たる', () => {
    expect(findNotificationRoute(['meals', 'new'], withStaticSibling)).toBe('/meals/new');
    expect(resolveNotificationHref({ deep_link: 'homegohan://meals/new?x=1' }, withStaticSibling)).toBe('/meals/new?x=1');
  });

  it('通知から開かない静的な兄弟は /meals/:id 扱いにならず、上位の画面に落ちる (下位のためのクエリは引き継がない)', () => {
    expect(findNotificationRoute(['meals', 'new'], withClosedSibling)).toBeNull();
    expect(resolveNotificationHref({ path: '/meals/new?x=1' }, withClosedSibling)).toBe('/meals');
    // 兄弟でない値は、同じ表でも動的な区間の画面に当たる
    expect(resolveNotificationHref({ path: '/meals/abc' }, withClosedSibling)).toBe('/meals/abc');
  });

  it('上位に落ちる先が無ければ null', () => {
    const table: NotificationRouteTable = { routes: ['/meals/:id'], closedStaticRoutes: ['/meals/new'] };
    expect(resolveNotificationHref({ path: '/meals/new' }, table)).toBeNull();
  });

  it('動的な区間を 2 つの画面が持つときは、前の区間から比べて先に静的な区間がある方が当たる', () => {
    const table: NotificationRouteTable = { routes: ['/a/:x/b', '/a/b/:y'], closedStaticRoutes: [] };
    expect(findNotificationRoute(['a', 'b', 'b'], table)).toBe('/a/b/:y');
    const reversed: NotificationRouteTable = { routes: ['/a/b/:y', '/a/:x/b'], closedStaticRoutes: [] };
    expect(findNotificationRoute(['a', 'b', 'b'], reversed)).toBe('/a/b/:y');
    expect(findNotificationRoute(['a', 'c', 'b'], table)).toBe('/a/:x/b');
  });

  it('既定の表 (動的な区間の画面を載せていない) では、/meals/new は食事のタブ /meals に落ちる (いまの挙動のまま)', () => {
    expect(NOTIFICATION_ROUTE_TABLE.routes).toBe(NOTIFICATION_ROUTES);
    expect(NOTIFICATION_ROUTE_TABLE.closedStaticRoutes).toBe(NOTIFICATION_CLOSED_STATIC_ROUTES);
    expect(resolveNotificationHref({ path: '/meals/new' })).toBe('/meals');
    expect(findNotificationRoute(['meals'])).toBe('/meals');
    expect(findNotificationRoute(['meals', 'new'])).toBeNull();
  });
});

/** URL の区間に直した画面 (先頭の '/' 無し。動的な区間は ':') */
function normalizeRoute(route: string): string {
  return route
    .split('/')
    .filter(Boolean)
    .map((part) => (part.startsWith(':') ? ':' : part))
    .join('/');
}

/** 動的な区間の画面 dynamicRoute が、静的な画面の一覧 staticRoutes のうちどれを飲み込むか (区間の数が同じで、静的な区間が一致する) */
function swallowedStaticSiblings(dynamicRoute: string, staticRoutes: readonly string[]): string[] {
  const dynamicParts = normalizeRoute(dynamicRoute).split('/');
  return staticRoutes.filter((staticRoute) => {
    const parts = staticRoute.split('/');
    return parts.length === dynamicParts.length && dynamicParts.every((part, index) => part === ':' || part === parts[index]);
  });
}

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
  const staticAppRoutes = routes.filter((route) => !route.split('/').includes(':'));

  it.each(NOTIFICATION_ROUTES.map((route) => [route]))('%s', (route) => {
    expect(routes).toContain(normalizeRoute(route));
  });

  it('NOTIFICATION_CLOSED_STATIC_ROUTES は app/ に実在する静的な画面で、NOTIFICATION_ROUTES と重ならない (#1612)', () => {
    for (const route of NOTIFICATION_CLOSED_STATIC_ROUTES) {
      expect(staticAppRoutes).toContain(normalizeRoute(route));
      expect(NOTIFICATION_ROUTES.map(normalizeRoute)).not.toContain(normalizeRoute(route));
    }
  });

  it('動的な区間の画面が飲み込む app/ の静的な兄弟は、NOTIFICATION_ROUTES か NOTIFICATION_CLOSED_STATIC_ROUTES に載っている (#1612)', () => {
    const listed = new Set([...NOTIFICATION_ROUTES, ...NOTIFICATION_CLOSED_STATIC_ROUTES].map(normalizeRoute));
    const dynamicRoutes = NOTIFICATION_ROUTES.filter((route) => route.split('/').some((part) => part.startsWith(':')));
    const unlisted = dynamicRoutes.flatMap((route) =>
      swallowedStaticSiblings(route, staticAppRoutes)
        .filter((sibling) => !listed.has(sibling))
        .map((sibling) => `${route} が /${sibling} を飲み込む`),
    );
    expect(unlisted).toEqual([]);
  });

  it('飲み込む兄弟の検出は、静的な兄弟を見つけ、区間の数・静的な区間が違うものは見つけない', () => {
    const appRoutes = ['meals', 'meals/new', 'meals/new/edit', 'menus/new', 'meals/:'];
    expect(swallowedStaticSiblings('/meals/:id', appRoutes.filter((route) => !route.includes(':')))).toEqual(['meals/new']);
    expect(swallowedStaticSiblings('/:kind/new', ['meals/new', 'menus/new', 'meals'])).toEqual(['meals/new', 'menus/new']);
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
