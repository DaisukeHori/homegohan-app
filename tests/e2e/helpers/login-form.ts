/**
 * tests/e2e/helpers/login-form.ts (#1165)
 *
 * ログイン画面のフォームが「送信できる状態」になるまで待つ。
 *
 * ログイン・新規登録・パスワード再設定の画面には、サイトキー (NEXT_PUBLIC_TURNSTILE_SITE_KEY) 付きでビルドしたアプリでは
 * Cloudflare Turnstile のウィジェット (iframe) が常に出る。ウィジェットは Cloudflare と通信し続けるので、
 * これらの画面では page.waitForLoadState("networkidle") が成り立たず、テストの時間切れまで待ち続ける
 * (CI と local-ci の e2e は Cloudflare のテスト用サイトキーでビルドする。.github/workflows/e2e-local.yml)。
 * そのため、これらの画面では networkidle を待たず、この関数で「フォームが出て、(ウィジェットがあれば) トークンが出て、
 * 送信ボタンが押せる」ことを待つ。src/__tests__/config/e2e-auth-page-wait.test.ts が、networkidle を待っていないことを検査する。
 *
 * サイトキー無しでビルドしたアプリ (Turnstile は無効。ウィジェットは出ない) では、フォームが出て送信ボタンが押せることだけを待つ。
 */
import { expect, type Page } from "@playwright/test";

/**
 * フォームが出て、本物のウィジェットがトークンを出し、送信ボタンが押せるまで待つ時間。
 * Cloudflare への通信を含むので、tests/e2e/auth-turnstile.spec.ts の WIDGET_READY_TIMEOUT_MS と同じ長さにする。
 */
export const LOGIN_FORM_READY_TIMEOUT_MS = 30_000;

/** Turnstile のウィジェットの外枠 (src/components/auth/TurnstileWidget.tsx の data-testid) */
const TURNSTILE_TEST_ID = "turnstile";
/** ウィジェットがトークンを出した状態 (TurnstileWidget.tsx の data-turnstile-status) */
const TURNSTILE_READY_STATUS = "ready";

export interface WaitForLoginFormReadyOptions {
  /**
   * true なら、ウィジェットが無いことを許さない (サイトキーが渡っていないのに、ウィジェット無しで緑になるのを防ぐ)。
   * CI と local-ci の e2e (E2E_REQUIRE_TURNSTILE=1) で使う。
   */
  requireTurnstile?: boolean;
}

/**
 * ログイン画面 (/login) を開いたあとに呼ぶ。networkidle は待たない (ファイル先頭の説明)。
 * 1. ページの load を待つ
 * 2. メールアドレスの入力欄が出るのを待つ (ログイン画面は useSearchParams を Suspense で包むので、フォームはブラウザ側で描かれる)
 * 3. ウィジェットがあれば、トークンを出す (data-turnstile-status="ready") のを待つ
 * 4. 送信ボタンが押せる (disabled でない) のを待つ。Turnstile が有効な間は、トークンが出るまで押せない
 */
export async function waitForLoginFormReady(page: Page, options: WaitForLoginFormReadyOptions = {}): Promise<void> {
  const timeout = LOGIN_FORM_READY_TIMEOUT_MS;
  await page.waitForLoadState("load");
  await expect(page.locator("#email")).toBeVisible({ timeout });

  const widget = page.getByTestId(TURNSTILE_TEST_ID);
  if (options.requireTurnstile) {
    await expect(widget, "Turnstile のウィジェットが出ていない (サイトキー付きでビルドされていない)").toBeAttached({
      timeout,
    });
  }
  // ウィジェットはフォームと同じ描画で入る (サイトキーはビルド時に埋め込まれる)。入力欄が出た後に数えれば足りる。
  // 数え損ねても、下の「送信ボタンが押せる」がトークンが出るまで成り立たないので、トークンより先に送ることはない
  if ((await widget.count()) > 0) {
    await expect(widget).toHaveAttribute("data-turnstile-status", TURNSTILE_READY_STATUS, { timeout });
  }

  await expect(page.locator("button[type=submit]")).toBeEnabled({ timeout });
}
