/**
 * #1867: ハッシュだけの移動 (`<a href="#how">`・スキップリンク・アドレス欄でハッシュを書き換える) で積まれた履歴の項目を、
 * Next の app router が「戻る / 進む」で描き直せるようにするための判定 (部品は src/components/navigation/HashHistoryEntryBridge.tsx)。
 *
 * 原因 (Next 16.4.1 の next/dist/client/components/app-router.js の handlePopState):
 *   - app router は自分が積んだ履歴の項目に、印 (`__NA: true`) と描き直しに使う木を history.state に入れる。
 *   - ブラウザの通常のハッシュの移動は、新しい項目を history.state = null で積む (Next を通らない)。
 *   - popstate の state が null の項目は、app router が何もせずに返す (`if (!state) return`)。
 *   そのため `/` → `#how` (state null) → next/link で `/signup` → 戻る と進むと、URL だけ `/#how` に戻り、画面は `/signup` のまま残る。
 *
 * 直し方: ハッシュの移動で積まれた項目に、Next の公開の口 (history.replaceState。Next が差し替えて、自分の状態に取り込む) で印を付ける。
 * 印を付けるのは、画面に描かれているルートと URL のパス・検索の部分が同じとき (= 同じ画面の中のハッシュの移動) だけ。
 * それでも印の無い項目へ戻って画面と URL がずれたとき (印を付ける前に積まれた項目) は、その URL へ置き換えの遷移で描き直す。
 */

/** app router が history.state に入れる、自分の項目の印の鍵 (Next の内部の名前。Next を上げたら e2e の戻るの spec が検知する) */
export const APP_ROUTER_HISTORY_MARK = '__NA';

/** URL のうち、画面 (ルート) を決める部分 (ハッシュは画面を変えないので含めない) */
export type RouteLocation = {
  pathname: string;
  /** `?` から始まる検索の部分。無ければ空文字 (window.location.search と同じ形) */
  search: string;
};

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

/** 画面に描かれているルートと、ブラウザの URL のルートが同じか (ハッシュは比べない) */
export function isSameRoute(rendered: RouteLocation | null, current: RouteLocation): boolean {
  if (rendered === null) return false;
  return rendered.pathname === current.pathname && rendered.search === current.search;
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
 * popstate のあと: state が null (app router が何もしない項目) で、画面と URL のルートが違うなら、その URL へ描き直す。
 * state が null でないとき (印つき = app router が描き直す / 印の無い別の値 = app router が読み込み直す) は手を出さない。
 * ルートが同じとき (同じ画面の中のハッシュの移動) は、ブラウザがスクロールするだけでよい。
 */
export function decideOnPopState(state: unknown, rendered: RouteLocation | null, current: RouteLocation): PopStateAction {
  if (state !== null) return 'none';
  if (rendered === null) return 'none';
  return isSameRoute(rendered, current) ? 'none' : 'redraw';
}
