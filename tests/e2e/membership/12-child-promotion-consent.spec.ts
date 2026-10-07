/**
 * tests/e2e/membership/12-child-promotion-consent.spec.ts
 *
 * #1232: 子供メンバーの昇格 (家族グループへの参加) は、本人の同意を得てから行う。
 *
 * 旧フローは、代表者がメールアドレスを入れた時点で、その持ち主の既存アカウントを
 * 本人に無断で家族へ編入していた。現在の流れは次のとおり。
 *
 *   代表者 / 大人  POST /api/family/members/{member_id}/promote {email}
 *     → family_promotion_requests に pending の行ができ、本人宛にメールが飛ぶ。
 *       この時点で family_members.user_id は NULL のまま。token は HTTP レスポンスに載らない。
 *   本人           /family/promotions/{token} の同意カードで共有範囲を選び、承認 (accept) か拒否 (reject)
 *   代表者 / 大人  DELETE 同 URL で、pending の間は取り消せる (revoke)
 *
 * テスト戦略:
 *   - テストごとに fresh family + 子供メンバーを作り、互いに独立させる。
 *   - メールは送られない (RESEND_API_KEY 未設定) ので、本人が受け取る token は service_role で
 *     family_promotion_requests から読む (authenticated ロールには token 列の SELECT を許していない)。
 *   - 役割ごとに別の BrowserContext で画面を開く (代表者 = fixture の page、本人 / 第三者 = 新規 context)。
 *   - 作った user は finally で必ず削除する。
 *
 * 設計: Issue #1232 / supabase/migrations/20261007112100_child_promotion_consent_rpcs.sql
 */

import { randomBytes } from "crypto";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { test, type FamilyInfo } from "../fixtures/fresh-family";
import { createFreshUser, cleanupFreshUser, injectSession } from "../fixtures/fresh-user";
import {
  addChild,
  apiFetch,
  expirePromotionRequestInDB,
  getFamilyMemberFromDB,
  getPendingPromotionRequest,
  getPromotionRequestsFromDB,
  getUserFamilyIdFromDB,
  gotoWithoutClientErrors,
  upsertUserProfileDirect,
} from "../helpers/membership-family";
import { getAdminClient } from "../helpers/membership-paste";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

/** dev サーバの初回コンパイルを待てるよう、画面を開いた直後の可視性アサーションだけ長めにする */
const NAVIGATION_TIMEOUT = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/** メールとして妥当だが、アカウントは存在しない宛先 (子供本人がまだ登録していないケース) */
function randomEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@homegohan.test`;
}

/** 形式だけ正しい (64 桁 hex) が、DB に存在しない token */
function randomToken(): string {
  return randomBytes(32).toString("hex");
}

/** playwright.config.ts の共有ログイン状態 (storageState) を引き継がない、まっさらな context */
async function newIsolatedContext(browser: Browser) {
  return browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
}

/** 未ログインの page で fn を実行する */
async function withAnonymousPage(browser: Browser, fn: (page: Page) => Promise<void>): Promise<void> {
  const context = await newIsolatedContext(browser);
  try {
    await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

/** user としてログインした page で fn を実行する */
async function withSessionPage(
  browser: Browser,
  user: { email: string; password: string },
  fn: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await newIsolatedContext(browser);
  try {
    const page = await context.newPage();
    await injectSession(page, user.email, user.password);
    await fn(page);
  } finally {
    await context.close();
  }
}

/**
 * テスト後の後始末: このテストで作った user を削除する。
 * family と owner は freshFamilyWithOwner fixture が片付ける。
 * 承認で家族に参加済みの user を先に消しても、family_members の行ごと消えるので問題ない。
 */
async function cleanupUsers(
  admin: ReturnType<typeof getAdminClient>,
  userIds: string[],
): Promise<void> {
  for (const userId of userIds) {
    await cleanupFreshUser(admin, userId);
  }
}

/** 子供メンバー (user_id = NULL, role = child) を作って member_id を返す */
async function createChild(family: FamilyInfo): Promise<string> {
  return addChild({
    familyId: family.familyId,
    ownerUserId: family.owner.userId,
    name: "同意テスト子供",
    age: 15,
  });
}

/** 代表者として昇格リクエストを作り (API)、メールの代わりに DB から token を読んで返す */
async function requestPromotion(ownerPage: Page, memberId: string, email: string): Promise<string> {
  const result = await apiFetch(ownerPage, `/api/family/members/${memberId}/promote`, {
    method: "POST",
    body: { email },
  });
  expect(result.status, `promote API: ${JSON.stringify(result.body)}`).toBe(200);

  const request = await getPendingPromotionRequest(memberId);
  expect(request.token).toMatch(/^[a-f0-9]{64}$/);
  return request.token;
}

/** 本人向けの承認ページを開く */
async function openPromotionPage(page: Page, token: string): Promise<void> {
  await gotoWithoutClientErrors(page, `${BASE_URL}/family/promotions/${token}`);
}

/** 同意カードの見出し 「「{family}」への参加確認」 */
function consentHeading(page: Page, familyName: string): Locator {
  return page.getByRole("heading", { name: `「${familyName}」への参加確認` });
}

/** 共有設定の 3 つのチェックボックス */
function shareCheckboxes(page: Page) {
  return {
    meals: page.getByRole("checkbox", { name: /食事記録/ }),
    health: page.getByRole("checkbox", { name: /健康記録/ }),
    menu: page.getByRole("checkbox", { name: /週間献立/ }),
  };
}

/**
 * Tab を押しながら target にフォーカスが届くまで進める。
 * 画面の先頭に他のフォーカス要素があっても動くように、位置は決め打ちしない。
 */
async function tabUntilFocused(page: Page, target: Locator, maxTabs = 15): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab を ${maxTabs} 回押しても対象にフォーカスが届きませんでした`);
}

