/**
 * Bug-69 (#69): 通知 / 自動解析 toggle が DB/localStorage に保存されずリロードでリセット
 *
 * 確認内容:
 * 1. /settings で通知 toggle を OFF にしてリロード → OFF のまま
 * 2. もう一度 ON にしてリロード → ON のまま
 * 3. 自動解析 toggle も同様に永続化される
 */
import { test, expect } from './fixtures/auth';

test.describe('settings toggle persistence (#69)', () => {
  test('通知 toggle が reload 後も保持される', async ({ authedPage }) => {
    await authedPage.goto('/settings');

    // API レスポンスを待機してから確認するため、GET リクエストを追跡
    await authedPage.waitForResponse(
      (res) => res.url().includes('/api/notification-preferences') && res.request().method() === 'GET',
      { timeout: 10_000 },
    );

    const notifSwitch = authedPage.locator('button').filter({ has: authedPage.locator('..').filter({ hasText: '通知' }) }).first();

    // 現在の状態を確認
    const isCheckedClass = async () => {
      const cls = await notifSwitch.getAttribute('class');
      return cls?.includes('bg-[#FF8A65]') ?? false;
    };

    const initialState = await isCheckedClass();

    // toggle を反転
    const patchPromise = authedPage.waitForResponse(
      (res) => res.url().includes('/api/notification-preferences') && res.request().method() === 'PATCH',
      { timeout: 10_000 },
    );
    await notifSwitch.click();
    const patchRes = await patchPromise;
    expect(patchRes.status()).toBe(200);

    // リロード後も状態が保持されている
    await authedPage.reload();
    await authedPage.waitForResponse(
      (res) => res.url().includes('/api/notification-preferences') && res.request().method() === 'GET',
      { timeout: 10_000 },
    );

    const afterReloadState = await isCheckedClass();
    expect(afterReloadState).toBe(!initialState);

    // もう一度 toggle して元に戻す
    const patchPromise2 = authedPage.waitForResponse(
      (res) => res.url().includes('/api/notification-preferences') && res.request().method() === 'PATCH',
      { timeout: 10_000 },
    );
    await notifSwitch.click();
    await patchPromise2;

    await authedPage.reload();
    await authedPage.waitForResponse(
      (res) => res.url().includes('/api/notification-preferences') && res.request().method() === 'GET',
      { timeout: 10_000 },
    );
    const restoredState = await isCheckedClass();
    expect(restoredState).toBe(initialState);
  });

  test('自動解析 toggle が reload 後も保持される', async ({ authedPage }) => {
    await authedPage.goto('/settings');

    await authedPage.waitForResponse(
      (res) => res.url().includes('/api/notification-preferences') && res.request().method() === 'GET',
      { timeout: 10_000 },
    );

    // 自動解析スイッチを特定: 「自動解析」テキストの近くにある button
    const autoSwitch = authedPage
      .locator('div')
      .filter({ hasText: /^自動解析$/ })
      .locator('xpath=ancestor::div[contains(@class,"flex items-center justify-between")]')
      .locator('button')
      .first();

    const isChecked = async () => {
      const cls = await autoSwitch.getAttribute('class');
      return cls?.includes('bg-[#FF8A65]') ?? false;
    };

    const initialState = await isChecked();

    const patchPromise = authedPage.waitForResponse(
      (res) => res.url().includes('/api/notification-preferences') && res.request().method() === 'PATCH',
      { timeout: 10_000 },
    );
    await autoSwitch.click();
    const patchRes = await patchPromise;
    expect(patchRes.status()).toBe(200);

    await authedPage.reload();
    await authedPage.waitForResponse(
      (res) => res.url().includes('/api/notification-preferences') && res.request().method() === 'GET',
      { timeout: 10_000 },
    );

    const afterReloadState = await isChecked();
    expect(afterReloadState).toBe(!initialState);
  });
});
