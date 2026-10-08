/**
 * ネイティブアプリ (apps/mobile) の下部タブと、WebView に表示する Web のパスの対応表。
 *
 * タブ間の移動は、WebView の中のリンクをネイティブ側のタブ切り替えに置き換えて行う。
 * その「どのパスがどのタブのものか」を判定する場所が 2 つあり、以前はそれぞれが別々の一覧を持っていた。
 *   - ネイティブ: apps/mobile/src/components/web/WebViewScreen.tsx (WebView に注入するスクリプトと onMessage)
 *   - Web:        src/components/native-app/NativeAppTabRouter.tsx
 * 2 つの一覧は食い違っていて (ネイティブは '/meals'、Web は '/meals/new')、Web が送る
 * tab-navigate メッセージの path がネイティブの一覧に無く、読み捨てられることがあった (#1049 F7-22)。
 * 両方ともこの表だけを見るようにして、食い違いが起きないようにする。
 *
 * 新しいタブを足す / 変えるときは、この表と apps/mobile/app/(tabs) のタブ画面を一緒に変える
 * (tests/native-app-tabs-contract.test.ts がタブ画面との食い違いを検出する)。
 */

export interface NativeAppTab {
  /** タブ画面のファイル名 (apps/mobile/app/(tabs)/<name>.tsx) */
  name: string;
  /**
   * このタブが受け持つ Web パスの先頭。'/menus' なら '/menus' と '/menus/...' が対象。
   * tab-navigate メッセージの path にもこの値を入れる。
   */
  pathPrefix: string;
  /** Expo Router のタブルート */
  route: string;
  /** タブを開いたときに最初に表示する Web のパス (タブ画面が WebViewScreen に渡す path) */
  rootPath: string;
}

export const NATIVE_APP_TABS: readonly NativeAppTab[] = [
  { name: 'menus', pathPrefix: '/menus', route: '/(tabs)/menus', rootPath: '/menus/weekly' },
  // 食事詳細 ('/meals/<id>') も、スキャン画面 ('/meals/new') と同じタブとして扱ってきた
  // (ネイティブの WebView はこれまでも '/meals' 配下を 1 つのタブとして切り替えている)。
  { name: 'meals', pathPrefix: '/meals', route: '/(tabs)/meals', rootPath: '/meals/new' },
  { name: 'comparison', pathPrefix: '/comparison', route: '/(tabs)/comparison', rootPath: '/comparison' },
  { name: 'profile', pathPrefix: '/profile', route: '/(tabs)/profile', rootPath: '/profile' },
  { name: 'home', pathPrefix: '/home', route: '/(tabs)/home', rootPath: '/home' },
];

/**
 * Web のパス (pathname。クエリ・ハッシュは付けない) が属するタブ。どのタブにも属さなければ null。
 * '/menus' と '/menus/weekly' は menus タブ、'/menus-foo' や '/homepage' はどのタブでもない。
 */
export function findNativeAppTab(pathname: string): NativeAppTab | null {
  return (
    NATIVE_APP_TABS.find((tab) => pathname === tab.pathPrefix || pathname.startsWith(`${tab.pathPrefix}/`)) ?? null
  );
}
