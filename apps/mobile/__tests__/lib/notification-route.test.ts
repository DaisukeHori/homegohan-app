/**
 * notification-route.test.ts
 * src/lib/notificationRoute.ts のテスト (#1049 F7-11)
 *
 * 通知の data.deep_link から、タップしたときに開く画面を決める。
 * 通知はサーバーが組み立てるが、Expo の Push Token が分かれば第三者も送れるので、
 * 許した形のものだけ遷移に使い、外れるものは null (遷移しない) にする。
 */

import fs from 'fs';
import path from 'path';

import {
  NOTIFICATION_SCREEN_ROUTES,
  resolveNotificationTarget,
} from '../../src/lib/notificationRoute';

const link = (deep_link: unknown) => ({ type: 'family_meal_request', deep_link });

describe('resolveNotificationTarget — ネイティブ画面', () => {
  it("設計書 §3.3 の例 'homegohan://family/meal-requests' は、画面が無い下位パスなので実在する上位の画面 '/family' を開く", () => {
    expect(resolveNotificationTarget(link('homegohan://family/meal-requests'))).toEqual({
      kind: 'screen',
      href: '/family',
    });
  });

  it('上位の画面に落ちたときは、下位パスのためのクエリを引き継がない', () => {
    expect(resolveNotificationTarget(link('homegohan://family/meal-requests?id=abc'))).toEqual({
      kind: 'screen',
      href: '/family',
    });
  });

  it('載せている画面は、それぞれそのまま開く', () => {
    for (const route of NOTIFICATION_SCREEN_ROUTES) {
      // ':name' の区間には適当な ID を入れる
      const concrete = route.replace(/:[A-Za-z]+/g, 'abc-123');
      expect(resolveNotificationTarget(link(`homegohan://${concrete.slice(1)}`))).toEqual({
        kind: 'screen',
        href: concrete,
      });
    }
  });

  it('静的な画面と動的な画面が同じ階層にあっても、どちらも開ける (/ai/important と /ai/<id>)', () => {
    expect(resolveNotificationTarget(link('homegohan://ai/important'))).toEqual({ kind: 'screen', href: '/ai/important' });
    expect(resolveNotificationTarget(link('homegohan://ai/session-9'))).toEqual({ kind: 'screen', href: '/ai/session-9' });
  });

  it('ID 付きの画面 (AI 相談、レシピ) を開ける', () => {
    expect(resolveNotificationTarget(link('homegohan://ai/3f2c1c3e-1111-2222-3333-444455556666'))).toEqual({
      kind: 'screen',
      href: '/ai/3f2c1c3e-1111-2222-3333-444455556666',
    });
    expect(resolveNotificationTarget(link('homegohan://recipes/abc_123'))).toEqual({
      kind: 'screen',
      href: '/recipes/abc_123',
    });
  });

  it("スキーム無しの先頭 '/' のパスも、アプリ内パスとして同じに扱う", () => {
    expect(resolveNotificationTarget(link('/pantry'))).toEqual({ kind: 'screen', href: '/pantry' });
  });

  it('クエリは許した文字だけなら引き継ぐ', () => {
    expect(resolveNotificationTarget(link('homegohan://health/record?date=2026-10-08&tab=weight'))).toEqual({
      kind: 'screen',
      href: '/health/record?date=2026-10-08&tab=weight',
    });
  });

  it("'homegohan:///family' のようにスラッシュが多くても正規化する", () => {
    expect(resolveNotificationTarget(link('homegohan:///family'))).toEqual({ kind: 'screen', href: '/family' });
  });
});

describe('NOTIFICATION_SCREEN_ROUTES — app/ 配下の画面と食い違っていない', () => {
  const APP_DIR = path.resolve(__dirname, '../../app');

  /** ':name' → '[name]'。app/<区間>.tsx、app/<区間>/index.tsx、(tabs) グループ内の画面のどれかがあれば実在とみなす */
  function screenFileExists(route: string): boolean {
    const segments = route
      .split('/')
      .filter(Boolean)
      .map((part) => (part.startsWith(':') ? `[${part.slice(1)}]` : part));
    const base = path.join(APP_DIR, ...segments);
    return [
      `${base}.tsx`,
      path.join(base, 'index.tsx'),
      `${path.join(APP_DIR, '(tabs)', ...segments)}.tsx`,
    ].some((file) => fs.existsSync(file));
  }

  it('載せた全ての画面に、対応するファイルがある (無い画面へ遷移して Unmatched Route にならない)', () => {
    const missing = NOTIFICATION_SCREEN_ROUTES.filter((route) => !screenFileExists(route));
    expect(missing).toEqual([]);
  });

  it('設定・アカウント削除・管理系・初期設定の画面は載せていない', () => {
    const forbidden = ['settings', 'onboarding', 'handson-tour', 'admin', 'super-admin', 'support', 'org', 'login', 'signup'];
    const topSegments = NOTIFICATION_SCREEN_ROUTES.map((route) => route.split('/')[1]);
    expect(topSegments.filter((segment) => forbidden.includes(segment))).toEqual([]);
  });
});

