import { test, expect } from "@playwright/test";

test.describe("smoke", () => {
  test("landing page renders", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status() ?? 0).toBeLessThan(400);
    await expect(page).toHaveTitle(/.+/);
  });

  test("login page renders form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("button[type=submit]")).toBeVisible();
  });
});
