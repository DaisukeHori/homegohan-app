/**
 * tests/e2e/helpers/auth.ts
 *
 * E2E 共通ログインヘルパー。
 * React hydration 完了を waitForFunction で確認してから submit することで、
 * Next.js SSR → hydration タイミングによる native form GET 送信を防ぐ。
 */

import type { Page } from "@playwright/test";

const LOGIN_TIMEOUT_MS = 90_000;
const HYDRATION_TIMEOUT_MS = 15_000;

/**
 * React hydration 完了を確認する。
 * submit ボタンの __reactProps / __reactFiber キーが存在すれば
 * React のイベントハンドラがアタッチ済みと判断する。
 */
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector(
        'form button[type="submit"], button[type="submit"]',
      );
      if (!btn) return false;
      return Object.keys(btn as Record<string, unknown>).some(
        (k) => k.startsWith("__reactProps") || k.startsWith("__reactFiber"),
      );
    },
    { timeout: HYDRATION_TIMEOUT_MS },
  );
}

/**
 * 本番 URL にログインして page を認証済み状態にする。
 *
 * @param page - Playwright の Page オブジェクト
 * @param email - ログイン用メールアドレス (省略時は E2E_USER_EMAIL env)
 * @param password - ログイン用パスワード (省略時は E2E_USER_PASSWORD env)
 */
export async function login(
  page: Page,
  email?: string,
  password?: string,
): Promise<void> {
  const _email =
    email ?? process.env.E2E_USER_EMAIL ?? "e2e-user@homegohan.test";
  const _password =
    password ??
    process.env.E2E_USER_PASSWORD ??
    "E2eUser2026!Test#Secure";

  await page.goto("/login");
  // networkidle でネットワーク落ち着きを待つ
  await page.waitForLoadState("networkidle");
  // client-side rate limit key をクリアして「しばらく待って」エラーを回避
  // #1057 (UX1-16 round-2): キーがメールアドレス単位 (`auth_last_fail_ts:<email>`) に
  // 変わったため prefix 一致で全て削除する
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('auth_last_fail_ts'))
      .forEach((k) => localStorage.removeItem(k));
  });
  // React hydration 完了を確認 (button に __reactProps が付くまで)
  await waitForHydration(page).catch(() => {
    // hydration チェックが timeout してもログイン処理は継続する
    // (SSG / Server Component 構成の場合は __reactProps が無い場合もある)
  });

  await page.locator("#email").fill(_email);
  await page.locator("#password").fill(_password);

  // submit と URL 遷移を並列で待つ
  await Promise.all([
    page.waitForURL(
      (url) =>
        !url.pathname.startsWith("/login") &&
        !url.pathname.startsWith("/auth"),
      { timeout: LOGIN_TIMEOUT_MS },
    ),
    page.locator("button[type=submit]").click(),
  ]);

  // オンボーディング未完了の場合はAPIで完了させてホームへ誘導
  if (page.url().includes("/onboarding")) {
    await page.evaluate(async () => {
      try {
        await fetch("/api/onboarding/complete", {
          method: "POST",
          credentials: "include",
        });
      } catch {
        // エラーは無視して続行
      }
    });
    await page.goto("/home");
    await page.waitForURL("**/home", { timeout: 60_000 });
  }
}
