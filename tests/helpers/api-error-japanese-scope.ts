/**
 * API の失敗の本文の日本語化 (#1917) の見張りの範囲 — ここが 1 か所の正本
 *
 * tests/api-error-japanese-scan.test.ts が読む。モジュールごとの直しの Workflow は、自分の配下の route を
 * src/lib/api/error-responses.ts の日本語の固定の文に直したら、次の 2 つを同じ PR で行う:
 *   1. JAPANESE_ERROR_API_DIRS に自分の配下を足す (本文を作る共通の関数のファイルがあれば JAPANESE_ERROR_SHARED_BODY_FILES にも)
 *   2. UNFIXED_VIOLATION_BASELINE から、直した配下の行を消す (一部だけ直したなら、残りの件数に書き換える)
 * 番兵は、一覧の外の違反の件数が基線と違えば赤になる (増えた = 新しい英語の文が入った / 減った = 直したのに一覧と基線を更新していない)。
 */

/** 直し終えた配下 (この下の route.ts の失敗の本文に、英語だけの文と例外の文面が 1 件も無いことを見張る) */
export const JAPANESE_ERROR_API_DIRS: readonly string[] = [
  'src/app/api/account',
  'src/app/api/announcements',
  'src/app/api/auth',
  'src/app/api/badges',
  'src/app/api/billing',
  'src/app/api/catalog',
  'src/app/api/comparison',
  'src/app/api/contact',
  'src/app/api/csp-report',
  'src/app/api/experiments',
  'src/app/api/export',
  'src/app/api/family',
  'src/app/api/favorites',
  'src/app/api/feature-flags',
  'src/app/api/handson-tour',
  'src/app/api/legal',
  'src/app/api/log',
  'src/app/api/meal-plans',
  'src/app/api/meals',
  'src/app/api/menu-plans',
  'src/app/api/notification-preferences',
  'src/app/api/nutrition',
  'src/app/api/nutrition-targets',
  'src/app/api/onboarding',
  'src/app/api/org',
  'src/app/api/pantry',
  'src/app/api/performance',
  'src/app/api/profile',
  'src/app/api/push-tokens',
  'src/app/api/recipes',
  'src/app/api/shopping-list',
  'src/app/api/storage',
  'src/app/api/upload',
];

/** route が本文を作るのに使う共通の関数のファイル (ここも違反 0 件を見張る) */
export const JAPANESE_ERROR_SHARED_BODY_FILES: readonly string[] = [
  'src/lib/api/error-responses.ts',
  'src/lib/org-api-errors.ts',
  'src/lib/org-challenge-api.ts',
];

/**
 * 番兵の数から外す route (別の PR が今まさに本文を直している途中のファイル)。
 * その PR のマージで件数が動いても main が赤くならないよう、ここで外しておく。
 * その PR がマージされたら、ここから行を消し、UNFIXED_VIOLATION_BASELINE をその時点の件数に数え直す
 */
export const SENTINEL_EXCLUDED_ROUTE_FILES: readonly string[] = [
  'src/app/api/admin/organizations/route.ts',
  'src/app/api/admin/users/[id]/freeze/route.ts',
  'src/app/api/operator/membership/family/[id]/transfer/route.ts',
  'src/app/api/operator/membership/org/[id]/transfer/route.ts',
  'src/app/api/super-admin/plans/[id]/route.ts',
];

/**
 * 一覧の外 (まだ直していない配下) の違反の件数の基線。キー = `src/app/api/<最初の区切り>`、値 = 英語だけの文と例外の文面の件数の合計。
 * 件数が 0 の配下は書かない。数えたのは 2026-10-23 の origin/main (509ccf36) の上
 */
export const UNFIXED_VIOLATION_BASELINE: Readonly<Record<string, number>> = {
  'src/app/api/admin': 74,
  'src/app/api/ai': 112,
  'src/app/api/e2e': 2,
  'src/app/api/health': 59,
  'src/app/api/operator': 14,
  'src/app/api/super-admin': 46,
  'src/app/api/support': 18,
  'src/app/api/webhooks': 22,
};
