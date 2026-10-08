/**
 * プッシュ通知をタップしたときに開く画面を、通知の data から決める (#1049 F7-11)。
 *
 * 通知のペイロードは docs/design/mobile/03-push-notification.md §3.3 のとおり、
 * `data.deep_link` にアプリ内の行き先を入れる。例:
 *   { type: 'family_meal_request', request_id: '…', deep_link: 'homegohan://family/meal-requests' }
 *
 * 通知の中身はサーバーが組み立てるが、Expo の Push Token さえ分かれば第三者も送れるため、
 * 受け取った行き先をそのまま画面遷移に使わない。許す形を狭く決めて、外れるものは無視する
 * (無視すると、アプリがその場で開くだけ)。
 *   - 'homegohan://<パス>' か、先頭が '/' のアプリ内パスだけ。ほかのスキーム (https:, javascript: など) は無視
 *   - パスの各区間は英数字・'_'・'-' だけ (最大 4 区間)。'..' やエンコード、'\' は無視
 *   - クエリは任意だが使える文字を絞る。ハッシュ (#) は無視
 *   - 行き先は、WebView のタブか、下の NOTIFICATION_SCREEN_ROUTES に載せたネイティブ画面だけ。
 *     設定・アカウント削除・管理系・初期設定の画面は開かない。
 *   - 画面が無い下位のパス (例: 設計書の 'family/meal-requests') は、実在する一番近い上位の画面
 *     ('/family') を開く。「Unmatched Route」の画面を出さないため。
 */

import { findNativeAppTab } from '@homegohan/shared';

const DEEP_LINK_SCHEME = 'homegohan://';

/**
 * 通知から開いてよいネイティブ画面 (タブ以外)。apps/mobile/app/ 配下に実在する画面だけを載せる
 * (__tests__/lib/notification-route.test.ts が app/ と突き合わせる)。':name' は任意の 1 区間。
 * 新しい通知の行き先を増やすときは、画面を作ってからここに足す。
 */
export const NOTIFICATION_SCREEN_ROUTES: readonly string[] = [
  '/family',
  '/ai',
  '/ai/important',
  '/ai/:sessionId',
  '/pantry',
  '/shopping-list',
  '/recipes',
  '/recipes/new',
  '/recipes/collections',
  '/recipes/collections/select',
  '/recipes/collections/:collectionId',
  '/recipes/:id',
  '/health',
  '/health/blood-tests',
  '/health/challenges',
  '/health/checkups',
  '/health/checkups/new',
  '/health/goals',
  '/health/graphs',
  '/health/insights',
  '/health/record',
  '/health/record/quick',
  '/health/record/:date',
  '/health/settings',
  '/health/streaks',
  '/badges',
];

/** パスは英数字・'_'・'-' の区間を '/' でつないだ形だけ (最大 4 区間)。'.' や '%' を含む区間は通さない */
const PATH_PATTERN = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,3}$/;

/** クエリに使える文字。'%' (エンコード) や '#' は通さない */
const QUERY_PATTERN = /^[A-Za-z0-9_\-.=&,:+]{1,256}$/;

const MAX_DEEP_LINK_LENGTH = 512;

export type NotificationTarget =
  /** WebView のタブ。route はタブのルート。initialPath があるときは、そのページを開く */
  | { kind: 'tab'; route: string; initialPath: string | null }
  /** ネイティブ画面。href は expo-router にそのまま渡せる形 */
  | { kind: 'screen'; href: string };

/** 区間数が同じで、':name' 以外の区間が一致するか */
function matchesRoute(route: string, segments: readonly string[]): boolean {
  const routeSegments = route.split('/').filter(Boolean);
  if (routeSegments.length !== segments.length) return false;
  return routeSegments.every((part, index) => part.startsWith(':') || part === segments[index]);
}

/**
 * pathname の区間を後ろから削りながら、実在するネイティブ画面に最初に当たるものを探す。
 * 完全に一致すれば exact: true。上位の画面に落ちたなら exact: false。
 */
function findNativeScreen(segments: readonly string[]): { path: string; exact: boolean } | null {
  for (let length = segments.length; length >= 1; length -= 1) {
    const candidate = segments.slice(0, length);
    if (NOTIFICATION_SCREEN_ROUTES.some((route) => matchesRoute(route, candidate))) {
      return { path: `/${candidate.join('/')}`, exact: length === segments.length };
    }
  }
  return null;
}

/**
 * 通知の data から行き先を決める。決められない (deep_link が無い / 形が不正 / 許可していない画面) なら null。
 *
 * @param data  通知の `request.content.data`
 */
export function resolveNotificationTarget(data: unknown): NotificationTarget | null {
  if (typeof data !== 'object' || data === null) return null;

  const raw = (data as { deep_link?: unknown }).deep_link;
  if (typeof raw !== 'string') return null;
  const link = raw.trim();
  if (link === '' || link.length > MAX_DEEP_LINK_LENGTH) return null;

  // 'homegohan://family' → '/family'。先頭が '/' のアプリ内パスはそのまま ('//host' はスキーム相対 URL なので除く)
  let path: string;
  if (link.startsWith(DEEP_LINK_SCHEME)) {
    path = `/${link.slice(DEEP_LINK_SCHEME.length).replace(/^\/+/, '')}`;
  } else if (link.startsWith('/') && !link.startsWith('//')) {
    path = link;
  } else {
    return null;
  }

  if (path.includes('#')) return null;
  const questionMark = path.indexOf('?');
  const pathname = questionMark === -1 ? path : path.slice(0, questionMark);
  const query = questionMark === -1 ? '' : path.slice(questionMark + 1);

  if (!PATH_PATTERN.test(pathname)) return null;
  if (query !== '' && !QUERY_PATTERN.test(query)) return null;
  const pathWithQuery = query === '' ? pathname : `${pathname}?${query}`;

  // WebView のタブ ('/menus/weekly' など)。Web のパスをそのまま、そのタブの WebView で開く
  const tab = findNativeAppTab(pathname);
  if (tab) {
    // タブそのもの (タブの最初のページ) なら、ページを指定せずタブを切り替えるだけにして、再読み込みを避ける
    const isTabRoot = query === '' && (pathname === tab.pathPrefix || pathname === tab.rootPath);
    return { kind: 'tab', route: tab.route, initialPath: isTabRoot ? null : pathWithQuery };
  }

  // ネイティブ画面。実在する画面に当たらなければ遷移しない
  const screen = findNativeScreen(pathname.split('/').filter(Boolean));
  if (!screen) return null;
  // 上位の画面に落ちたときは、下位のパスのためのクエリは引き継がない
  return { kind: 'screen', href: screen.exact ? pathWithQuery : screen.path };
}
