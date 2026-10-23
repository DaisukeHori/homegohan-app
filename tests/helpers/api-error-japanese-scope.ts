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
  // super_admin・運営の操作 (operator は、別の PR が直している途中の membership/{org,family}/[id]/transfer を除いた配下)
  'src/app/api/super-admin',
  'src/app/api/operator/membership/audit',
  'src/app/api/operator/membership/families',
  'src/app/api/operator/membership/orgs',
  'src/app/api/operator/membership/family/[id]/candidates',
  'src/app/api/operator/membership/family/[id]/dissolve',
  'src/app/api/operator/membership/org/[id]/candidates',
  'src/app/api/operator/membership/org/[id]/dissolve',
];

/** route が本文を作るのに使う共通の関数のファイル (ここも違反 0 件を見張る) */
export const JAPANESE_ERROR_SHARED_BODY_FILES: readonly string[] = [
  'src/lib/api/error-responses.ts',
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
      '本文は利用者の画面に出ない。本文の code (payload_too_large・webhook_not_configured・event_in_progress など) は ' +
      '設計書 billing/01・billing/03 と tests/webhooks-*-route.test.ts が読む機械向けの code',
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
export const SENTINEL_EXCLUDED_ROUTE_FILES: readonly string[] = [
  'src/app/api/operator/membership/family/[id]/transfer/route.ts',
  'src/app/api/operator/membership/org/[id]/transfer/route.ts',
];

/**
 * 一覧の外 (まだ直していない配下) の違反の件数の基線。キー = `src/app/api/<最初の区切り>`、値 = 英語だけの文と例外の文面の件数の合計。
 * 件数が 0 の配下は書かない。数えたのは 2026-10-23 の origin/main (509ccf36) の上
 */
export const UNFIXED_VIOLATION_BASELINE: Readonly<Record<string, number>> = {
  'src/app/api/account': 3,
  'src/app/api/announcements': 6,
  'src/app/api/auth': 1,
  'src/app/api/badges': 2,
  'src/app/api/catalog': 4,
  'src/app/api/comparison': 1,
  'src/app/api/contact': 1,
  'src/app/api/export': 3,
  'src/app/api/family': 1,
  'src/app/api/favorites': 1,
  'src/app/api/legal': 1,
  'src/app/api/log': 7,
  'src/app/api/meal-plans': 16,
  'src/app/api/meals': 9,
  'src/app/api/notification-preferences': 5,
  'src/app/api/nutrition': 2,
  'src/app/api/nutrition-targets': 2,
  'src/app/api/onboarding': 7,
  'src/app/api/pantry': 9,
  'src/app/api/performance': 11,
  'src/app/api/profile': 4,
  'src/app/api/push-tokens': 1,
  'src/app/api/recipes': 12,
  'src/app/api/shopping-list': 22,
  'src/app/api/storage': 2,
  'src/app/api/upload': 7,
};