describe('resolveNotificationTarget — WebView のタブ', () => {
  it('タブそのもの (prefix) は、ページを指定せずタブを切り替える', () => {
    expect(resolveNotificationTarget(link('homegohan://home'))).toEqual({
      kind: 'tab',
      route: '/(tabs)/home',
      initialPath: null,
    });
    expect(resolveNotificationTarget(link('homegohan://menus'))).toEqual({
      kind: 'tab',
      route: '/(tabs)/menus',
      initialPath: null,
    });
  });

  it('タブの最初のページ (rootPath) も、ページを指定せずタブを切り替える (再読み込みを避ける)', () => {
    expect(resolveNotificationTarget(link('homegohan://menus/weekly'))).toEqual({
      kind: 'tab',
      route: '/(tabs)/menus',
      initialPath: null,
    });
    expect(resolveNotificationTarget(link('homegohan://meals/new'))).toEqual({
      kind: 'tab',
      route: '/(tabs)/meals',
      initialPath: null,
    });
  });

  it('タブ配下の別ページやクエリ付きは、そのタブの WebView でそのページを開く (initialPath)', () => {
    expect(resolveNotificationTarget(link('homegohan://menus/weekly?date=2026-10-08'))).toEqual({
      kind: 'tab',
      route: '/(tabs)/menus',
      initialPath: '/menus/weekly?date=2026-10-08',
    });
    expect(resolveNotificationTarget(link('homegohan://meals/3f2c1c3e-aaaa-bbbb-cccc-1234567890ab'))).toEqual({
      kind: 'tab',
      route: '/(tabs)/meals',
      initialPath: '/meals/3f2c1c3e-aaaa-bbbb-cccc-1234567890ab',
    });
    expect(resolveNotificationTarget(link('/profile/nutrition-targets'))).toEqual({
      kind: 'tab',
      route: '/(tabs)/profile',
      initialPath: '/profile/nutrition-targets',
    });
  });
});

describe('resolveNotificationTarget — 無視するもの (遷移しない)', () => {
  it('deep_link が無い / 文字列でない / data が不正', () => {
    expect(resolveNotificationTarget(undefined)).toBeNull();
    expect(resolveNotificationTarget(null)).toBeNull();
    expect(resolveNotificationTarget('homegohan://family')).toBeNull();
    expect(resolveNotificationTarget({})).toBeNull();
    expect(resolveNotificationTarget({ deep_link: 123 })).toBeNull();
    expect(resolveNotificationTarget({ deep_link: ['homegohan://family'] })).toBeNull();
    expect(resolveNotificationTarget({ deep_link: '' })).toBeNull();
    expect(resolveNotificationTarget({ deep_link: '   ' })).toBeNull();
  });

  it('アプリ以外のスキーム・外部 URL・スキーム相対 URL', () => {
    expect(resolveNotificationTarget(link('https://example.com/family'))).toBeNull();
    expect(resolveNotificationTarget(link('http://localhost/home'))).toBeNull();
    expect(resolveNotificationTarget(link('javascript:alert(1)'))).toBeNull();
    expect(resolveNotificationTarget(link('//evil.example/home'))).toBeNull();
    expect(resolveNotificationTarget(link('otherapp://home'))).toBeNull();
    expect(resolveNotificationTarget(link('family'))).toBeNull();
  });

  it('許可していない画面 (設定・アカウント削除・管理系・初期設定など)', () => {
    for (const blocked of [
      'homegohan://settings/account',
      'homegohan://settings',
      'homegohan://onboarding',
      'homegohan://handson-tour',
      'homegohan://admin',
      'homegohan://super-admin/settings',
      'homegohan://org/dashboard',
      'homegohan://login',
      'homegohan://invite/family/abc123',
    ]) {
      expect(resolveNotificationTarget(link(blocked))).toBeNull();
    }
  });

  it("'..' やエンコード、バックスラッシュ、括弧などパスとして許していない文字", () => {
    for (const bad of [
      'homegohan://family/../settings/account',
      'homegohan://home/%2e%2e/settings',
      'homegohan://family%2Fx',
      'homegohan://family\\x',
      'homegohan://(tabs)/home',
      'homegohan://family/[id]',
      'homegohan://family/a.b',
      'homegohan://family/ x',
      'homegohan://family//x',
    ]) {
      expect(resolveNotificationTarget(link(bad))).toBeNull();
    }
  });

  it('区間が 5 つ以上、ハッシュ付き、長すぎるもの', () => {
    expect(resolveNotificationTarget(link('homegohan://ai/a/b/c/d'))).toBeNull();
    expect(resolveNotificationTarget(link('homegohan://family#section'))).toBeNull();
    expect(resolveNotificationTarget(link(`homegohan://family/${'a'.repeat(600)}`))).toBeNull();
  });

  it('クエリに許していない文字がある (パスの注入、エンコード、スペース)', () => {
    expect(resolveNotificationTarget(link('homegohan://home?initialPath=//evil.example'))).toBeNull();
    expect(resolveNotificationTarget(link('homegohan://home?next=%2Fauth%2Fnative-bridge'))).toBeNull();
    expect(resolveNotificationTarget(link('homegohan://menus/weekly?a=b c'))).toBeNull();
    expect(resolveNotificationTarget(link('homegohan://family?x=<script>'))).toBeNull();
    expect(resolveNotificationTarget(link(`homegohan://family?x=${'a'.repeat(300)}`))).toBeNull();
  });

  it("ルート ('homegohan://') だけでは遷移しない (アプリが開くだけ)", () => {
    expect(resolveNotificationTarget(link('homegohan://'))).toBeNull();
    expect(resolveNotificationTarget(link('/'))).toBeNull();
  });
});
