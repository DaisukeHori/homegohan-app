/**
 * Bug-69 (#69): 通知 / 自動解析 toggle が DB/localStorage に保存されずリロードでリセット
 *
 * 確認内容:
 * 1. /settings で通知 toggle を反転してリロード → 反転後の状態が保持される
 * 2. 自動解析 toggle も同様に永続化される
 */
import { test, expect } from './fixtures/auth';

// DB を変更するため並列実行時の干渉を防ぐためシリアルに実行する
test.describe.configure({ mode: 'serial' });

test.describe('settings toggle persistence (#69)', () => {
  test('通知 toggle が reload 後も保持される', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    // networkidle まで待つことで mount 時の GET fetch 完了を保証する
    await authedPage.waitForLoadState('networkidle');

    // 「通知」テキストを含む行コンテナ (flex items-center justify-between) 内の button (Switch)
    const notifRow = authedPage.locator('div.flex.items-center.justify-between', {
      has: authedPage.locator('span', { hasText: '通知' }),
    }).first();
    const notifSwitch = notifRow.locator('button').first();

    // Switch が DOM に存在することを確認
    await expect(notifSwitch).toBeVisible({ timeout: 10_000 });

    // 現在の状態を確認
    const isCheckedClass = async () => {
      const cls = await notifSwitch.getAttribute('class');
      return cls?.includes('bg-[#FF8A65]') ?? false;
    };

    const initialState = await isCheckedClass();

    // toggle を反転 — PATCH を click と同時に待機してレース条件を防ぐ
    await Promise.all([
      authedPage.waitForResponse(
        (res) =>
          res.url().includes('/api/notification-preferences') &&
          res.request().method() === 'PATCH' &&
          res.status() === 200,
        { timeout: 30_000 },
      ),
      notifSwitch.click(),
    ]);

    // リロード後も状態が保持されている
    await authedPage.reload();
    // networkidle まで待つことで mount 時の GET fetch 完了を保証する
    await authedPage.waitForLoadState('networkidle');

    // React state が DOM に反映されるのを待つ
    if (!initialState) {
      await expect(notifSwitch).toHaveClass(/bg-\[#FF8A65\]/, { timeout: 10_000 });
    } else {
      await expect(notifSwitch).not.toHaveClass(/bg-\[#FF8A65\]/, { timeout: 10_000 });
    }

    const afterReloadState = await isCheckedClass();
    expect(afterReloadState).toBe(!initialState);
  });

  test('自動解析 toggle が reload 後も保持される', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    // networkidle まで待つことで mount 時の GET fetch 完了を保証する
    await authedPage.waitForLoadState('networkidle');

    // 自動解析スイッチを特定: 「自動解析」span を含む行コンテナ内の button (Switch)
    const autoSwitch = authedPage.locator('div.flex.items-center.justify-between', {
      has: authedPage.locator('span', { hasText: '自動解析' }),
    }).first().locator('button').first();

    await expect(autoSwitch).toBeVisible({ timeout: 10_000 });

    const isChecked = async () => {
      const cls = await autoSwitch.getAttribute('class');
      return cls?.includes('bg-[#FF8A65]') ?? false;
    };

    const initialState = await isChecked();

    await Promise.all([
      authedPage.waitForResponse(
        (res) =>
          res.url().includes('/api/notification-preferences') &&
          res.request().method() === 'PATCH' &&
          res.status() === 200,
        { timeout: 30_000 },
      ),
      autoSwitch.click(),
    ]);

    await authedPage.reload();
    await authedPage.waitForLoadState('networkidle');

    if (!initialState) {
      await expect(autoSwitch).toHaveClass(/bg-\[#FF8A65\]/, { timeout: 10_000 });
    } else {
      await expect(autoSwitch).not.toHaveClass(/bg-\[#FF8A65\]/, { timeout: 10_000 });
    }

    const afterReloadState = await isChecked();
    expect(afterReloadState).toBe(!initialState);
  });
});
