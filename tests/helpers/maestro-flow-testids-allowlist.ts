// tests/helpers/maestro-flow-testids-allowlist.ts
// maestro の flow が期待しているが、ソース (apps/mobile と src) に無い testID の許可リスト (#1552)。
// 検査: tests/maestro-flow-testids.test.ts
//
// ここに載っているのは、#1552 の時点で既にあった食い違い (meals 以外の flow の古い testID) だけ。
// 新しく flow を書くとき・直すときに、ここへ足して検査を通してはいけない (ソースにある testID を使う)。
// 直した flow の行は消す (ソースに testID が出来た・flow が使わなくなった行が残っていると、検査が落ちる)。
// meals の flow (apps/mobile/maestro/flows/meals/) は #1552 で直したので、ここに載せてはいけない (検査が落ちる)。

/** 許可する理由 */
export const MISSING_TESTID_REASONS = {
  /** ホームのタブは WebView (apps/mobile/app/(tabs)/home.tsx の webview-home)。ネイティブのホームの画面 (home-screen) とその部品 (home-*) は無い */
  HOME_WEBVIEW:
    "ホームのタブは WebView (webview-home)。ネイティブのホームの画面とその部品 (home-*) は無い。flow の見直しは #1552 (meals) の範囲外",
  /**
   * 献立のタブは WebView (webview-menus)。flow が期待するこの id はソースに無い
   * (ネイティブの週の献立の画面 apps/mobile/app/menus/weekly/index.tsx は、通常の操作で届かない画面として消した。#1598)
   */
  MENUS_WEBVIEW: "献立のタブは WebView (webview-menus)。flow が期待するこの id はソースに無い。flow の見直しは #1552 (meals) の範囲外",
  /** 画面の作り替えで名前が変わった・無くなった testID */
  NOT_IN_SOURCE_OUT_OF_SCOPE:
    "画面の作り替えで名前が変わった・無くなった testID (ソースに無い)。flow の見直しは #1552 (meals) の範囲外",
} as const;

export type MissingTestIdReason = (typeof MISSING_TESTID_REASONS)[keyof typeof MISSING_TESTID_REASONS];

export type MissingTestIdAllowance = {
  /** flow のファイル (apps/mobile/maestro からの相対パス) */
  flow: string;
  /** flow が期待している、ソースに無い testID (maestro の id: の値そのまま) */
  id: string;
  reason: MissingTestIdReason;
};

const R = MISSING_TESTID_REASONS;

