/**
 * プッシュ通知をタップしたときに開く画面を、通知の data から決める (#1049 F7-11)。
 *
 * 行き先は data.path (アプリ内のパス。例: '/menus') か、data.deep_link (homegohan:// の URL。例: 'homegohan://health/blood-tests')
 * に入る (通知の data の形は docs/design/mobile/03-push-notification.md §3.3)。
 * どちらも homegohan:// の後ろがアプリ内のパス (expo-router の画面) になる。app.json の scheme が "homegohan" で、
 * expo-router は URL のパスをそのまま app/ の画面に当てるため (docs/design/mobile/02-deep-link.md §3.1 はこのスキームで
 * 受ける URL の一覧で、通知の行き先の形はここで決める。通知の data の形は 03-push-notification.md §3.3)。
 *
 * 通知の中身はサーバーが組み立てるが、Expo の Push Token が分かれば第三者も送れるので、受け取った行き先をそのまま
 * 画面遷移に使わない。許す形を狭く決め、外れるものは無視する (無視すると、アプリがその場で開くだけ)。
 *   - 'homegohan://<パス>' か、先頭が '/' のアプリ内のパスだけ。ほかのスキーム (https: など) と '//' で始まるものは無視
 *   - パスの各区間は英数字・'_'・'-' だけ (MAX_PATH_SEGMENTS 区間まで)。'..'・'%' (エンコード)・'\' を含むものは無視
 *   - クエリは任意だが、使える文字を絞る。ハッシュ (#) を含むものは無視
 *   - 行き先は NOTIFICATION_ROUTES に載せた画面だけ。設定・アカウント・管理・初期設定・ログインの画面は開かない
 *   - 通常の操作で届かないネイティブの画面は消した (#1598 / #1610)。家族 ('/family')・食材 ('/pantry')・買い物リスト・レシピ・
 *     AI 相談 ('/ai')・健康の記録 ('/health' と '/health/streaks' など)・バッジ・お気に入り・週の献立 ('/menus/weekly') の画面は
 *     アプリに無い。その行き先の通知 (§3.3 の例の 'homegohan://family/meal-requests' など) は行き先が決まらず、アプリが開くだけになる
 *     (献立・食事・マイページの中身は、タブの WebView が Web の画面で出す)
 *   - 画面が無い下位のパス ('/health/blood-tests/abc' など) は、載せた中で一番近い上位の画面 ('/health/blood-tests') を開く
 *     (「Unmatched Route」の画面を出さないため)。上位に落ちたときは、下位のためのクエリは引き継がない
 *   - 静的な区間は動的な区間 (':name') より優先して当てる (expo-router が app/ の画面を選ぶ順と同じ)。'/meals/:id' を載せても、
 *     静的な兄弟の '/meals/new' は '/meals/:id' 扱いにしない。通知から開かない静的な兄弟は NOTIFICATION_CLOSED_STATIC_ROUTES に載せ、
 *     そのパスは上位の画面に落とす (#1612)
 */

const DEEP_LINK_SCHEME = "homegohan://";

/**
 * 通知から開いてよい画面。apps/mobile/app/ に実在する画面だけを載せる (__tests__/lib/notification-route.test.ts が
 * app/ のファイルと突き合わせる)。':name' は任意の 1 区間 (動的な区間 [name] の画面。いまは載せていない)。
 * 新しい通知の行き先を増やすときは、画面を作ってからここに足す。動的な区間の画面を足すときは、app/ にあるその静的な兄弟の画面を
 * ここか NOTIFICATION_CLOSED_STATIC_ROUTES のどちらかに載せる (載せ忘れは同じテストが落とす)。
 */
export const NOTIFICATION_ROUTES: readonly string[] = [
  // タブ
  "/home",
  "/menus",
  "/meals",
  "/comparison",
  "/profile",
  // 健康 (血液検査。設定から開く画面)
  "/health/blood-tests",
];

/**
 * 通知から開かない静的な画面のうち、NOTIFICATION_ROUTES の動的な区間の画面 (':name') にも当たってしまう兄弟 (#1612)。
 * 例: '/meals/:id' を NOTIFICATION_ROUTES に載せ、'/meals/new' は通知から開かないなら、ここに '/meals/new' を載せる。
 * 静的な区間が動的な区間より優先して当たるので、ここに載せたパスは '/meals/:id' 扱いにならず、上位の画面 ('/meals') に落ちる。
 * いまは動的な区間の画面を載せていないので空。
 */
export const NOTIFICATION_CLOSED_STATIC_ROUTES: readonly string[] = [];

/** 行き先を決めるときに使う画面の表 (テストが差し替えられるように、既定値を 1 つにまとめる) */
export interface NotificationRouteTable {
  /** 通知から開いてよい画面 */
  readonly routes: readonly string[];
  /** 通知から開かない静的な画面 (動的な区間の画面の兄弟) */
  readonly closedStaticRoutes: readonly string[];
}

export const NOTIFICATION_ROUTE_TABLE: NotificationRouteTable = {
  routes: NOTIFICATION_ROUTES,
  closedStaticRoutes: NOTIFICATION_CLOSED_STATIC_ROUTES,
};

