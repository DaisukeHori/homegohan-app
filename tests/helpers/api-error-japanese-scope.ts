/**
 * API の失敗の本文の日本語化 (#1917) の見張りの範囲 — ここが 1 か所の正本
 *
 * tests/api-error-japanese-scan.test.ts が読む。モジュールごとの直しの Workflow は、自分の配下の route を
 * src/lib/api/error-responses.ts の日本語の固定の文に直したら、次の 2 つを同じ PR で行う:
 *   1. JAPANESE_ERROR_API_DIRS に自分の配下を足す (本文を作る共通の関数のファイルがあれば JAPANESE_ERROR_SHARED_BODY_FILES にも)
 *   2. UNFIXED_VIOLATION_BASELINE から、直した配下の行を消す (一部だけ直したなら、残りの件数に書き換える)
 * 利用者の画面に出ず、相手が機械 (外部のサービスの Webhook・Vercel Cron) で英字の code のまま残す配下は、1 の代わりに
 * MACHINE_FACING_ERROR_TEXT_PATHS に理由つきで載せる (番兵の数から外れ、本文が機械向けの code だけであることを見張る)。
 * 番兵は、一覧の外の違反の件数が基線と違えば赤になる (増えた = 新しい英語の文が入った / 減った = 直したのに一覧と基線を更新していない)。
 */

/** 直し終えた配下 (この下の route.ts の失敗の本文に、英語だけの文と例外の文面が 1 件も無いことを見張る) */
export const JAPANESE_ERROR_API_DIRS: readonly string[] = [
  'src/app/api/org',
  'src/app/api/health',
  'src/app/api/cron',
  'src/app/api/e2e',
  'src/app/api/admin',
  'src/app/api/support',
  'src/app/api/ai',
  // super_admin・運営の操作 (operator は membership の配下ごと。強制の譲渡の 2 route は #1981 のマージの後に直した)
  'src/app/api/super-admin',
  'src/app/api/operator/membership/audit',
  'src/app/api/operator/membership/families',
  'src/app/api/operator/membership/orgs',
  'src/app/api/operator/membership/family/[id]/candidates',
  'src/app/api/operator/membership/family/[id]/dissolve',
  'src/app/api/operator/membership/org/[id]/candidates',
  'src/app/api/operator/membership/org/[id]/dissolve',
  'src/app/api/operator/membership/org/[id]/transfer',
  'src/app/api/operator/membership/family/[id]/transfer',
  // 利用者向けの配下 (#1917 の利用者向けの残りのモジュール)
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
  'src/lib/billing/http.ts',
  'src/lib/org-api-errors.ts',
  'src/lib/org-challenge-api.ts',
  'src/lib/super-admin/validation-errors.ts',
  'src/lib/admin/not-supported.ts',
];

/** 英字の機械向けの code のまま残す配下・ファイルと、その理由 */
export interface MachineFacingErrorTextPath {
  /** `src/app/api/<配下>` (この下の route.ts) か、本文を作るファイル (`src/lib/....ts`) */
  readonly path: string;
  /** 英語のまま残す理由 (日本語で書く) */
  readonly reason: string;
}

/**
 * 対象外: 失敗の本文の文を、英字の機械向けの code (英小文字と _ だけ。'unauthorized'・'payload_too_large' など) のまま残す配下・ファイル。
 * 利用者の画面 (src/app・apps/mobile) には出ず、相手が外部のサービス・機械で、文ではなく code で照合するもの。
 * ここに載せた配下は番兵の数から外し、代わりに「本文の文が機械向けの code だけ (英語の文と例外の文面が無い)」ことを見張る
 * (tests/api-error-japanese-scan.test.ts)。'Unauthorized' のような英語の文を足すと赤になる
 */
export const MACHINE_FACING_ERROR_TEXT_PATHS: readonly MachineFacingErrorTextPath[] = [
  {
    path: 'src/app/api/webhooks',
    reason:
      'Stripe・RevenueCat・Resend のサーバーが送る Webhook の受け口。応答は相手のサーバーが状態 (401 / 413 / 503 / 409 など) で再送を決め、' +
      '本文は利用者の画面に出ない。Stripe・RevenueCat の本文の code (payload_too_large・webhook_not_configured・event_in_progress など) は ' +
      '設計書 billing/01・billing/03 と tests/webhooks-*-route.test.ts が読む機械向けの code。Resend の受け口 (src/app/api/webhooks/resend/route.ts) は、相手が状態 (401 / 413 / 503 / 400) だけを読む',
  },
  {
    path: 'src/lib/cron-auth.ts',
    reason:
      'Vercel Cron が呼ぶ /api/cron/** の認証 (requireCronAuth) の 401 / 503 の本文。相手は Vercel Cron で、利用者の画面に出ない。' +
      'code (unauthorized・cron_disabled) は設計書 billing/04 §認証が読む機械向けの code',
  },
];

/**
 * 番兵の数から外す route (別の PR が今まさに本文を直している途中のファイル)。
 * その PR のマージで件数が動いても main が赤くならないよう、ここで外しておく。
 * その PR がマージされたら、ここから行を消し、UNFIXED_VIOLATION_BASELINE をその時点の件数に数え直す
 */
export const SENTINEL_EXCLUDED_ROUTE_FILES: readonly string[] = [];

/**
 * 一覧の外 (まだ直していない配下) の違反の件数の基線。キー = `src/app/api/<最初の区切り>`、値 = 英語だけの文と例外の文面の件数の合計。
 * 件数が 0 の配下は書かない。いまは src/app/api の配下がすべて JAPANESE_ERROR_API_DIRS か MACHINE_FACING_ERROR_TEXT_PATHS に入っており、基線は空 (新しい違反は 1 件でも tests/api-error-japanese-scan.test.ts が赤にする)
 */
export const UNFIXED_VIOLATION_BASELINE: Readonly<Record<string, number>> = {};
