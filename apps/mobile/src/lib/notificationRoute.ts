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
 */

const DEEP_LINK_SCHEME = "homegohan://";

/**
 * 通知から開いてよい画面。apps/mobile/app/ に実在する画面だけを載せる (__tests__/lib/notification-route.test.ts が
 * app/ のファイルと突き合わせる)。':name' は任意の 1 区間 (動的な区間 [name] の画面。いまは載せていない)。
 * 新しい通知の行き先を増やすときは、画面を作ってからここに足す。
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

/** パスの区間の数の上限 (NOTIFICATION_ROUTES の最も深い画面が 2 区間。余裕を 1 つ見る) */
const MAX_PATH_SEGMENTS = 3;
/** 受け付ける行き先の文字数の上限 (これより長いものは不正な通知として無視する) */
const MAX_TARGET_LENGTH = 512;

/** 1 つの区間に使える文字 */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
/** クエリに使える文字 ('%' のエンコード・'#' は通さない) */
const QUERY_PATTERN = /^[A-Za-z0-9_\-.=&,:+]+$/;

/** 区間の数が同じで、':name' 以外の区間が一致するか */
function matchesRoute(route: string, segments: readonly string[]): boolean {
  const routeSegments = route.split("/").filter(Boolean);
  return (
    routeSegments.length === segments.length &&
    routeSegments.every((part, index) => part.startsWith(":") || part === segments[index])
  );
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
 *
 * @param data 通知の request.content.data
 */
export function resolveNotificationHref(data: unknown): string | null {
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
    if (!NOTIFICATION_ROUTES.some((route) => matchesRoute(route, candidate))) continue;
    const href = `/${candidate.join("/")}`;
    const exact = length === segments.length;
    return exact && query !== "" ? `${href}?${query}` : href;
  }
  return null;
}
