/**
 * billing/01 §14.3 テスト 71 (#1701 段 C): Stripe のテストモードで pro の月額を買い、/account/billing に試用中 (trialing) が出る。
 *
 * Stripe のテストモード (STRIPE_SECRET_KEY が sk_test_・Price を登録済み・Webhook の転送) が要るので CI では流さない (tests/e2e/.manual/)。
 * 手動の full suite (npx playwright test) からは外れないので、E2E_STRIPE_TEST_MODE=1 を付けたときだけ動かす
 * (auth-turnstile.spec.ts の、前提が無ければ全部スキップする形と同じ)。
 * ログインは共通の authedPage (fixtures/auth.ts) を使う。テスト用の利用者は、まだ有料プランを契約していない者にする
 * (契約中なら確認画面が「すでに有効な契約があります」で申し込めない)。
 *
 * 受け入れの確認の全体 (DB の行・監査・退会・凍結) は設計書 §17.4 の手順で行う。この spec は購入の画面の流れだけを見る。
 */
import { test, expect } from "../fixtures/auth";

/** Stripe のテストモードで動かすときだけ付ける */
const STRIPE_TEST_MODE = process.env.E2E_STRIPE_TEST_MODE === "1";

/** Stripe が公開しているテスト用のカード (常に成功する)。https://docs.stripe.com/testing */
const STRIPE_TEST_CARD_NUMBER = "4242 4242 4242 4242";
/** テスト用のカードの有効期限 (未来の任意の月) と CVC (任意の 3 桁) */
const STRIPE_TEST_CARD_EXPIRY = "12 / 34";
const STRIPE_TEST_CARD_CVC = "123";
const STRIPE_TEST_CARDHOLDER = "TEST USER";

/** Stripe Checkout の画面の読み込みと、決済のあとの戻りを待つ時間 (外部の画面なので長めに取る) */
const STRIPE_PAGE_TIMEOUT_MS = 60_000;
/** /account/billing が契約を写すまで待つ時間 (画面は 3 秒 × 10 回まで読み直す。billing/01 §10.3) */
const BILLING_SYNC_TIMEOUT_MS = 45_000;

test.skip(
  !STRIPE_TEST_MODE,
  "Stripe のテストモードで起動したアプリ向けの spec。E2E_STRIPE_TEST_MODE=1 を付けて実行する (billing/01 §14.3・§17.4)",
);

test.describe("billing/01 §14.3 購入の流れ (Stripe のテストモード)", () => {
  test("E2E: buy pro monthly with test card 4242, land on /account/billing, see trialing", async ({ authedPage: page }) => {
    test.setTimeout(STRIPE_PAGE_TIMEOUT_MS * 3);

    // /pricing の pro のカードの「月額で始める」→ 確認画面
    await page.goto("/pricing");
    await page.locator('a[href="/account/billing/checkout?plan_key=pro&interval=month"]').click();
    await expect(page).toHaveURL(/\/account\/billing\/checkout\?plan_key=pro&interval=month/);

    // 特定商取引法の確認: チェックを入れるまで「申し込む」は押せない
    const submit = page.getByRole("button", { name: "申し込む" });
    await expect(page.getByText("お申し込み内容の確認")).toBeVisible();
    await expect(submit).toBeDisabled();
    await page.getByLabel("上記内容を確認しました").check();
    await expect(submit).toBeEnabled();
    await submit.click();

    // Stripe Checkout (テストモード) でテスト用のカードを入れて支払う
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: STRIPE_PAGE_TIMEOUT_MS });
    await page.locator("#cardNumber").fill(STRIPE_TEST_CARD_NUMBER);
    await page.locator("#cardExpiry").fill(STRIPE_TEST_CARD_EXPIRY);
    await page.locator("#cardCvc").fill(STRIPE_TEST_CARD_CVC);
    const cardholder = page.locator("#billingName");
    if (await cardholder.isVisible()) await cardholder.fill(STRIPE_TEST_CARDHOLDER);
    await page.locator('button[type="submit"]').click();

    // 戻り画面: 同期のあと、試用中 (trialing) の文が出る
    await page.waitForURL(/\/account\/billing\?checkout=success&session_id=cs_test_/, { timeout: STRIPE_PAGE_TIMEOUT_MS });
    await expect(page.getByText(/^無料期間中/)).toBeVisible({ timeout: BILLING_SYNC_TIMEOUT_MS });
    await expect(page.getByRole("button", { name: "解約する" })).toBeVisible();
  });
});
