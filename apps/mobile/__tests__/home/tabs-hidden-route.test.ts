/**
 * #1591 設定の画面 (隠しタブ) は expo-router 58 でも届く — 実物の expo-router に通す
 *
 * (tabs)/_layout.tsx は settings を href: null でなく、tabBarButton: () => null と tabBarItemStyle: { display: 'none' } で隠す。
 * expo-router 58 の JS の Tabs は、href: null を hidden: true に置き換え (build/layouts/TabsClient.js の processScreens)、
 * hidden の route をタブの一覧から外し、それが前面になると最初のタブへ replace する
 * (build/standard-navigation/useVisibleTabsWithRedirect.js)。mock の Tabs (tab-layout.test.tsx) ではこの 2 つが見えないので、
 * ここで実物に layout と同じ options を通す。描画の部品 (タブバー・Link・navigator) と、hook が読む文脈 (router・フォーカス・
 * layout の route・ガード・href) だけを差し替え、processScreens と、タブの一覧の絞り込み・replace の判定は実物のまま。
 * 落ちたら: expo-router の更新で隠しタブの扱いが変わった。docs/design/mobile/07-toolchain-upgrade.md §9.10 を見直す
 * (Cannot find module なら、build の下の内部のファイルの置き場が変わった)。
 */
import path from 'path';
import { renderHook } from '@testing-library/react-native';

/** expo-router の build の場所。内部のモジュールを絶対パスで差し替えて読む (exports の './package.json' から引く) */
const EXPO_ROUTER_BUILD_DIR = path.join(path.dirname(require.resolve('expo-router/package.json')), 'build');
const fromBuild = (relativePath: string): string => path.join(EXPO_ROUTER_BUILD_DIR, relativePath);

/** (tabs)/_layout.tsx が宣言するタブの route の名前 (宣言の順) */
const TAB_ROUTE_NAMES: string[] = ['home', 'menus', 'meals', 'comparison', 'profile', 'settings'];
const SETTINGS_ROUTE_NAME = 'settings';
/** 最初のタブ (expo-router が、一覧に無い前面の route を戻す先) */
const INITIAL_TAB_ROUTE_NAME = 'home';
/** 差し替えた useBuildHref が作る href の頭 */
const TABS_HREF_PREFIX = '/(tabs)/';
/** layout で宣言した画面の descriptor の routeSource (expo-router 58 で、タブの一覧に入る条件の 1 つ) */
const LAYOUT_ROUTE_SOURCE = 'layout';
/** findIndex が見つけられなかったときの値 */
const NOT_FOUND_INDEX = -1;

type ScreenOptions = Record<string, unknown>;
type ScreenLike = { name: string; options?: ScreenOptions };
type ProcessScreens = (screens: ScreenLike[]) => ScreenLike[];
type TabRouteLike = { key: string; name: string };
type TabDescriptorLike = { routeSource: string; options: ScreenOptions };
type VisibleTabs = { visibleRoutes: TabRouteLike[]; focusedIndex: number; focusedFallbackRoute: TabRouteLike | undefined };
type UseVisibleTabsWithRedirect = (args: {
  routes: TabRouteLike[];
  routeNames: string[];
  focusedRouteKey: string | undefined;
  descriptors: Record<string, TabDescriptorLike>;
}) => VisibleTabs;

const mockRouterReplace = jest.fn();
let capturedProcessScreens: ProcessScreens | undefined;

// TabsClient は読み込みのときに integrateWithRouter へ processScreens を渡す。それを受け取る (TabsClient の中身は実物)
jest.doMock(fromBuild('standard-navigation'), () => ({
  integrateWithRouter: (_navigator: unknown, _router: unknown, options: { processScreens: ProcessScreens }) => {
    capturedProcessScreens = options.processScreens;
    return () => null;
  },
}));
// TabsClient が読む描画の部品は使わないので空にする (読み込みでタブバーや navigator の依存を引かない)
for (const relativePath of [
  'link/Link',
  'react-navigation/bottom-tabs',
  'react-navigation/bottom-tabs/navigators/createBottomTabNavigator',
  'standard-navigation/appendMissingPlaceholderTabRoutes',
  'layouts/createBaseTabProps',
]) {
  jest.doMock(fromBuild(relativePath), () => ({}));
}
// useVisibleTabsWithRedirect が読む文脈を差し替える (navigator は前面・プレビューでない・ガードなし・最初のタブは home)。
// react-navigation/native は TabsClient も読む (TabRouter を integrateWithRouter に渡すだけなので、無くてよい)
jest.doMock(fromBuild('react-navigation/native'), () => ({ useIsFocused: () => true }));
jest.doMock(fromBuild('global-state/useRouterActions'), () => ({ useRouterActions: () => ({ replace: mockRouterReplace }) }));
jest.doMock(fromBuild('link/preview/PreviewRouteContext'), () => ({ useIsPreview: () => false }));
jest.doMock(fromBuild('Route'), () => ({ useRouteNode: () => null }));
jest.doMock(fromBuild('routeNode'), () => ({ getValidInitialRouteName: () => INITIAL_TAB_ROUTE_NAME }));
jest.doMock(fromBuild('layouts/GuardContext'), () => ({ useGuardRedirect: () => undefined }));
jest.doMock(fromBuild('standard-navigation/useBuildHref'), () => ({
  useBuildHref: () => (route: TabRouteLike) => `${TABS_HREF_PREFIX}${route.name}`,
}));