/** パスの区間の数の上限 (NOTIFICATION_ROUTES の最も深い画面が 2 区間。余裕を 1 つ見る) */
const MAX_PATH_SEGMENTS = 3;
/** 受け付ける行き先の文字数の上限 (これより長いものは不正な通知として無視する) */
const MAX_TARGET_LENGTH = 512;

/** 1 つの区間に使える文字 */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
/** クエリに使える文字 ('%' のエンコード・'#' は通さない) */
const QUERY_PATTERN = /^[A-Za-z0-9_\-.=&,:+]+$/;

/** 動的な区間 (':name') か */
function isDynamicSegment(part: string): boolean {
  return part.startsWith(":");
}

/** 区間の数が同じで、':name' 以外の区間が一致するか */
function matchesRoute(routeSegments: readonly string[], segments: readonly string[]): boolean {
  return (
    routeSegments.length === segments.length &&
    routeSegments.every((part, index) => isDynamicSegment(part) || part === segments[index])
  );
}

/**
 * 当たった 2 つの画面のどちらを優先するか (負なら a を優先)。前の区間から順に比べ、最初に違う区間で静的な方を優先する
 * (expo-router と同じ。'/meals/new' は '/meals/:id' より、'/a/b/:y' は '/a/:x/b' より優先)
 */
function compareSpecificity(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const aDynamic = isDynamicSegment(a[index]);
    if (aDynamic !== isDynamicSegment(b[index])) return aDynamic ? 1 : -1;
  }
  return 0;
}

/**
 * 区間の並びに当たる画面を決める。静的な区間を優先して当て (compareSpecificity)、一番優先される画面が
 * 通知から開いてよい画面ならそれを返す。当たる画面が無い・一番優先されるのが開かない静的な画面なら null。
 *
 * @param segments パスの区間 (例: ['meals', 'new'])
 * @param table 画面の表 (既定は NOTIFICATION_ROUTE_TABLE)
 * @returns 当たった画面 (NOTIFICATION_ROUTES の要素。例: '/meals/:id') か null
 */
export function findNotificationRoute(
  segments: readonly string[],
  table: NotificationRouteTable = NOTIFICATION_ROUTE_TABLE,
): string | null {
  const candidates = [
    ...table.routes.map((route) => ({ route, open: true })),
    ...table.closedStaticRoutes.map((route) => ({ route, open: false })),
  ]
    .map((entry) => ({ ...entry, parts: entry.route.split("/").filter(Boolean) }))
    .filter((entry) => matchesRoute(entry.parts, segments));
  if (candidates.length === 0) return null;
  // 優先の等しい画面が複数あるときは、表に載せた順 (Array.prototype.sort は安定) で先のもの
  const best = [...candidates].sort((a, b) => compareSpecificity(a.parts, b.parts))[0];
  return best.open ? best.route : null;
}

/** 通知の data から、行き先の文字列 (path を優先し、無ければ deep_link) を取り出す */
function rawTargetOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const { path, deep_link: deepLink } = data as { path?: unknown; deep_link?: unknown };
  if (typeof path === "string" && path.trim() !== "") return path.trim();
  if (typeof deepLink === "string" && deepLink.trim() !== "") return deepLink.trim();
  return null;
}

/**
 * 通知の data から、expo-router に渡す行き先 (アプリ内のパス) を決める。決められなければ null。
 * - data.path / data.deep_link が無い・形が不正・NOTIFICATION_ROUTES のどの画面にも当たらない → null
 * - NOTIFICATION_CLOSED_STATIC_ROUTES の画面は開かず、上位の画面に落とす
 *
 * @param data 通知の request.content.data
 * @param table 画面の表 (既定は NOTIFICATION_ROUTE_TABLE。テストが差し替える)
 */
export function resolveNotificationHref(
  data: unknown,
  table: NotificationRouteTable = NOTIFICATION_ROUTE_TABLE,
): string | null {
  const raw = rawTargetOf(data);
  if (raw === null || raw.length > MAX_TARGET_LENGTH || raw.includes("#")) return null;

  // 'homegohan://pantry' → '/pantry'。先頭が '/' のアプリ内のパスはそのまま ('//host' はスキーム相対の URL なので除く)
  let target: string;
  if (raw.startsWith(DEEP_LINK_SCHEME)) {
    target = `/${raw.slice(DEEP_LINK_SCHEME.length)}`;
  } else if (raw.startsWith("/") && !raw.startsWith("//")) {
    target = raw;
  } else {
    return null;
  }

  const questionMark = target.indexOf("?");
  const pathname = questionMark === -1 ? target : target.slice(0, questionMark);
  const query = questionMark === -1 ? "" : target.slice(questionMark + 1);
  if (query !== "" && !QUERY_PATTERN.test(query)) return null;

  // 末尾の '/' は許す ('homegohan://pantry/')。途中の空の区間 ('/a//b') は不正
  const segments = pathname.replace(/\/$/, "").split("/").slice(1);
  if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) return null;
  if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) return null;

  // 載せた画面に当たるまで、後ろの区間を削っていく
  for (let length = segments.length; length >= 1; length -= 1) {
    const candidate = segments.slice(0, length);
    if (findNotificationRoute(candidate, table) === null) continue;
    const href = `/${candidate.join("/")}`;
    const exact = length === segments.length;
    return exact && query !== "" ? `${href}?${query}` : href;
  }
  return null;
}
