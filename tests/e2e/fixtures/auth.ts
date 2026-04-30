import { test as base, expect, type Page } from "@playwright/test";

export const E2E_USER = {
  email: process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local",
  password: process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
};

export const E2E_ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "",
  password: process.env.E2E_ADMIN_PASSWORD ?? "",
};

export const E2E_SUPER = {
  email: process.env.E2E_SUPER_EMAIL ?? "",
  password: process.env.E2E_SUPER_PASSWORD ?? "",
};

async function loginWith(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"), {
      timeout: 30_000,
    }),
    page.locator("button[type=submit]").click(),
  ]);
  await expect(page).not.toHaveURL(/\/login/);
}

export async function login(page: Page) {
  await loginWith(page, E2E_USER.email, E2E_USER.password);
}

type AuthFixtures = {
  authedPage: Page;
  adminPage: Page;
  superAdminPage: Page;
  generalPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ page }, use) => {
    await loginWith(page, E2E_USER.email, E2E_USER.password);
    await use(page);
  },
  adminPage: async ({ page }, use) => {
    await loginWith(page, E2E_ADMIN.email, E2E_ADMIN.password);
    await use(page);
  },
  superAdminPage: async ({ page }, use) => {
    await loginWith(page, E2E_SUPER.email, E2E_SUPER.password);
    await use(page);
  },
  generalPage: async ({ page }, use) => {
    await loginWith(page, E2E_USER.email, E2E_USER.password);
    await use(page);
  },
});

export { expect };
