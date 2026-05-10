/**
 * 01-login.spec.ts
 * ログインフローの基本動作確認
 *
 * freshUserPage fixture: admin.generateLink で signup トークンを生成し
 * /auth/callback 経由で確認済み + ログイン状態を作る。
 * E2E_USER_EMAIL / PASSWORD 環境変数が不要になり、毎テスト独立した fresh user で動作する。
 */
import { test, expect } from "./fixtures/fresh-user";

test("ログインできる", async ({ freshUserPage: page }) => {
  // freshUserPage は /auth/callback 経由でログイン済み。
  // /onboarding か /home に遷移しているはずなので、ログイン後の URL を確認する。
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
  // home / menus / onboarding のいずれかに遷移すること
  await expect(page).toHaveURL(/\/(home|menus|onboarding|$)/, { timeout: 15000 });
});