function loadProcessScreens(): ProcessScreens {
  require(fromBuild('layouts/TabsClient'));
  if (capturedProcessScreens === undefined) {
    throw new Error('expo-router の TabsClient が integrateWithRouter に processScreens を渡していない (内部が変わった)');
  }
  return capturedProcessScreens;
}

function loadUseVisibleTabsWithRedirect(): UseVisibleTabsWithRedirect {
  const loaded: { useVisibleTabsWithRedirect: UseVisibleTabsWithRedirect } = require(fromBuild('standard-navigation/useVisibleTabsWithRedirect'));
  return loaded.useVisibleTabsWithRedirect;
}

/** (tabs)/_layout.tsx の settings の options と同じ形 (§9.10) */
const hiddenTabOptions = (): ScreenOptions => ({ tabBarButton: () => null, tabBarItemStyle: { display: 'none' } });

const routes: TabRouteLike[] = TAB_ROUTE_NAMES.map((name, position) => ({ key: `${name}-${position}`, name }));
const settingsRouteKey: string | undefined = routes.find((route) => route.name === SETTINGS_ROUTE_NAME)?.key;

/** タブの descriptor (どれも layout で宣言した画面)。settings だけ、processScreens を通した options にする */
function descriptorsWith(settingsOptions: ScreenOptions): Record<string, TabDescriptorLike> {
  const descriptors: Record<string, TabDescriptorLike> = {};
  for (const route of routes) {
    descriptors[route.key] = {
      routeSource: LAYOUT_ROUTE_SOURCE,
      options: route.name === SETTINGS_ROUTE_NAME ? settingsOptions : { title: route.name },
    };
  }
  return descriptors;
}

describe('#1591 設定の画面 (隠しタブ) は expo-router 58 でも届く (実物の processScreens と useVisibleTabsWithRedirect)', () => {
  const processScreens = loadProcessScreens();
  const useVisibleTabsWithRedirect = loadUseVisibleTabsWithRedirect();
  const processedSettingsOptions = (options: ScreenOptions): ScreenOptions =>
    processScreens([{ name: SETTINGS_ROUTE_NAME, options }])[0]?.options ?? {};

  beforeEach(() => {
    mockRouterReplace.mockClear();
  });

  it('T-TB1: tabBarButton: () => null と tabBarItemStyle: display none の settings は、processScreens がそのまま返す (hidden を付けない)', () => {
    const screen: ScreenLike = { name: SETTINGS_ROUTE_NAME, options: hiddenTabOptions() };
    const [processed] = processScreens([screen]);
    expect(processed).toBe(screen);
    expect(processed?.options?.hidden).toBeUndefined();
  });

  it('T-TB2: href: null は processScreens が hidden: true に置き換える (expo-router 58 の挙動。本冊が href: null を使わない理由)', () => {
    expect(processedSettingsOptions({ href: null })).toEqual({ hidden: true });
  });

  it('T-TB3: 隠しタブの settings が前面でも、タブの一覧に残り、最初のタブへ replace しない', () => {
    const descriptors = descriptorsWith(processedSettingsOptions(hiddenTabOptions()));
    const { result } = renderHook(() =>
      useVisibleTabsWithRedirect({ routes, routeNames: TAB_ROUTE_NAMES, focusedRouteKey: settingsRouteKey, descriptors }),
    );
    expect(result.current.visibleRoutes.map((route) => route.name)).toEqual(TAB_ROUTE_NAMES);
    expect(result.current.focusedIndex).toBe(TAB_ROUTE_NAMES.indexOf(SETTINGS_ROUTE_NAME));
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('T-TB4: href: null (hidden) の settings が前面だと、一覧から外れ、最初のタブへ 1 回 replace する (この番兵が実物の判定を見ていることの確かめ)', () => {
    const descriptors = descriptorsWith(processedSettingsOptions({ href: null }));
    const { result } = renderHook(() =>
      useVisibleTabsWithRedirect({ routes, routeNames: TAB_ROUTE_NAMES, focusedRouteKey: settingsRouteKey, descriptors }),
    );
    expect(result.current.visibleRoutes.map((route) => route.name)).not.toContain(SETTINGS_ROUTE_NAME);
    expect(result.current.focusedIndex).toBe(NOT_FOUND_INDEX);
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith(`${TABS_HREF_PREFIX}${INITIAL_TAB_ROUTE_NAME}`);
  });
});
