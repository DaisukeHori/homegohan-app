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
    await authedPage.waitForLoadState('domcontentloaded');

    // API レスポンスを待機してから確認するため、GET リクエストを追跡
    await authedPage.waitForResponse(
      (res) =>
        res.url().includes('/api/notification-preferences') &&
        res.request().method() === 'GET' &&
        res.status() === 200,
      { timeout: 30_000 },
    );

    // 「通知」テキストを含む行コンテナ (flex items-center justify-between) 内の button (Switch)
    const notifRow = authedPage.locator('div.flex.items-center.justify-between', {
      has: authedPage.locator('span', { hasText: '通知' }),
    }).first();
    const notifSwitch = notifRow.locator('button').first();

    // 現在の状態を確認
    const isCheckedClass = async () => {
      const cls = await notifSwitch.getAttribute('class');
      return cls?.includes('bg-[#FF8A65]') ?? false;
    };

    const initialState = await isCheckedClass();

    // toggle を反転
    const patchPromise = authedPage.waitForResponse(
      (res) =>
        res.url().includes('/api/notification-preferences') &&
        res.request().method() === 'PATCH' &&
        res.status() === 200,
      { timeout: 30_000 },
    );
    await notifSwitch.click();
    const patchRes = await patchPromise;
    expect(patchRes.status()).toBe(200);

    // リロード後も状態が保持されている
    await Promise.all([
      authedPage.waitForResponse(
        (res) =>
          res.url().includes('/api/notification-preferences') &&
          res.request().method() === 'GET' &&
          res.status() === 200,
        { timeout: 30_000 },
      ),
      authedPage.reload(),
    ]);
    await authedPage.waitForLoadState('domcontentloaded');

    // GET レスポンス後に React の state 更新が DOM に反映されるのを待つ
    // (notifSwitch は reload 後に再解決される locator)
    if (!initialState) {
      await expect(notifSwitch).toHaveClass(/bg-\[#FF8A65\]/, { timeout: 10_000 });
    } else {
      await expect(notifSwitch).not.toHaveClass(/bg-\[#FF8A65\]/, { timeout: 10_000 });
    }

    const afterReloadState = await isCheckedClass();
    expect(afterReloadState).toBe(!initialState);

    // もう一度 toggle して元に戻す
    const patchPromise2 = authedPage.waitForResponse(
      (res) =>
        res.url().includes('/api/notification-preferences') &&
        res.request().method() === 'PATCH' &&
        res.status() === 200,
      { timeout: 30_000 },
    );
    await notifSwitch.click();
    await patchPromise2;

    await Promise.all([
      authedPage.waitForResponse(
        (res) =>
          res.url().includes('/api/notification-preferences') &&
          res.request().method() === 'GET' &&
          res.status() === 200,
        { timeout: 30_000 },
      ),
      authedPage.reload(),
    ]);
    await authedPage.waitForLoadState('domcontentloaded');
    // GET レスポンス後に React の state 更新が DOM に反映されるのを待つ
    if (initialState) {
      await expect(notifSwitch).toHaveClass(/bg-\[#FF8A65\]/, { timeout: 10_000 });
    } else {
      await expect(notifSwitch).not.toHaveClass(/bg-\[#FF8A65\]/, { timeout: 10_000 });
    }
    const restoredState = await isCheckedClass();
    expect(restoredState).toBe(initialState);
  });

  test('自動解析 toggle が reload 後も保持される', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    await authedPage.waitForLoadState('domcontentloaded');

    await authedPage.waitForResponse(
      (res) =>
        res.url().includes('/api/notification-preferences') &&
        res.request().method() === 'GET' &&
        res.status() === 200,
      { timeout: 30_000 },
    );

    // 自動解析スイッチを特定: 「自動解析」span を含む行コンテナ内の button (Switch)
    const autoSwitch = authedPage.locator('div.flex.items-center.justify-between', {
      has: authedPage.locator('span', { hasText: '自動解析' }),
    }).first().locator('button').first();

    const isChecked = async () => {
      const cls = await autoSwitch.getAttribute('class');
      return cls?.includes('bg-[#FF8A65]') ?? false;
    };

    const initialState = await isChecked();

    const patchPromise = authedPage.waitForResponse(
      (res) =>
        res.url().includes('/api/notification-preferences') &&
        res.request().method() === 'PATCH' &&
        res.status() === 200,
      { timeout: 30_000 },
    );
    await autoSwitch.click();
    const patchRes = await patchPromise;
    expect(patchRes.status()).toBe(200);

    await Promise.all([
      authedPage.waitForResponse(
        (res) =>
          res.url().includes('/api/notification-preferences') &&
          res.request().method() === 'GET' &&
          res.status() === 200,
        { timeout: 30_000 },
      ),
      authedPage.reload(),
    ]);
    await authedPage.waitForLoadState('domcontentloaded');

    const afterReloadState = await isChecked();
    expect(afterReloadState).toBe(!initialState);
  });
});
