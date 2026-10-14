import { expect, type Page } from "@playwright/test";

/**
 * サインアップ画面 (/signup) の「利用規約・プライバシーポリシーに同意します」のチェックを入れる (#1174)。
 *
 * 以前は画面の下に「続行することで同意したものとみなされます」と書いてあるだけだったが、必須のチェックボックスになり、
 * チェックするまで Google 登録も「登録して始める」も押せない。サインアップ画面で登録ボタンを押す spec は、
 * 押す前にこれを呼ぶ。
 *
 * ハイドレーション (React が画面を引き継ぐ) の前にチェックしても、引き継ぎで未チェックに戻って
 * ボタンが押せないままになることがある。引き継ぎを待ってからチェックし、それでも戻ったときのために、
 * 「登録して始める」が押せる状態になるまでチェックをやり直す。
 */
export async function acceptSignupLegalConsent(page: Page): Promise<void> {
  const checkbox = page.locator("#agree-legal");
  await checkbox.waitFor({ state: "visible", timeout: 20_000 });
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector("#agree-legal");
        return !!el && Object.keys(el).some((key) => key.startsWith("__reactProps") || key.startsWith("__reactFiber"));
      },
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => {
      // 引き継ぎの検出に失敗しても続行する (下の確認が、押せる状態になるまでやり直す)
    });
  const submit = page.locator('form button[type="submit"]');
  await expect(async () => {
    await checkbox.check({ timeout: 5_000 });
    await expect(submit).toBeEnabled({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
}
