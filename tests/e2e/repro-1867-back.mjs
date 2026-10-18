// 一時的な再現用 (#1867 戻る)。本番を読むだけ。原因の特定が済んだら消す。
import { chromium, webkit } from '@playwright/test';

const BASE = process.env.REPRO_BASE_URL ?? 'https://homegohan-app.vercel.app';

async function run(browserType, name) {
  const browser = await browserType.launch(process.env.REPRO_BFCACHE === '1' && name === 'chromium' ? { ignoreDefaultArgs: ['--disable-back-forward-cache'] } : {});
  const page = await browser.newPage();
  const log = (...a) => console.log(`[${name}]`, ...a);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  log('initial state', JSON.stringify(await page.evaluate(() => ({ na: history.state?.__NA ?? null, len: history.length }))));
  // ヘッダーの「使い方」(#how) を押す
  await page.locator('header nav a[href="#how"]').click();
  await page.waitForTimeout(800);
  log('after #how', page.url(), JSON.stringify(await page.evaluate(() => ({ state: history.state === null ? null : Object.keys(history.state), na: history.state?.__NA ?? null, len: history.length }))));
  // ヘッダーの「無料で始める」(/signup) を押す
  await page.locator('header a[href="/signup"]').first().click();
  await page.waitForURL('**/signup', { timeout: 20000 });
  await page.waitForTimeout(1000);
  log('at signup', page.url(), 'lp?', await page.locator('.lp').count());
  await page.goBack();
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => ({
    href: location.href,
    lp: document.querySelectorAll('.lp').length,
    how: !!document.getElementById('how'),
    signupForm: document.querySelectorAll('input[type=password]').length,
    scrollY: window.scrollY,
  }));
  log('after back', JSON.stringify(info));
  // 対照: ハッシュを経ずに / → /signup → 戻る
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.locator('header a[href="/signup"]').first().click();
  await page.waitForURL('**/signup', { timeout: 20000 });
  await page.goBack();
  await page.waitForTimeout(3000);
  log('control (no hash) after back', JSON.stringify(await page.evaluate(() => ({ href: location.href, lp: document.querySelectorAll('.lp').length }))));
  // 文書の遷移 (アドレス欄で /signup) → 戻る (bfcache の有無で比べる)
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.locator('header nav a[href="#how"]').click();
  await page.waitForTimeout(500);
  await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
  await page.goBack();
  await page.waitForTimeout(2000);
  log('document nav after back', JSON.stringify(await page.evaluate(() => ({ href: location.href, lp: document.querySelectorAll('.lp').length, na: history.state?.__NA ?? null, persisted: performance.getEntriesByType('navigation')[0]?.type }))));
  await browser.close();
}

await run(chromium, 'chromium');
try {
  await run(webkit, 'webkit');
} catch (e) {
  console.log('[webkit] skipped:', String(e).slice(0, 200));
}
