/**
 * ネイティブアプリ (apps/mobile) の下部タブと、WebView に表示する Web のパスの対応表 (#1612 / #1049 F7-22)。
 *
 * タブ間の移動は、WebView の中のリンクをネイティブのタブの切り替えに置き換えて行う。
 * 「どのパスがどのタブのものか」を判定する場所は 2 つあり、以前はそれぞれが別々の一覧を持っていた。
 *   - ネイティブ: apps/mobile/src/components/web/WebViewScreen.tsx (WebView に注入するスクリプト・onMessage・initialPath の検証)
 *   - Web:        src/components/native-app/NativeAppTabRouter.tsx
 * 2 つの一覧は食い違っていて (ネイティブは '/meals'、Web は '/meals/new')、Web が送る tab-navigate の path ('/meals/new') が
 * ネイティブの一覧に無く、読み捨てられていた。両方ともこの表だけを見るようにして、食い違いが起きないようにする。
 *
 * タブを足す・変えるときは、この表と apps/mobile/app/(tabs) のタブの画面を一緒に変える
 * (tests/native-app-tabs-contract.test.ts が、タブの画面・2 か所の配線との食い違いを検出する)。
 */

export interface NativeAppTab {
  /** タブの画面のファイル名 (apps/mobile/app/(tabs)/<name>.tsx) */
  readonly name: string;
  /**
   * このタブが受け持つ Web のパスの先頭。'/menus' なら '/menus' と '/menus/...' が対象。
   * tab-navigate のメッセージの path にもこの値を入れる。
   */
  readonly pathPrefix: string;
  /** Expo Router のタブのルート */
  readonly route: string;
  /** タブを開いたときに最初に出す Web のパス (タブの画面が WebViewScreen の path に渡す値) */
  readonly rootPath: string;
}

export const NATIVE_APP_TABS: readonly NativeAppTab[] = [
  { name: 'menus', pathPrefix: '/menus', route: '/(tabs)/menus', rootPath: '/menus/weekly' },
  // 食事の詳細 ('/meals/<id>') も、スキャンの画面 ('/meals/new') と同じタブとして扱う
  // (ネイティブが WebView に注入するスクリプトは、以前から '/meals' の配下を 1 つのタブとして切り替えていた)
  { name: 'meals', pathPrefix: '/meals', route: '/(tabs)/meals', rootPath: '/meals/new' },
  { name: 'comparison', pathPrefix: '/comparison', route: '/(tabs)/comparison', rootPath: '/comparison' },
  { name: 'profile', pathPrefix: '/profile', route: '/(tabs)/profile', rootPath: '/profile' },
  { name: 'home', pathPrefix: '/home', route: '/(tabs)/home', rootPath: '/home' },
];

/** パス (pathname。クエリ・ハッシュは付けない) が prefix そのものか、その配下か */
export function isPathUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Web のパス (pathname。クエリ・ハッシュは付けない) が属するタブ。どのタブにも属さなければ null。
 * '/menus' と '/menus/weekly' は menus のタブ、'/menus-foo' や '/homepage' はどのタブでもない。
 */
export function findNativeAppTab(pathname: string): NativeAppTab | null {
  return NATIVE_APP_TABS.find((tab) => isPathUnderPrefix(pathname, tab.pathPrefix)) ?? null;
}

/** tab-navigate のメッセージの path (= タブの pathPrefix そのもの) からタブを引く。prefix と完全に一致しなければ null */
export function findNativeAppTabByPathPrefix(pathPrefix: unknown): NativeAppTab | null {
  if (typeof pathPrefix !== 'string') return null;
  return NATIVE_APP_TABS.find((tab) => tab.pathPrefix === pathPrefix) ?? null;
}
