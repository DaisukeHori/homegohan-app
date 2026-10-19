/**
 * #1867: ハッシュだけの移動 (`<a href="#how">`・スキップリンク・アドレス欄でハッシュを書き換える) で積まれた履歴の項目を、
 * Next の app router が「戻る / 進む」で描き直せるようにするための判定 (部品は src/components/navigation/HashHistoryEntryBridge.tsx)。
 *
 * 原因 (Next 16.4.2 の next/dist/client/components/app-router.js の handlePopState。16.4.1 から app-router.js・layout-router.js・
 *   router-reducer の restore は変わっていない (#1902 で node_modules の両版を突き合わせた)):
 *   - app router は自分が積んだ履歴の項目に、印 (`__NA: true`) と描き直しに使う木を history.state に入れる。
 *   - ブラウザの通常のハッシュの移動は、新しい項目を history.state = null で積む (Next を通らない)。
 *   - popstate の state が null の項目は、app router が何もせずに返す (`if (!state) return`)。
 *   そのため `/` → `#how` (state null) → next/link で `/signup` → 戻る と進むと、URL だけ `/#how` に戻り、画面は `/signup` のまま残る。
 *
 * 直し方: ハッシュの移動で積まれた項目で、Next の公開の口 (Next が差し替えた history.replaceState) を呼んで印を付ける。印は 2 段で付く (Next 16.4.2 の app-router.js):
 *   1. 差し替えた replaceState は、今の項目の state にある印と木を写すだけ (copyNextJsInternalHistoryState)。ハッシュの移動で積まれた項目の state は null なので
 *      写すものが無く、ここでは印は付かない。あわせて、今の URL で app router の状態を作り直す (applyUrlFromHistoryPushReplace → restore)。
 *   2. restore の後の再描画で、HistoryUpdater が今の項目の state に印 (`__NA: true`) と今の画面の木を書く (replaceState。URL は変わらない)。
 * 印を付けるのは、画面に描かれているルートと URL のパス・検索の部分が同じとき (= 同じ画面の中のハッシュの移動) だけ。
 * 検索の部分は、書き方の違い (`%20` と `+`・値の無いキー `?ref` と `?ref=`・`/` と `%2F`) をそろえてから比べる (normalizeSearch)。
 * それでも印の無い項目へ戻って画面と URL がずれたとき (印を付ける前に積まれた項目) は、今の URL で文書を読み込み直す。
 */

/** app router が history.state に入れる、自分の項目の印の鍵 (Next の内部の名前。Next を上げたら e2e の戻るの spec が検知する) */
export const APP_ROUTER_HISTORY_MARK = '__NA';

/** URL のうち、画面 (ルート) を決める部分 (ハッシュは画面を変えないので含めない) */
export type RouteLocation = {
  pathname: string;
  /**
   * `?` から始まる検索の部分。無ければ空文字 (window.location.search と同じ形)。
   * 書き方は揃っていなくてよい (window.location.search は URL に書かれたまま、useSearchParams は URLSearchParams で書き直した形)。
   * 比べるときは isSameRoute が normalizeSearch でそろえる。
   */
  search: string;
};

/**
 * 検索の部分を、URLSearchParams で読み直して書き直した形 (`?` つき。無ければ空文字) にそろえる。
 * 画面側の値 (useSearchParams。Next 16.4.2 の app-router.js は new URL(canonicalUrl).searchParams を渡すので、toString() はこの形) と、
 * URL 側の値 (window.location.search。URL に書かれたまま) を同じ形で比べるため。
 * 例: `?a=x%20y&ref` → `?a=x+y&ref=`・`?next=/home` → `?next=%2Fhome`。同じ形に何度通しても変わらない。
 */
export function normalizeSearch(search: string): string {
  const serialized = new URLSearchParams(search).toString();
  return serialized ? `?${serialized}` : '';
}

/** history.state が app router の積んだ項目 (印つき) か */
export function isAppRouterHistoryState(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  return (state as Record<string, unknown>)[APP_ROUTER_HISTORY_MARK] === true;
}

/** usePathname / useSearchParams の値を RouteLocation に直す (検索の部分は window.location.search と同じ `?` つきの形) */
export function toRouteLocation(pathname: string | null, searchParams: string | null): RouteLocation | null {
  if (pathname === null) return null;
  return { pathname, search: searchParams ? `?${searchParams}` : '' };
}

/**
 * 画面に描かれているルートと、ブラウザの URL のルートが同じか (ハッシュは比べない)。
 * 検索の部分は両辺を normalizeSearch でそろえて比べる (書き方だけ違う同じ URL を「別のルート」と取り違えると、
 * hashchange で印が付かず、同じ画面の中の戻る / 進むのたびに読み込み直してしまう)。
 * パスはそろえない: 両辺とも URL の解析器を通った形 (window.location.pathname と、app-router.js の new URL(canonicalUrl).pathname) で、書き方が揃っている。
 */
export function isSameRoute(rendered: RouteLocation | null, current: RouteLocation): boolean {
  if (rendered === null) return false;
  return rendered.pathname === current.pathname && normalizeSearch(rendered.search) === normalizeSearch(current.search);
}

/** ハッシュの移動 (hashchange) のあとにすること */
export type HashChangeAction = 'mark-entry' | 'none';

/**
 * hashchange のあと: 今の項目に印が無く、画面と URL のルートが同じ (= 同じ画面の中のハッシュの移動) なら、印を付ける。
 * ルートが違う (印の無い古い項目へ戻ってきた) ときは印を付けない (今の画面の木を、別のルートの項目に入れてしまうため)。
 */
export function decideOnHashChange(state: unknown, rendered: RouteLocation | null, current: RouteLocation): HashChangeAction {
  if (isAppRouterHistoryState(state)) return 'none';
  return isSameRoute(rendered, current) ? 'mark-entry' : 'none';
}

/** 戻る / 進む (popstate) のあとにすること */
export type PopStateAction = 'redraw' | 'none';

/**
 * popstate のあと: state が null (app router が何もしない項目) で、画面と URL のルートが違うなら、今の URL で読み込み直して描き直す。
 * state が null でないとき (印つき = app router が描き直す / 印の無い別の値 = app router が読み込み直す) は手を出さない。
 * ルートが同じとき (同じ画面の中のハッシュの移動) は、ブラウザがスクロールするだけでよい。
 */
export function decideOnPopState(state: unknown, rendered: RouteLocation | null, current: RouteLocation): PopStateAction {
  if (state !== null) return 'none';
  if (rendered === null) return 'none';
  return isSameRoute(rendered, current) ? 'none' : 'redraw';
}
