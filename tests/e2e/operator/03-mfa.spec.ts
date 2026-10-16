/**
 * tests/e2e/operator/03-mfa.spec.ts
 *
 * #1176 運営ロールの MFA (二段階認証) の画面 (docs/design/cross/12-operator-mfa.md §21.5。段 B)
 *
 *   T-MFA-1: 未登録の admin ({ assurance: 'aal1' }) は /admin で setup へ回され、登録すると /admin に着く
 *   T-MFA-2: 登録済み admin の新しいセッションは verify へ回され、6 桁で /admin に着く
 *   T-MFA-3: 画面から登録して受け取ったバックアップコードで、新しいセッションの verify 画面から回復すると /login へ戻り、再ログイン後に setup へ回される
 *   T-MFA-4: 登録済み admin の新しいセッションで /support を開くと verify へ回され、6 桁で /support に着く。support だけのユーザーは verify を経ずに /support が開く
 *   T-MFA-5: verify 画面を開いたまま Cookie を消して 6 桁を送ると、/login に着き、next が /settings/security/mfa/verify を指す (S-19)
 *
 * 利用者は createRoleUser (persona-api.ts) で作り、openUserContext で別のブラウザのコンテキストを開く。MFA の画面そのものを試すので、
 * 最初のセッションは { assurance: 'aal1' } で入れる (injectSession の自動の昇格をさせない §22.4.3)。
 * 6 桁は tests/e2e/helpers/totp.mjs の generateTotp。1 回目が「確認コードが正しくありません」なら、次の窓の 6 桁で 1 回だけ打ち直す。
 * アプリの WebView (S-26〜S-28) は Playwright のブラウザでは再現できない (§21.5。単体テストが守る)。
 *
 * 実行:
 *   npx playwright test tests/e2e/operator/03-mfa.spec.ts
 */

import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures/fresh-user";
import { generateTotp, TOTP_STEP_SECONDS } from "../helpers/totp.mjs";
import { EMPTY_STORAGE_STATE, apiRequest, createRoleUser, deleteRoleUser, openUserContext } from "../helpers/persona-api";

// 共有のログイン状態 (playwright.config.ts の storageState) を引き継がず、各テストが自分のユーザーで入る
test.use({ storageState: EMPTY_STORAGE_STATE });

/** 画面の要素が出るまで待つ上限 (ほかの spec と同じ。本番ビルドの初回の描画を含めて足りる長さ) */
const PAGE_READY_TIMEOUT_MS = 20_000;
/** 1 秒のミリ秒 */
const MILLISECONDS_PER_SECOND = 1000;
/** 1 回目の 6 桁の送信の後、不一致の文が出るかを待つ時間 (ms。応答は数百 ms で返る。出なければ一致とみなして進む) */
const MISMATCH_WAIT_MS = 2_000;
/** 6 桁の不一致の文 (src/lib/auth/mfa/client.ts の mfaErrorMessage('AUTH_2FA_INVALID')) */
const INVALID_CODE_MESSAGE = "確認コードが正しくありません";

const VERIFY_PATH = "/settings/security/mfa/verify";
const SETUP_PATH = "/settings/security/mfa/setup";

/** 6 桁を入れて送る。1 回目が不一致なら、次の窓の 6 桁で 1 回だけ打ち直す (時計のずれ) */
async function submitTotp(page: Page, secret: string): Promise<void> {
  const input = page.getByTestId("totp-code-input");
  await expect(input).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
  const now = Date.now() / MILLISECONDS_PER_SECOND;
  await input.fill(generateTotp(secret, now));
  await page.getByTestId("totp-code-submit").click();
  const error = page.getByTestId("totp-code-error");
  const mismatch = await error
    .filter({ hasText: INVALID_CODE_MESSAGE })
    .waitFor({ timeout: MISMATCH_WAIT_MS })
    .then(() => true)
    .catch(() => false);
  if (mismatch) {
    await input.fill(generateTotp(secret, now + TOTP_STEP_SECONDS));
    await page.getByTestId("totp-code-submit").click();
  }
}

