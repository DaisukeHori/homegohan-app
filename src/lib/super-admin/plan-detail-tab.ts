/**
 * プラン詳細 (/super-admin/plans/[id]) のタブと、タブを指す URL (#2107 Y3)
 *
 * プラン詳細は URL の tab (`?tab=history` など) を初めのタブにする (src/app/super-admin/plans/[id]/page.tsx)。
 * 価格の変更の画面 (src/app/super-admin/plans/[id]/price-change/page.tsx) は、済んだあとと「済んだか分からない」の案内で
 * planDetailHref(id, 'history') へ送り、価格変更履歴のタブを開かせる。
 * 以前はプラン詳細が URL の tab を読まず、履歴へ送っても基本情報のタブが開いた。
 *
 * このファイルはブラウザから読むので、サーバー専用のものを import しない。
 */

/** プラン詳細のタブ (並びは画面のタブの並び) */
export const PLAN_DETAIL_TABS = ['basic', 'price', 'history'] as const;
export type PlanDetailTab = (typeof PLAN_DETAIL_TABS)[number];

/** URL の検索の鍵 (`?tab=history`) */
export const PLAN_DETAIL_TAB_QUERY_KEY = 'tab';

/** tab が無い・知らない値のときのタブ */
export const DEFAULT_PLAN_DETAIL_TAB: PlanDetailTab = 'basic';

/** URL の tab の値をタブにする。無い・知らない値 (大文字の違いも含む) なら基本情報 */
export function planDetailTabOf(value: string | null | undefined): PlanDetailTab {
  return PLAN_DETAIL_TABS.find((tab) => tab === value) ?? DEFAULT_PLAN_DETAIL_TAB;
}

/** プラン詳細の、指定したタブを開く URL */
export function planDetailHref(planId: string, tab: PlanDetailTab): string {
  const query = new URLSearchParams({ [PLAN_DETAIL_TAB_QUERY_KEY]: tab });
  return `/super-admin/plans/${planId}?${query.toString()}`;
}