// ─────────────────────────────────────────────────────────────────────────────

// 動画は tests/e2e/.output (リポジトリ内) に書き出される。dev サーバはその書き込みのたびに再ビルドし、
// 再ビルド中に開いたページはチャンクが欠ける・途中までしか書かれていない状態になって、
// 無関係な例外 (ChunkLoadError / SyntaxError) で落ちる。失敗時のスクリーンショットは残す。
test.use({ video: "off" });

test.describe("子供メンバー昇格の本人同意フロー (#1232)", () => {
  // dev サーバでは、初回のページコンパイルに十数秒かかることがある
  test.describe.configure({ timeout: 120_000 });

  /**
   * spec12-01: 代表者が画面から参加リクエストを送る
   *
   * 送信画面 → 成功画面。旧「アカウントを発行しました」は出ない。
   * 送っただけでは何も変わらず (user_id = NULL)、token は HTTP レスポンスに載らない。
   */
  test("spec12-01: 代表者が画面から参加リクエストを送ると成功画面になり、メンバーは本人の承認まで変わらない", async ({
    freshFamilyWithOwner,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const memberId = await createChild(family);
    const targetEmail = randomEmail("e2e-promo-target");

    await gotoWithoutClientErrors(ownerPage, `${BASE_URL}/family/members/${memberId}/promote`);

    // 旧「アカウント発行」ではなく、参加リクエストの送信フォーム
    await expect(
      ownerPage.getByRole("heading", { level: 1, name: /の参加リクエスト/ }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    const emailInput = ownerPage.getByPlaceholder("子供本人のメールアドレス");
    const submit = ownerPage.getByRole("button", { name: "参加リクエストを送信" });
    await expect(submit).toBeDisabled();
    await emailInput.fill(targetEmail);
    await expect(submit).toBeEnabled();

    const [response] = await Promise.all([
      ownerPage.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/family/members/${memberId}/promote`) &&
          res.request().method() === "POST",
      ),
      submit.click(),
    ]);
    expect(response.status()).toBe(200);
    const responseText = await response.text();

    // 成功画面 (非同期フローの事実に合わせた文言)
    await expect(
      ownerPage.getByRole("heading", { name: "参加リクエストを送信しました" }),
    ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(ownerPage.locator("body")).toContainText(targetEmail);
    await expect(ownerPage.locator("body")).not.toContainText("アカウントを発行");

    // DB: pending の依頼がちょうど 1 件。token (64 桁 hex) は HTTP レスポンスに載っていない
    const requests = await getPromotionRequestsFromDB(memberId);
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("pending");
    expect(requests[0].email).toBe(targetEmail);
    expect(requests[0].token).toMatch(/^[a-f0-9]{64}$/);
    expect(responseText).not.toContain(requests[0].token);

    // 本人が承認するまで、メンバーは子供のまま
    const member = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
    expect(member).not.toBeNull();
    expect(member!.user_id).toBeNull();
    expect(member!.role).toBe("child");
    expect(member!.child_profile).not.toBeNull();
  });

  /**
   * spec12-02: 未ログインでも承認ページに着地できる
   *
   * メールのリンクを踏んだ本人は、まだログインしていないことが多い。
   * /login へ飛ばさず、内容を見せたうえで、ログイン / アカウント作成へ誘導する。
   */
  test("spec12-02: 未ログインでも承認ページに留まり、ログイン / アカウント作成へ誘導される", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const memberId = await createChild(family);
    const targetEmail = randomEmail("e2e-promo-anon");
    const token = await requestPromotion(ownerPage, memberId, targetEmail);

    await withAnonymousPage(browser, async (page) => {
      await openPromotionPage(page, token);

      await expect(
        page.getByRole("heading", { name: "家族グループ参加の確認" }),
      ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      // /login へリダイレクトされていない
      expect(new URL(page.url()).pathname).toBe(`/family/promotions/${token}`);

      await expect(page.getByRole("button", { name: "ログインする" })).toBeVisible();
      await expect(page.getByRole("button", { name: "アカウントを作成" })).toBeVisible();
      // 宛先のメールアドレスが分かる
      await expect(page.locator("body")).toContainText(targetEmail);
      // ログインするまで、承認操作は出ない
      await expect(page.getByRole("button", { name: "参加を承認する" })).toHaveCount(0);
      await expect(page.getByRole("checkbox")).toHaveCount(0);

      // 「ログインする」→ /login?redirect=/family/promotions/{token}&email=...
      await page.getByRole("button", { name: "ログインする" }).click();
      await page.waitForURL((url) => url.pathname === "/login", { timeout: NAVIGATION_TIMEOUT });
      const loginUrl = new URL(page.url());
      expect(loginUrl.searchParams.get("redirect")).toBe(`/family/promotions/${token}`);
      expect(loginUrl.searchParams.get("email")).toBe(targetEmail);
      await expect(page.locator("#email")).toHaveValue(targetEmail);

      // 「アカウントを作成」→ /signup?redirect=/family/promotions/{token}&email=...
      await openPromotionPage(page, token);
      await page.getByRole("button", { name: "アカウントを作成" }).click();
      await page.waitForURL((url) => url.pathname === "/signup", { timeout: NAVIGATION_TIMEOUT });
      const signupUrl = new URL(page.url());
      expect(signupUrl.searchParams.get("redirect")).toBe(`/family/promotions/${token}`);
      expect(signupUrl.searchParams.get("email")).toBe(targetEmail);
    });
  });

  /**
   * spec12-03: オンボーディング未完了の本人でも承認ページに着地できる
   *
   * サインアップ直後 (オンボーディング前) の本人が /onboarding へ差し戻されると、
   * 承認ページに戻れなくなる。承認ページはその差し戻しの対象外にしてある。
   */
  test("spec12-03: オンボーディング未完了の本人でも /onboarding へ飛ばされず、同意カードが出る", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const admin = getAdminClient();
    const memberId = await createChild(family);
    const recipient = await createFreshUser(admin, { emailPrefix: "e2e-promo-onboarding" });

    try {
      await upsertUserProfileDirect({
        userId: recipient.id,
        nickname: "E2E Onboarding Pending",
        onboarding: "pending",
      });
      const token = await requestPromotion(ownerPage, memberId, recipient.email);

      await withSessionPage(browser, recipient, async (page) => {
        // 前提の確認: 同じ user が通常の画面 (/home) を開くと、オンボーディングへ送られる
        const home = await page.request.get(`${BASE_URL}/home`, { maxRedirects: 0 });
        expect(home.status()).toBeGreaterThanOrEqual(300);
        expect(home.status()).toBeLessThan(400);
        expect(home.headers()["location"] ?? "").toContain("/onboarding/");

        await openPromotionPage(page, token);

        await expect(consentHeading(page, family.familyName)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        expect(new URL(page.url()).pathname).toBe(`/family/promotions/${token}`);
        await expect(page.getByRole("button", { name: "参加を承認する" })).toBeVisible();
      });
    } finally {
      await cleanupUsers(admin, [recipient.id]);
    }
  });

  /**
   * spec12-04: 本人がキーボードだけで共有範囲を選んで承認する (主フロー)
   *
   * 同意カード: 食事記録 ON / 健康記録 OFF / 週間献立 ON が初期値。
   * 健康記録を ON、週間献立を OFF に切り替えて承認すると、その値で家族に参加する。
   */
  test("spec12-04: 本人がキーボードだけで共有範囲を選んで承認すると、大人メンバーとして家族に参加する", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const admin = getAdminClient();
    const memberId = await createChild(family);
    const recipient = await createFreshUser(admin, { emailPrefix: "e2e-promo-accept" });

    try {
      await upsertUserProfileDirect({
        userId: recipient.id,
        nickname: "E2E Promoted Child",
        onboarding: "completed",
      });
      const token = await requestPromotion(ownerPage, memberId, recipient.email);

      // 依頼を出しただけでは、既存アカウントの本人は家族に入らない (旧実装はここで即時に編入していた)
      const beforeMember = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
      expect(beforeMember!.user_id).toBeNull();
      expect(await getUserFamilyIdFromDB(recipient.id)).toBeNull();

      await withSessionPage(browser, recipient, async (page) => {
        await openPromotionPage(page, token);

        await expect(consentHeading(page, family.familyName)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        const { meals, health, menu } = shareCheckboxes(page);
        const approve = page.getByRole("button", { name: "参加を承認する" });
        await expect(page.getByRole("checkbox")).toHaveCount(3);
        await expect(approve).toBeEnabled();

        // 初期値: 食事記録 ON / 健康記録 OFF / 週間献立 ON
        await expect(meals).toBeChecked();
        await expect(health).not.toBeChecked();
        await expect(menu).toBeChecked();

        // Tab: 食事記録 → 健康記録 → 週間献立 → 承認ボタン
        await tabUntilFocused(page, meals);
        await page.keyboard.press("Tab");
        await expect(health).toBeFocused();
        // Space で切り替え: 健康記録を ON にする
        await page.keyboard.press("Space");
        await expect(health).toBeChecked();

        await page.keyboard.press("Tab");
        await expect(menu).toBeFocused();
        // 週間献立を OFF にする
        await page.keyboard.press("Space");
        await expect(menu).not.toBeChecked();

        await page.keyboard.press("Tab");
        await expect(approve).toBeFocused();

        // 触っていない食事記録は ON のまま
        await expect(meals).toBeChecked();

        // Enter で承認
        const acceptResponse = page.waitForResponse(
          (res) =>
            res.url().endsWith(`/api/family/promotions/${token}/accept`) &&
            res.request().method() === "POST",
        );
        await page.keyboard.press("Enter");
        const accepted = await acceptResponse;
        expect(accepted.status()).toBe(200);
        // 返すのは {family_id, member_id, role} だけ (family_members の行をそのまま返さない)
        expect(((await accepted.json()) as { data: unknown }).data).toEqual({
          family_id: family.familyId,
          member_id: memberId,
          role: "adult",
        });

        await expect(
          page.getByRole("heading", { name: "家族グループに参加しました" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        await expect(page.locator("body")).toContainText(`「${family.familyName}」のメンバーになりました`);
      });

      // DB: 子供枠が本人のアカウントに紐付き、切り替えた共有設定が保存される
      const member = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
      expect(member).not.toBeNull();
      expect(member).toMatchObject({
        user_id: recipient.id,
        role: "adult",
        child_profile: null,
        status: "active",
        share_meals: true,
        share_health: true,
        share_menu: false,
      });
      expect(await getUserFamilyIdFromDB(recipient.id)).toBe(family.familyId);

      const [request] = await getPromotionRequestsFromDB(memberId);
      expect(request.status).toBe("accepted");
      expect(request.resolved_by).toBe(recipient.id);

      // 使い終わったリンクは使えない
      await withSessionPage(browser, recipient, async (page) => {
        await openPromotionPage(page, token);
        await expect(
          page.getByRole("heading", { name: "このリクエストは無効です" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        await expect(page.locator("body")).toContainText("承認済み");
        await expect(page.getByRole("button", { name: "参加を承認する" })).toHaveCount(0);
      });
    } finally {
      await cleanupUsers(admin, [recipient.id]);
    }
  });

  /**
   * spec12-05: 宛先と違うメールのユーザーは承認も拒否もできない
   *
   * 画面は「他の方宛て」を出して承認操作を隠す。画面を迂回して API を直接叩いても、
   * 本人確認はサーバー側 (呼び出し者自身のメールと宛先の照合) で行うので通らない。
   */
  test("spec12-05: 宛先と違うメールのユーザーには「他の方宛て」と出て、API からも承認・拒否できない", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const admin = getAdminClient();
    const memberId = await createChild(family);
    const third = await createFreshUser(admin, { emailPrefix: "e2e-promo-third" });

    try {
      await upsertUserProfileDirect({
        userId: third.id,
        nickname: "E2E Third Person",
        onboarding: "completed",
      });
      const intendedEmail = randomEmail("e2e-promo-intended");
      const token = await requestPromotion(ownerPage, memberId, intendedEmail);

      await withSessionPage(browser, third, async (page) => {
        await openPromotionPage(page, token);

        await expect(
          page.getByRole("heading", { name: "このリクエストは他の方宛てです" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        // 宛先と、いまログインしているアカウントが並んで出る
        await expect(page.locator("body")).toContainText(intendedEmail);
        await expect(page.locator("body")).toContainText(third.email);
        await expect(page.getByRole("button", { name: "ログアウトしてやり直す" })).toBeVisible();
        // 承認操作は出ない
        await expect(page.getByRole("button", { name: "参加を承認する" })).toHaveCount(0);
        await expect(page.getByRole("checkbox")).toHaveCount(0);

        // 画面を迂回して API を直接叩いても 403
        for (const action of ["accept", "reject"] as const) {
          const result = await apiFetch(page, `/api/family/promotions/${token}/${action}`, {
            method: "POST",
            body: action === "accept" ? { share_meals: true, share_health: true, share_menu: true } : undefined,
          });
          expect(result.status, `${action}: ${JSON.stringify(result.body)}`).toBe(403);
          expect((result.body as { error?: { code?: string } }).error?.code).toBe("PROMOTION_EMAIL_MISMATCH");
        }

        // 「ログアウトしてやり直す」→ ログイン画面 (承認ページへ戻る redirect 付き)
        await page.getByRole("button", { name: "ログアウトしてやり直す" }).click();
        await page.waitForURL((url) => url.pathname === "/login", { timeout: NAVIGATION_TIMEOUT });
        expect(new URL(page.url()).searchParams.get("redirect")).toBe(`/family/promotions/${token}`);
      });

      // 何も変わっていない
      const [request] = await getPromotionRequestsFromDB(memberId);
      expect(request.status).toBe("pending");
      const member = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
      expect(member!.user_id).toBeNull();
      expect(member!.role).toBe("child");
      expect(await getUserFamilyIdFromDB(third.id)).toBeNull();
    } finally {
      await cleanupUsers(admin, [third.id]);
    }
  });

  /**
   * spec12-06: 本人が拒否する
   *
   * 「拒否する」は確認ダイアログを挟む (誤タップで即確定しない)。
   * キャンセル / Escape で閉じても何も変わらず、ダイアログで確定して初めて拒否される。
   */
  test("spec12-06: 拒否は確認ダイアログを挟み、キャンセル・Escape では変わらず、確定すると拒否される", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const admin = getAdminClient();
    const memberId = await createChild(family);
    const recipient = await createFreshUser(admin, { emailPrefix: "e2e-promo-reject" });

    try {
      await upsertUserProfileDirect({
        userId: recipient.id,
        nickname: "E2E Rejecting Child",
        onboarding: "completed",
      });
      const token = await requestPromotion(ownerPage, memberId, recipient.email);

      await withSessionPage(browser, recipient, async (page) => {
        await openPromotionPage(page, token);
        await expect(consentHeading(page, family.familyName)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

        const dialog = page.getByRole("dialog");
        // ダイアログが閉じているときだけ呼ぶ (開くと「拒否する」ボタンが 2 つになるため)
        const openRejectDialog = async () => {
          await page.getByRole("button", { name: "拒否する" }).click();
          await expect(dialog).toBeVisible();
        };
        await expect(dialog).toHaveCount(0);

        // 「拒否する」→ ダイアログ。「キャンセル」で閉じる
        await openRejectDialog();
        await expect(dialog).toContainText(`「${family.familyName}」への参加を拒否します`);
        await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "拒否する" })).toBeVisible();
        await dialog.getByRole("button", { name: "キャンセル" }).click();
        await expect(dialog).toBeHidden();

        // もう一度開いて Escape で閉じる
        await openRejectDialog();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();

        // ここまでは何も変わっていない
        await expect(consentHeading(page, family.familyName)).toBeVisible();
        await expect(page.getByRole("button", { name: "参加を承認する" })).toBeVisible();
        const [stillPending] = await getPromotionRequestsFromDB(memberId);
        expect(stillPending.status).toBe("pending");

        // もう一度開いて、ダイアログで確定する
        await openRejectDialog();
        await dialog.getByRole("button", { name: "拒否する" }).click();
        await expect(
          page.getByRole("heading", { name: "参加リクエストを拒否しました" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      });

      // DB: 拒否済み。子供枠は子供のまま、本人は家族に入っていない
      const [request] = await getPromotionRequestsFromDB(memberId);
      expect(request.status).toBe("rejected");
      expect(request.resolved_by).toBe(recipient.id);
      const member = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
      expect(member!.user_id).toBeNull();
      expect(member!.role).toBe("child");
      expect(member!.child_profile).not.toBeNull();
      expect(await getUserFamilyIdFromDB(recipient.id)).toBeNull();

      // 拒否したリンクを開き直すと「無効」
      await withSessionPage(browser, recipient, async (page) => {
        await openPromotionPage(page, token);
        await expect(
          page.getByRole("heading", { name: "このリクエストは無効です" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        await expect(page.locator("body")).toContainText("拒否済み");
      });
    } finally {
      await cleanupUsers(admin, [recipient.id]);
    }
  });

  /**
   * spec12-07: 代表者が pending のリクエストを取り消す
   *
   * 取り消すと送信フォームに戻り、以前のリンクは「無効 (取り消し済み)」になる。
   * 取り消し済みの token では、API を直接叩いても承認できない。
   */
  test("spec12-07: 代表者がリクエストを取り消すと、送信フォームに戻り、以前のリンクは無効になる", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const admin = getAdminClient();
    const memberId = await createChild(family);
    const recipient = await createFreshUser(admin, { emailPrefix: "e2e-promo-revoke" });

    try {
      await upsertUserProfileDirect({
        userId: recipient.id,
        nickname: "E2E Revoked Child",
        onboarding: "completed",
      });
      const token = await requestPromotion(ownerPage, memberId, recipient.email);
      const pendingRequest = await getPendingPromotionRequest(memberId);

      await gotoWithoutClientErrors(ownerPage, `${BASE_URL}/family/members/${memberId}/promote`);

      // pending のリクエストがあるときは、管理カードが出て、送信フォームは出ない
      const pendingCard = ownerPage.getByRole("heading", { name: "承認待ちのリクエストがあります" });
      const emailInput = ownerPage.getByPlaceholder("子供本人のメールアドレス");
      await expect(pendingCard).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      await expect(ownerPage.locator("body")).toContainText(recipient.email);
      await expect(ownerPage.getByRole("button", { name: "別のメールアドレスで再送する" })).toBeVisible();
      await expect(emailInput).toHaveCount(0);

      // 取り消す
      const [revokeResponse] = await Promise.all([
        ownerPage.waitForResponse(
          (res) =>
            res.url().endsWith(`/api/family/members/${memberId}/promote`) &&
            res.request().method() === "DELETE",
        ),
        ownerPage.getByRole("button", { name: "リクエストを取り消す" }).click(),
      ]);
      expect(revokeResponse.status()).toBe(200);
      // 返すのは {request_id, status} だけ (token を含む行をそのまま返さない)
      const revokeBody = await revokeResponse.json();
      expect(revokeBody).toEqual({ data: { request_id: pendingRequest.id, status: "revoked" } });
      expect(JSON.stringify(revokeBody)).not.toContain(token);

      // 管理カードが消えて、送信フォームが出る
      await expect(pendingCard).toBeHidden();
      await expect(emailInput).toBeVisible();
      await expect(ownerPage.getByRole("button", { name: "参加リクエストを送信" })).toBeVisible();

      // DB: 取り消し済み。メンバーは子供のまま
      const requests = await getPromotionRequestsFromDB(memberId);
      expect(requests).toHaveLength(1);
      expect(requests[0].status).toBe("revoked");
      expect(requests[0].resolved_by).toBe(family.owner.userId);
      const member = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
      expect(member!.user_id).toBeNull();
      expect(member!.role).toBe("child");

      // 本人が以前のリンクを開くと「無効 (取り消し済み)」
      await withSessionPage(browser, recipient, async (page) => {
        await openPromotionPage(page, token);

        await expect(
          page.getByRole("heading", { name: "このリクエストは無効です" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        await expect(page.locator("body")).toContainText("取り消し済み");
        await expect(page.getByRole("button", { name: "参加を承認する" })).toHaveCount(0);

        // 画面を迂回して API を直接叩いても、承認できない
        const result = await apiFetch(page, `/api/family/promotions/${token}/accept`, {
          method: "POST",
          body: { share_meals: true, share_health: false, share_menu: true },
        });
        expect(result.status, JSON.stringify(result.body)).toBe(409);
        expect((result.body as { error?: { code?: string } }).error?.code).toBe(
          "PROMOTION_REQUEST_ALREADY_USED",
        );
      });

      const afterMember = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
      expect(afterMember!.user_id).toBeNull();
      expect(await getUserFamilyIdFromDB(recipient.id)).toBeNull();
    } finally {
      await cleanupUsers(admin, [recipient.id]);
    }
  });

  /**
   * spec12-08: 存在しない token
   */
  test("spec12-08: 存在しない token は「参加リクエストが見つかりません」になる", async ({ browser }) => {
    const token = randomToken();

    await withAnonymousPage(browser, async (page) => {
      await openPromotionPage(page, token);

      await expect(
        page.getByRole("heading", { name: "参加リクエストが見つかりません" }),
      ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      await expect(page.getByRole("button", { name: "ホームへ戻る" })).toBeVisible();
      // 同意カードやログイン誘導は出ない
      await expect(page.getByRole("heading", { name: "家族グループ参加の確認" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "参加を承認する" })).toHaveCount(0);
    });
  });

  /**
   * spec12-09: 別のメールアドレスで再送する
   *
   * 宛先を間違えたときの経路。再送すると、承認待ちの現在のリクエストは自動で取り消され、
   * 新しいリンクだけが有効になる (1 つの子供メンバーに pending は最大 1 件)。
   */
  test("spec12-09: 別のメールアドレスで再送すると、以前のリクエストは自動で取り消され、新しいリンクだけが有効になる", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const admin = getAdminClient();
    const memberId = await createChild(family);
    // 宛先を間違えて入力してしまった相手 (実在するアカウント)
    const wrongRecipient = await createFreshUser(admin, { emailPrefix: "e2e-promo-wrong" });
    const correctEmail = randomEmail("e2e-promo-correct");

    try {
      await upsertUserProfileDirect({
        userId: wrongRecipient.id,
        nickname: "E2E Wrong Recipient",
        onboarding: "completed",
      });
      const oldToken = await requestPromotion(ownerPage, memberId, wrongRecipient.email);

      await gotoWithoutClientErrors(ownerPage, `${BASE_URL}/family/members/${memberId}/promote`);
      const pendingCard = ownerPage.getByRole("heading", { name: "承認待ちのリクエストがあります" });
      await expect(pendingCard).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

      // 「別のメールアドレスで再送する」→ 管理カードの代わりに送信フォーム (取り消される旨の案内つき)
      await ownerPage.getByRole("button", { name: "別のメールアドレスで再送する" }).click();
      await expect(pendingCard).toBeHidden();
      await expect(ownerPage.locator("body")).toContainText("現在のリクエストは自動的に取り消されます");
      await ownerPage.getByPlaceholder("子供本人のメールアドレス").fill(correctEmail);
      await ownerPage.getByRole("button", { name: "参加リクエストを送信" }).click();
      await expect(
        ownerPage.getByRole("heading", { name: "参加リクエストを送信しました" }),
      ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      await expect(ownerPage.locator("body")).toContainText(correctEmail);

      // DB: 新しい宛先の pending が 1 件 (別の token)、以前のものは取り消し済み
      const requests = await getPromotionRequestsFromDB(memberId);
      expect(requests).toHaveLength(2);
      const current = requests.find((row) => row.status === "pending");
      const previous = requests.find((row) => row.status === "revoked");
      expect(current).toBeDefined();
      expect(previous).toBeDefined();
      expect(current!.email).toBe(correctEmail);
      expect(current!.token).toMatch(/^[a-f0-9]{64}$/);
      expect(current!.token).not.toBe(oldToken);
      expect(previous!.email).toBe(wrongRecipient.email);
      expect(previous!.token).toBe(oldToken);

      // 間違えた相手が以前のリンクを開いても「無効 (取り消し済み)」。承認できない
      await withSessionPage(browser, wrongRecipient, async (page) => {
        await openPromotionPage(page, oldToken);
        await expect(
          page.getByRole("heading", { name: "このリクエストは無効です" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        await expect(page.locator("body")).toContainText("取り消し済み");
        await expect(page.getByRole("button", { name: "参加を承認する" })).toHaveCount(0);
      });

      const member = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
      expect(member!.user_id).toBeNull();
      expect(await getUserFamilyIdFromDB(wrongRecipient.id)).toBeNull();
    } finally {
      await cleanupUsers(admin, [wrongRecipient.id]);
    }
  });

  /**
   * spec12-10: 有効期限が過ぎたリンク
   *
   * 期限切れは status ではなく expires_at で判定される (status は 'pending' のまま)。
   * 画面は「期限切れです」を出して承認操作を隠し、API も 410 で承認を拒む。
   */
  test("spec12-10: 有効期限が過ぎたリンクは「期限切れです」になり、API からも承認できない", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const admin = getAdminClient();
    const memberId = await createChild(family);
    const recipient = await createFreshUser(admin, { emailPrefix: "e2e-promo-expired" });

    try {
      await upsertUserProfileDirect({
        userId: recipient.id,
        nickname: "E2E Expired Recipient",
        onboarding: "completed",
      });
      const token = await requestPromotion(ownerPage, memberId, recipient.email);
      await expirePromotionRequestInDB((await getPendingPromotionRequest(memberId)).id);

      await withSessionPage(browser, recipient, async (page) => {
        await openPromotionPage(page, token);

        await expect(
          page.getByRole("heading", { name: "期限切れです" }),
        ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
        await expect(page.getByRole("button", { name: "参加を承認する" })).toHaveCount(0);
        await expect(page.getByRole("checkbox")).toHaveCount(0);

        // 画面を迂回して API を直接叩いても、承認できない (410)
        const result = await apiFetch(page, `/api/family/promotions/${token}/accept`, {
          method: "POST",
          body: { share_meals: true, share_health: false, share_menu: true },
        });
        expect(result.status, JSON.stringify(result.body)).toBe(410);
        expect((result.body as { error?: { code?: string } }).error?.code).toBe(
          "PROMOTION_REQUEST_EXPIRED",
        );
      });

      const member = await getFamilyMemberFromDB({ familyId: family.familyId, memberId });
      expect(member!.user_id).toBeNull();
      expect(member!.role).toBe("child");
      expect(await getUserFamilyIdFromDB(recipient.id)).toBeNull();
    } finally {
      await cleanupUsers(admin, [recipient.id]);
    }
  });
});