/** setup の画面で登録する: secret を読み、6 桁を送り、表示されたバックアップコードを返して [続ける] を押す */
async function enrollOnSetupPage(page: Page): Promise<{ secret: string; backupCodes: string[] }> {
  const secretInput = page.getByTestId("mfa-setup-secret");
  await expect(secretInput).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
  const secret = await secretInput.inputValue();
  expect(secret.length).toBeGreaterThan(0);
  await submitTotp(page, secret);
  const list = page.getByTestId("backup-codes-list");
  await expect(list).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
  const backupCodes = (await list.locator("li").allTextContents()).map((text) => text.trim()).filter(Boolean);
  await page.getByTestId("backup-codes-saved").check();
  await page.getByTestId("backup-codes-done").click();
  return { secret, backupCodes };
}

test.describe("運営の MFA の画面 (#1176)", () => {
  const createdUserIds: string[] = [];
  const contexts: BrowserContext[] = [];

  test.afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close().catch(() => {});
    for (const id of createdUserIds.splice(0)) await deleteRoleUser(id).catch(() => {});
  });

  async function newAdmin(label: string, roles: string[] = ["admin"]) {
    const user = await createRoleUser({ emailPrefix: `mfa-${label}`, nickname: `MFA ${label}`, roles });
    createdUserIds.push(user.id);
    return user;
  }

  test("T-MFA-1: 未登録の admin ({ assurance: 'aal1' }) は /admin で setup へ回され、登録すると /admin に着く (QR の代わりに画面の secret を読み、totp.mjs で 6 桁)", async ({ browser }) => {
    const admin = await newAdmin("t1");
    const { context, page } = await openUserContext(browser, admin.email, { assurance: "aal1" });
    contexts.push(context);
    // 登録の前: 自己サービスの状態は aal1 でも読める ({ assurance: 'session' }) が、未登録
    const before = await apiRequest(page, "/api/auth/mfa/status");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enrolled: false, aal: "aal1" });

    await page.goto("/admin");
    await page.waitForURL((url) => url.pathname === SETUP_PATH, { timeout: PAGE_READY_TIMEOUT_MS });
    expect(new URL(page.url()).searchParams.get("next")).toBe("/admin");

    const { backupCodes } = await enrollOnSetupPage(page);
    expect(backupCodes.length).toBeGreaterThan(0);
    await page.waitForURL((url) => url.pathname === "/admin", { timeout: PAGE_READY_TIMEOUT_MS });
    const after = await apiRequest(page, "/api/auth/mfa/status");
    expect(after.body).toMatchObject({ enrolled: true, aal: "aal2", backup_codes_remaining: backupCodes.length });
  });

  test("T-MFA-2: 登録済み admin の新しいセッションは verify へ回され、6 桁で /admin に着く (1 つ目は openUserContext の自動の昇格で登録し、返った session.totpSecret を使う。2 つ目を { assurance: 'aal1' } で開く)", async ({ browser }) => {
    const admin = await newAdmin("t2");
    const first = await openUserContext(browser, admin.email);
    contexts.push(first.context);
    expect(first.session.aal).toBe("aal2");
    const secret = first.session.totpSecret;
    expect(secret).not.toBeNull();

    const second = await openUserContext(browser, admin.email, { assurance: "aal1" });
    contexts.push(second.context);
    // aal1 のセッションで運営の API を直接呼ぶと 403 (S-3。code は route の既存のもの §19.3)
    const denied = await apiRequest(second.page, "/api/admin/users");
    expect(denied.status).toBe(403);
    await second.page.goto("/admin");
    await second.page.waitForURL((url) => url.pathname === VERIFY_PATH, { timeout: PAGE_READY_TIMEOUT_MS });
    await submitTotp(second.page, secret!);
    await second.page.waitForURL((url) => url.pathname === "/admin", { timeout: PAGE_READY_TIMEOUT_MS });
    const allowed = await apiRequest(second.page, "/api/admin/users");
    expect(allowed.status).toBe(200);
  });

  test("T-MFA-3: T-MFA-1 の手順で画面から登録して受け取ったバックアップコードで、新しいセッション ({ assurance: 'aal1' }) の verify 画面から回復すると /login へ戻り、再ログイン後に setup へ回される", async ({ browser }) => {
    const admin = await newAdmin("t3");
    const first = await openUserContext(browser, admin.email, { assurance: "aal1" });
    contexts.push(first.context);
    await first.page.goto("/admin");
    await first.page.waitForURL((url) => url.pathname === SETUP_PATH, { timeout: PAGE_READY_TIMEOUT_MS });
    const { backupCodes } = await enrollOnSetupPage(first.page);
    expect(backupCodes.length).toBeGreaterThan(0);

    const second = await openUserContext(browser, admin.email, { assurance: "aal1" });
    contexts.push(second.context);
    await second.page.goto("/admin");
    await second.page.waitForURL((url) => url.pathname === VERIFY_PATH, { timeout: PAGE_READY_TIMEOUT_MS });
    await second.page.getByTestId("mfa-verify-recover-link").click();
    await second.page.getByTestId("mfa-recover-code-input").fill(backupCodes[0]);
    await second.page.getByTestId("mfa-recover-submit").click();
    await second.page.waitForURL((url) => url.pathname === "/login", { timeout: PAGE_READY_TIMEOUT_MS });

    // 再ログイン (factor は消えている = 未登録) → 運営の画面は setup へ回る
    const third = await openUserContext(browser, admin.email, { assurance: "aal1" });
    contexts.push(third.context);
    await third.page.goto("/admin");
    await third.page.waitForURL((url) => url.pathname === SETUP_PATH, { timeout: PAGE_READY_TIMEOUT_MS });
  });

  test("T-MFA-4: 登録済み admin の新しいセッション ({ assurance: 'aal1' }) で /support を開くと verify へ回され、6 桁で /support に着く。support だけのユーザーは verify を経ずに /support が開く", async ({ browser }) => {
    const admin = await newAdmin("t4");
    const first = await openUserContext(browser, admin.email);
    contexts.push(first.context);
    const secret = first.session.totpSecret;
    expect(secret).not.toBeNull();

    const second = await openUserContext(browser, admin.email, { assurance: "aal1" });
    contexts.push(second.context);
    await second.page.goto("/support");
    await second.page.waitForURL((url) => url.pathname === VERIFY_PATH, { timeout: PAGE_READY_TIMEOUT_MS });
    expect(new URL(second.page.url()).searchParams.get("next")).toBe("/support");
    await submitTotp(second.page, secret!);
    await second.page.waitForURL((url) => url.pathname === "/support", { timeout: PAGE_READY_TIMEOUT_MS });

    const support = await newAdmin("t4-support", ["support"]);
    const supportContext = await openUserContext(browser, support.email);
    contexts.push(supportContext.context);
    expect(supportContext.session.aal).toBe("aal1");
    await supportContext.page.goto("/support");
    await supportContext.page.waitForLoadState("domcontentloaded");
    expect(new URL(supportContext.page.url()).pathname).toBe("/support");
  });

  test("T-MFA-5: verify 画面を開いたまま Cookie を消して (context.clearCookies) 6 桁を送ると、/login に着き、next が /settings/security/mfa/verify を指す (S-19)", async ({ browser }) => {
    const admin = await newAdmin("t5");
    const first = await openUserContext(browser, admin.email);
    contexts.push(first.context);
    const secret = first.session.totpSecret;
    expect(secret).not.toBeNull();

    const second = await openUserContext(browser, admin.email, { assurance: "aal1" });
    contexts.push(second.context);
    await second.page.goto("/admin");
    await second.page.waitForURL((url) => url.pathname === VERIFY_PATH, { timeout: PAGE_READY_TIMEOUT_MS });
    await expect(second.page.getByTestId("totp-code-input")).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
    await second.context.clearCookies();
    await second.page.getByTestId("totp-code-input").fill(generateTotp(secret!));
    await second.page.getByTestId("totp-code-submit").click();
    await second.page.waitForURL((url) => url.pathname === "/login", { timeout: PAGE_READY_TIMEOUT_MS });
    expect(new URL(second.page.url()).searchParams.get("next") ?? "").toContain(VERIFY_PATH);
  });
});
