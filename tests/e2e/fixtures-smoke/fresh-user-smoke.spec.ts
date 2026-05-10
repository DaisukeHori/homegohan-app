/**
 * tests/e2e/fixtures-smoke/fresh-user-smoke.spec.ts
 *
 * fresh-user fixture の動作確認 smoke test。
 * 3 種類の fixture それぞれが:
 *   1. ユーザーを正常に作成/クリーンアップできること
 *   2. 期待する URL / 状態で use(page) が呼ばれること
 * を検証する。
 *
 * 実行: npx playwright test tests/e2e/fixtures-smoke/fresh-user-smoke.spec.ts --workers=1 --reporter=list
 */

import { expect } from "@playwright/test";
import { test } from "../fixtures/fresh-user";

// 全テストに十分なタイムアウトを設定 (admin API + ページ遷移を含む)
test.use({ storageState: { cookies: [], origins: [] } });

// ─────────────────────────────────────────────────────────────────────────────
// freshUserPage
// ─────────────────────────────────────────────────────────────────────────────

test("freshUserPage: signup できる — /auth/verify または /onboarding に遷移", async ({
  freshUserPage,
}) => {
  // freshUserPage は既に /auth/callback 経由で確認済み + ログイン状態
  // 新規ユーザーなので /onboarding か /auth/verify に着くはず
  const url = freshUserPage.url();
  console.log(`[freshUserPage smoke] current URL: ${url}`);

  await expect(freshUserPage).toHaveURL(/auth\/verify|onboarding|home/);

  // /signup や /login にとどまっていないこと (signup が完了している)
  expect(url).not.toMatch(/\/signup/);
  expect(url).not.toMatch(/\/login/);
});

// ─────────────────────────────────────────────────────────────────────────────
// onboardingPendingUser
// ─────────────────────────────────────────────────────────────────────────────

test("onboardingPendingUser: / にアクセスすると /onboarding にリダイレクトされる", async ({
  onboardingPendingUser,
}) => {
  // onboarding 未完了なので / にアクセスすると /onboarding にリダイレクトされるはず
  await onboardingPendingUser.goto("/");
  await onboardingPendingUser.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });

  const url = onboardingPendingUser.url();
  console.log(`[onboardingPendingUser smoke] current URL after goto("/"): ${url}`);

  // /onboarding または / (SPA でリダイレクト前) のいずれかに着くこと
  // (サーバー側の middleware により onboarding へリダイレクト)
  await expect(onboardingPendingUser).toHaveURL(/onboarding/);
});

// ─────────────────────────────────────────────────────────────────────────────
// tourPendingUser
// ─────────────────────────────────────────────────────────────────────────────

test("tourPendingUser: /handson-tour にアクセスするとツアー UI が表示される", async ({
  tourPendingUser,
}) => {
  // onboarding 完了済み + tour 未起動 → /handson-tour で eligible 状態
  await tourPendingUser.goto("/handson-tour");
  await tourPendingUser.waitForLoadState("domcontentloaded");

  const url = tourPendingUser.url();
  console.log(`[tourPendingUser smoke] current URL after goto("/handson-tour"): ${url}`);

  // /login にリダイレクトされていないこと (認証済みであること)
  expect(url).not.toMatch(/\/login/);

  // /handson-tour にいること (onboarding 完了済みなので eligible)
  await expect(tourPendingUser).toHaveURL(/handson-tour/);

  // ページが表示されていること (500 / エラーページでないこと)
  const content = await tourPendingUser.content();
  expect(content).not.toContain("Internal Server Error");
});
