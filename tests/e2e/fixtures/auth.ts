import { test as base, expect, type Page } from "@playwright/test";

export const E2E_USER = {
  email: process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local",
  password: process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
};

export async function login(page: Page) {
  await page.goto("/login");
  await page.locator("#email").fill(E2E_USER.email);
  await page.locator("#password").fill(E2E_USER.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"), {
      timeout: 60_000,
    }),
    page.locator("button[type=submit]").click(),
  ]);
  await expect(page).not.toHaveURL(/\/login/);
}

type AuthFixtures = {
  authedPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ page }, use) => {
    await login(page);
    await use(page);
  },
});

export { expect };