export const MAESTRO_MISSING_TESTID_ALLOWLIST: readonly MissingTestIdAllowance[] = [
  { flow: "flows/01-login.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/_shared/complete-onboarding-maintain.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/_shared/login-for-onboarding.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/01-login-existing-user-to-home.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/02-admin-login-normal-routing.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/03-onboarding-incomplete-user-redirect.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/06-welcome-signup-login-e2e.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/17-adversarial-email-5000-chars.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/18-adversarial-password-sql-injection.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/19-adversarial-email-xss-payload.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/20-adversarial-next-param-open-redirect.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/23-expired-jwt-home-redirect-to-root.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/24-google-oauth-cancel-returns-to-login.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/25-webview-session-handoff.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/auth/25-webview-session-handoff.yaml", id: "loading-indicator", reason: R.NOT_IN_SOURCE_OUT_OF_SCOPE },
  { flow: "flows/handson-tour/01-show-on-onboarding-complete.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/handson-tour/03-step0-skip-button.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/handson-tour/07-step4-graduate-and-home.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/handson-tour/07-step4-graduate-and-home.yaml", id: "tour-step-5-toast", reason: R.NOT_IN_SOURCE_OUT_OF_SCOPE },
  { flow: "flows/handson-tour/09-existing-user-auto-skip.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/handson-tour/10-admin-role-bypass.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/01-all-sections-display.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/01-all-sections-display.yaml", id: "home-health-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/01-all-sections-display.yaml", id: "home-streak-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/01-all-sections-display.yaml", id: "home-checkin-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/01-all-sections-display.yaml", id: "home-weekly-graph-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/02-condition-active-tap.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/02-condition-active-tap.yaml", id: "home-streak-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/02-condition-active-tap.yaml", id: "home-health-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/02-condition-active-tap.yaml", id: "home-checkin-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/03-meal-tap-completion-toggle.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/03-meal-tap-completion-toggle.yaml", id: "home-record-meal-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/03-meal-tap-completion-toggle.yaml", id: "home-ai-menu-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/03-meal-tap-completion-toggle.yaml", id: "home-shopping-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/04-30sec-checkin.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/04-30sec-checkin.yaml", id: "home-checkin-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/04-30sec-checkin.yaml", id: "home-checkin-submit-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/05-ai-suggestion-dismiss.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/05-ai-suggestion-dismiss.yaml", id: "home-ai-suggestion-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/05-ai-suggestion-dismiss.yaml", id: "home-ai-suggestion-dismiss-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/06-weekly-graph-modal.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/06-weekly-graph-modal.yaml", id: "home-weekly-graph-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/06-weekly-graph-modal.yaml", id: "home-weekly-modal", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/06-weekly-graph-modal.yaml", id: "home-weekly-modal-close", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/08-announcement-dismiss.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/09-validation-slider-3h.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/09-validation-slider-3h.yaml", id: "home-checkin-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/09-validation-slider-3h.yaml", id: "home-checkin-submit-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/10-validation-slider-12h.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/10-validation-slider-12h.yaml", id: "home-checkin-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/10-validation-slider-12h.yaml", id: "home-checkin-submit-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/11-api-error-use-home-data-fail.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/11-api-error-use-home-data-fail.yaml", id: "home-streak-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/11-api-error-use-home-data-fail.yaml", id: "home-health-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/11-api-error-use-home-data-fail.yaml", id: "home-record-meal-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/12-api-error-toggle-meal-rollback.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/12-api-error-toggle-meal-rollback.yaml", id: "home-weekly-graph-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/12-api-error-toggle-meal-rollback.yaml", id: "home-weekly-modal", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/12-api-error-toggle-meal-rollback.yaml", id: "home-weekly-modal-close", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/13-api-error-checkin-fail.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/13-api-error-checkin-fail.yaml", id: "home-checkin-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/13-api-error-checkin-fail.yaml", id: "home-checkin-submit-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/14-api-error-ai-suggestion-fail.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/14-api-error-ai-suggestion-fail.yaml", id: "home-ai-suggestion-dismiss-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/15-adversarial-meals-100-items.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/16-adversarial-announcements-20.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/17-adversarial-expiring-items-50.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/17-adversarial-expiring-items-50.yaml", id: "home-expiring-alert-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/18-adversarial-dish-name-null.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/19-adversarial-broken-image-url.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/20-state-bg-fg-refetch.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/20-state-bg-fg-refetch.yaml", id: "home-streak-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/20-state-bg-fg-refetch.yaml", id: "home-health-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/21-state-network-disconnect.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/21-state-network-disconnect.yaml", id: "home-streak-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/21-state-network-disconnect.yaml", id: "home-monthly-cook-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/21-state-network-disconnect.yaml", id: "home-health-card", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/23-state-midnight-snack.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/23-state-midnight-snack.yaml", id: "home-record-meal-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/home/23-state-midnight-snack.yaml", id: "home-ai-menu-button", reason: R.HOME_WEBVIEW },
  { flow: "flows/onboarding/01-welcome-start-complete.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/onboarding/02-welcome-skip-home.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/onboarding/14-api-error-welcome-skip-fail.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/onboarding/19-adversarial-resume-param-tamper.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/onboarding/22-state-completed-welcome-redirect.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/screenshots/01-all-screens-baseline.yaml", id: "home-screen", reason: R.HOME_WEBVIEW },
  { flow: "flows/screenshots/01-all-screens-baseline.yaml", id: "menus-screen", reason: R.MENUS_WEBVIEW },
  { flow: "onboarding-flow.yaml", id: "nickname-input", reason: R.NOT_IN_SOURCE_OUT_OF_SCOPE },
  { flow: "onboarding-flow.yaml", id: "next-button", reason: R.NOT_IN_SOURCE_OUT_OF_SCOPE },
];
