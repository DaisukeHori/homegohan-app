/**
 * #1174 利用規約・プライバシーポリシーの再同意ゲート (E2E): 新規ユーザー -> ゲート -> 同意 -> ホーム
 *
 * 仕組み (lib/supabase/middleware.ts):
 *   サインイン中の利用者の user_profiles.terms_version_accepted / privacy_version_accepted が、
 *   packages/shared の LEGAL_DOCUMENTS (いま有効な版) と食い違うとき、
 *     - 環境変数 LEGAL_CONSENT_ENFORCE=on : 同意画面 /legal-consent?next=<元のパス> へ回す
 *     - それ以外 (既定)                   : 通す。(main) の画面の上に「同意のお願い」のお知らせを出すだけ
 *   同意画面で 2 つのチェックを入れて「同意して続ける」を押すと、POST /api/legal/accept が DB 関数 accept_legal_documents を呼び、
 *   user_profiles の同意済みの版と、terms_acceptances の証跡 (版・日時・IP・user_agent) が残る。
 *
 * 実行 (ローカル Supabase と、Next のサーバーが要る):
 *   強制あり (ゲートの検証):
 *     LEGAL_CONSENT_ENFORCE=on npx playwright test tests/e2e/legal-consent-gate.spec.ts
 *   既定 = 強制なし (お知らせの検証):
 *     npx playwright test tests/e2e/legal-consent-gate.spec.ts
 *   playwright.config.ts が dev サーバーを起動するときは、このプロセスの環境変数がサーバーに引き継がれる。
 *   PLAYWRIGHT_BASE_URL で起動済みのサーバーに向けるときは、サーバー側にも同じ LEGAL_CONSENT_ENFORCE を設定すること
 *   (この spec は、このプロセスの値を見て、強制あり / なしのどちらの検証をするかを決める)。
 *
 * テストユーザーは admin API で作り、終わったら削除する (user_profiles・terms_acceptances も連動して消える)。
 * 既存の共通ユーザー (e2e-user-01〜) は使わない: 同意済みかどうかを、テストごとに自分で決めたいため。
 */
import { test, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanupFreshUser, createFreshUser, injectSession } from "./fixtures/fresh-user";
import { acceptLegalConsentIfShown } from "./helpers/legal-consent";
import { LEGAL_DOCUMENTS } from "../../packages/shared/src/legal-versions";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require("ws") as typeof WebSocket;

// 共有ログイン状態 (storageState) を引き継がず、各テストが自分のユーザーで入る
test.use({ storageState: { cookies: [], origins: [] } });

const ENFORCED = process.env.LEGAL_CONSENT_ENFORCE?.trim().toLowerCase() === "on";
const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;

/** dev サーバーの初回コンパイルを待てるよう、画面遷移直後のアサーションだけ長めにする */
const NAVIGATION_TIMEOUT = 45_000;
/**
 * 画面遷移の確認 (page.waitForURL) の指定。URL が変わった時点 (waitUntil: "commit") で十分なので、遷移先のページが
 * 全部読み終わる (load) のは待たない。ホームや献立の画面は重く、CPU が詰まった開発サーバーでは load が 45 秒を超えることがある
 */
const URL_CHANGE = { timeout: NAVIGATION_TIMEOUT, waitUntil: "commit" as const };
/**
 * React が画面を引き継ぐ (ハイドレーション) のを待つ上限。ほかの処理で CPU が詰まっている環境の dev サーバー
 * (開発用の大きな JS を毎回読む) では、引き継ぎに 20 秒以上かかることがある。本番ビルドでは数秒で終わる
 */
const HYDRATION_TIMEOUT = 60_000;

function getAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です (.env.local を確認してください)。");
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    // @ts-expect-error ws は Node.js 用 WebSocket 実装 (Realtime は使わないが、初期化に必要)
    realtime: { transport: ws },
  });
}

interface LegalState {
  terms?: string | null;
  privacy?: string | null;
}

interface ProfileOptions {
  /** プロフィールの行を作るか。false は「新規登録しただけ」(初期設定前。行が無い) */
  profile: boolean;
  /** プロフィールがあるとき、同意済みの版 (service_role が直接入れる)。省略は未同意 */
  legal?: LegalState;
}

const admin = getAdminClient();
const createdUserIds: string[] = [];

/** テスト用ユーザーを作って、そのセッションを page に入れる */
async function signInAsNewUser(page: Page, options: ProfileOptions) {
  const user = await createFreshUser(admin, { emailPrefix: "e2e-legal" });
  createdUserIds.push(user.id);

  if (options.profile) {
    const now = new Date().toISOString();
    const { error } = await admin.from("user_profiles").insert({
      id: user.id,
      nickname: "E2E Legal",
      age_group: "30s",
      gender: "unspecified",
      // 初期設定とハンズオンツアーは済んでいる (ホームへそのまま入れる)
      onboarding_started_at: now,
      onboarding_completed_at: now,
      handson_tour_skipped_at: now,
      terms_version_accepted: options.legal?.terms ?? null,
      privacy_version_accepted: options.legal?.privacy ?? null,
      legal_accepted_at: options.legal?.terms || options.legal?.privacy ? now : null,
    });
    if (error) throw new Error(`user_profiles INSERT 失敗: ${error.message}`);
  }

  await injectSession(page, user.email, user.password);
  return user;
}

async function readProfile(userId: string) {
  const { data, error } = await admin
    .from("user_profiles")
    .select("terms_version_accepted, privacy_version_accepted, legal_accepted_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_profiles SELECT 失敗: ${error.message}`);
  return data as { terms_version_accepted: string | null; privacy_version_accepted: string | null; legal_accepted_at: string | null } | null;
}

async function readAcceptances(userId: string) {
  const { data, error } = await admin
    .from("terms_acceptances")
    .select("document_type, document_version, accepted_at, ip_address, user_agent")
    .eq("user_id", userId);
  if (error) throw new Error(`terms_acceptances SELECT 失敗: ${error.message}`);
  return (data ?? []) as Array<{
    document_type: string;
    document_version: string;
    accepted_at: string;
    ip_address: string | null;
    user_agent: string | null;
  }>;
}

/**
 * セレクターの要素に React が付く内部の印 (__reactProps / __reactFiber) が付く = 画面が引き継がれる (ハイドレーション) のを待つ。
 * 引き継ぐ前にチェックを入れると、引き継ぎで未チェックに戻ることがある。
 * 印を見つけられなくても (開発サーバーが再コンパイルのたびに画面を読み込み直すなど) 止めない。この後の「チェック → 結果の確認」を、
 * 結果が出るまでやり直す (toPass) ので、待ちきれなかったことだけでは失敗にしない
 */
async function waitForHydration(page: Page, selector: string) {
  await page
    .waitForFunction(
      (target) => {
        const el = document.querySelector(target);
        return !!el && Object.keys(el).some((key) => key.startsWith("__reactProps") || key.startsWith("__reactFiber"));
      },
      selector,
      { timeout: HYDRATION_TIMEOUT },
    )
    .catch(() => undefined);
}

const consentHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "利用規約・プライバシーポリシーへの同意" });
const termsCheckbox = (page: Page) => page.getByRole("checkbox", { name: /利用規約の内容を確認し、同意します/ });
const privacyCheckbox = (page: Page) => page.getByRole("checkbox", { name: /プライバシーポリシーの内容を確認し、同意します/ });
const acceptButton = (page: Page) => page.getByRole("button", { name: "同意して続ける" });
const banner = (page: Page) => page.getByTestId("legal-consent-banner");

/**
 * 同意画面で 2 つのチェックを入れて「同意して続ける」を押す。
 * 途中で必ず確かめること: 何も入れていない間・片方だけの間は押せず、両方入れて初めて押せる。
 * 画面の引き継ぎ前にチェックを入れて未チェックに戻っても、確かめ直せるよう、全体を結果が出るまでやり直す
 */
async function acceptOnConsentPage(page: Page) {
  await expect(consentHeading(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  await waitForHydration(page, 'input[type="checkbox"]');
  await expect(async () => {
    await termsCheckbox(page).uncheck({ timeout: 5_000 });
    await privacyCheckbox(page).uncheck({ timeout: 5_000 });
    await expect(acceptButton(page)).toBeDisabled({ timeout: 2_000 });
    await termsCheckbox(page).check({ timeout: 5_000 });
    await expect(acceptButton(page)).toBeDisabled({ timeout: 2_000 });
    await privacyCheckbox(page).check({ timeout: 5_000 });
    await expect(acceptButton(page)).toBeEnabled({ timeout: 5_000 });
  }).toPass({ timeout: HYDRATION_TIMEOUT });
  await acceptButton(page).click();
}

test.afterAll(async () => {
  for (const id of createdUserIds) {
    await cleanupFreshUser(admin, id).catch((error) => console.warn(`[cleanup] ユーザー ${id} の削除に失敗: ${error}`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// サインアップ画面: 明示的な同意 (強制の有無に関わらない)
// ─────────────────────────────────────────────────────────────────────────────
test.describe("サインアップ画面の明示的な同意 (#1174)", () => {
  test.setTimeout(120_000);

  test("チェックするまで、Google 登録も「登録して始める」も押せない。みなし同意の文面は無い", async ({ page }) => {
    await page.goto("/signup");

    const consent = page.locator("#agree-legal");
    await expect(consent).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(consent).not.toBeChecked();
    await expect(page.getByRole("button", { name: /Googleで登録/ })).toBeDisabled();
    await expect(page.locator('form button[type="submit"]')).toBeDisabled();
    await expect(page.getByText("同意したものとみなされます")).toHaveCount(0);

    // チェックすると両方のボタンが押せるようになり、外すと押せなくなる。画面の引き継ぎ前の操作で結果が揺れても、
    // 結果が出るまで (外した状態に戻したうえで) やり直す
    await waitForHydration(page, "#agree-legal");
    const googleButton = page.getByRole("button", { name: /Googleで登録/ });
    const submitButton = page.locator('form button[type="submit"]');
    await expect(async () => {
      await consent.uncheck({ timeout: 5_000 });
      await expect(googleButton).toBeDisabled({ timeout: 2_000 });
      await expect(submitButton).toBeDisabled({ timeout: 2_000 });
      await consent.check({ timeout: 5_000 });
      await expect(googleButton).toBeEnabled({ timeout: 5_000 });
      await expect(submitButton).toBeEnabled({ timeout: 5_000 });
      await consent.uncheck({ timeout: 5_000 });
      await expect(submitButton).toBeDisabled({ timeout: 5_000 });
    }).toPass({ timeout: HYDRATION_TIMEOUT });
  });

  test("同意のチェックの文面から、利用規約・プライバシーポリシーに着地できる", async ({ page }) => {
    await page.goto("/signup");
    await page.locator("label[for='agree-legal']").getByRole("link", { name: "利用規約", exact: true }).click();
    await expect(page).toHaveURL(/\/terms$/, { timeout: NAVIGATION_TIMEOUT });

    await page.goto("/signup");
    await page.locator("label[for='agree-legal']").getByRole("link", { name: "プライバシーポリシー", exact: true }).click();
    await expect(page).toHaveURL(/\/privacy$/, { timeout: NAVIGATION_TIMEOUT });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 公開ページ: 版と施行日 (強制の有無に関わらない)
// ─────────────────────────────────────────────────────────────────────────────
test.describe("利用規約・プライバシーポリシーの版と施行日 (#1174)", () => {
  for (const { path, type } of [
    { path: "/terms", type: "terms_of_service" as const },
    { path: "/privacy", type: "privacy_policy" as const },
  ]) {
    test(`${path} の冒頭に、同意の記録に使う版と施行日が出る`, async ({ page }) => {
      await page.goto(path);
      const meta = page.getByTestId("legal-document-meta");
      await expect(meta).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      await expect(meta).toContainText(LEGAL_DOCUMENTS[type].version);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 強制あり (LEGAL_CONSENT_ENFORCE=on): ゲート
// ─────────────────────────────────────────────────────────────────────────────
test.describe("再同意ゲート: 強制あり (LEGAL_CONSENT_ENFORCE=on) (#1174)", () => {
  test.skip(!ENFORCED, "LEGAL_CONSENT_ENFORCE=on のとき (サーバーも同じ設定で起動したとき) だけ実行する");
  test.setTimeout(180_000);

  test("★新規ユーザー (プロフィールの行なし) は、保護ページを開くと同意画面へ回り、同意すると初期設定へ進む。同意が記録される", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: false });

    await page.goto("/home");
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fhome$/, { timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByTestId("legal-doc-terms_of_service")).toContainText(CURRENT_TERMS);
    await expect(page.getByTestId("legal-doc-privacy_policy")).toContainText(CURRENT_PRIVACY);
    expect(await readProfile(user.id)).toBeNull();

    await acceptOnConsentPage(page);

    // 同意したあとは元の画面 (/home) へ。初期設定が未着手なので、従来どおり /onboarding/welcome に回る
    await page.waitForURL((url) => url.pathname.startsWith("/onboarding"), URL_CHANGE);
    expect(new URL(page.url()).pathname).toBe("/onboarding/welcome");

    const profile = await readProfile(user.id);
    expect(profile).toMatchObject({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY });
    expect(profile?.legal_accepted_at).not.toBeNull();
  });

  test("★初期設定が済んでいるのに未同意のユーザーは、同意画面へ回り、同意するとホーム (/home) に着く。証跡が残る", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: true });

    await page.goto("/home");
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fhome$/, { timeout: NAVIGATION_TIMEOUT });
    await acceptOnConsentPage(page);

    await page.waitForURL((url) => url.pathname === "/home", URL_CHANGE);
    // 同意した後は、もう同意画面へ回されない (ホームに留まる)
    await page.reload();
    expect(new URL(page.url()).pathname).toBe("/home");

    const rows = await readAcceptances(user.id);
    expect(rows.map((r) => `${r.document_type}:${r.document_version}`).sort()).toEqual(
      [`privacy_policy:${CURRENT_PRIVACY}`, `terms_of_service:${CURRENT_TERMS}`].sort(),
    );
    for (const row of rows) {
      // 端末情報は、ブラウザが送ってきた値ではなく、サーバーが受け取ったリクエストから取った値
      expect(row.user_agent ?? "").toMatch(/Mozilla/);
      expect(Number.isNaN(Date.parse(row.accepted_at))).toBe(false);
    }
    expect(await readProfile(user.id)).toMatchObject({
      terms_version_accepted: CURRENT_TERMS,
      privacy_version_accepted: CURRENT_PRIVACY,
    });
  });

  test("アプリ (WebView) の ?mode=app とクエリは、同意画面を経由しても戻り先に残る", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    await page.goto("/menus/weekly?mode=app");
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fmenus%2Fweekly%3Fmode%3Dapp$/, { timeout: NAVIGATION_TIMEOUT });
    await acceptOnConsentPage(page);

    await page.waitForURL((url) => url.pathname === "/menus/weekly", URL_CHANGE);
    expect(new URL(page.url()).searchParams.get("mode")).toBe("app");
  });

  test("共通のログイン処理 (global-setup / login) が使う acceptLegalConsentIfShown は、同意画面に回されたユーザーに同意させて元の画面へ戻す。同意が済んでいれば何もしない", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: true });

    await page.goto("/menus/weekly");
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fmenus%2Fweekly$/, { timeout: NAVIGATION_TIMEOUT });

    expect(await acceptLegalConsentIfShown(page)).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/menus/weekly");
    expect(await readProfile(user.id)).toMatchObject({
      terms_version_accepted: CURRENT_TERMS,
      privacy_version_accepted: CURRENT_PRIVACY,
    });

    // 同意は DB に残っているので、もう同意画面には回されない。何もしない (false)
    await page.goto("/menus/weekly");
    expect(new URL(page.url()).pathname).toBe("/menus/weekly");
    expect(await acceptLegalConsentIfShown(page)).toBe(false);
  });

  test("★規約が改定されたとき (古い版に同意済み) は、「改定あり」つきで再同意を求め、同意すると新しい版が記録される。古い版は残る", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: true, legal: { terms: "v0-old", privacy: CURRENT_PRIVACY } });
    // 古い版に同意したときの証跡 (service_role が入れる。accept_legal_documents を通さない)
    const { error } = await admin
      .from("terms_acceptances")
      .insert({ user_id: user.id, document_type: "terms_of_service", document_version: "v0-old" });
    expect(error).toBeNull();

    await page.goto("/menus/weekly");
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fmenus%2Fweekly$/, { timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByText("改定されました")).toBeVisible();
    await expect(page.getByTestId("legal-doc-terms_of_service")).toContainText("改定あり");
    await expect(page.getByTestId("legal-doc-privacy_policy")).not.toContainText("改定あり");

    await acceptOnConsentPage(page);
    await page.waitForURL((url) => url.pathname === "/menus/weekly", URL_CHANGE);

    expect(await readProfile(user.id)).toMatchObject({
      terms_version_accepted: CURRENT_TERMS,
      privacy_version_accepted: CURRENT_PRIVACY,
    });
    const rows = (await readAcceptances(user.id)).map((r) => `${r.document_type}:${r.document_version}`);
    expect(rows).toContain("terms_of_service:v0-old");
    expect(rows).toContain(`terms_of_service:${CURRENT_TERMS}`);
    expect(rows).toContain(`privacy_policy:${CURRENT_PRIVACY}`);
  });

  test("★「同意しない」: ログアウトされ、ご利用いただけないことと削除の依頼先 (お問い合わせ) が案内される。同意は記録されない", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: true });

    await page.goto("/home");
    await expect(page).toHaveURL(/\/legal-consent/, { timeout: NAVIGATION_TIMEOUT });
    await expect(consentHeading(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await waitForHydration(page, 'input[type="checkbox"]');
    await page.getByRole("button", { name: /同意しない/ }).click();

    const declined = page.getByTestId("legal-consent-declined");
    await expect(declined).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(declined).toContainText("ご利用いただけません");
    await expect(declined.getByRole("link", { name: "お問い合わせフォームへ" })).toHaveAttribute("href", "/contact");

    // ログアウトされている: 保護ページはログイン画面へ回る
    await page.goto("/home");
    await expect(page).toHaveURL(/\/login/, { timeout: NAVIGATION_TIMEOUT });

    expect(await readAcceptances(user.id)).toEqual([]);
    expect(await readProfile(user.id)).toMatchObject({ terms_version_accepted: null, privacy_version_accepted: null });
  });

  test("ゲートの対象外 (規約・プライバシー・特商法・お問い合わせ・同意画面) は、未同意でも回されない。API も回されない", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    for (const path of ["/terms", "/privacy", "/legal", "/contact"]) {
      await page.goto(path);
      expect(new URL(page.url()).pathname, `${path} が同意画面へ回されない`).toBe(path);
    }

    await page.goto("/legal-consent?next=%2Fhome");
    await expect(consentHeading(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    expect(new URL(page.url()).pathname).toBe("/legal-consent");

    // /api/* はゲートの対象外: 307 で同意画面へ回さない (この API は POST だけなので、GET は 405)
    const res = await page.request.get("/api/legal/accept", { maxRedirects: 0 });
    expect(res.status()).toBe(405);
  });

  test("同意済みのユーザーは、ゲートに掛からない。同意画面を直接開いても、戻り先へ回される", async ({ page }) => {
    await signInAsNewUser(page, { profile: true, legal: { terms: CURRENT_TERMS, privacy: CURRENT_PRIVACY } });

    await page.goto("/home");
    expect(new URL(page.url()).pathname).toBe("/home");
    await expect(banner(page)).toHaveCount(0);

    await page.goto("/legal-consent?next=%2Fmenus%2Fweekly");
    await page.waitForURL((url) => url.pathname === "/menus/weekly", URL_CHANGE);
  });

  test("★戻り先 (next) が外部のサイトでも、同意したあとは自サイトのホームへ戻る (open redirect しない)", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    await page.goto(`/legal-consent?next=${encodeURIComponent("https://evil.example/phish")}`);
    await acceptOnConsentPage(page);

    await page.waitForURL((url) => url.pathname === "/home", URL_CHANGE);
    expect(new URL(page.url()).hostname).not.toBe("evil.example");
  });

  test("未ログインで同意画面を開くと、ログイン画面へ回る", async ({ page }) => {
    await page.goto("/legal-consent?next=%2Fhome");
    await expect(page).toHaveURL(/\/login\?next=/, { timeout: NAVIGATION_TIMEOUT });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 強制なし (既定): お知らせだけ。誰も止めない
// ─────────────────────────────────────────────────────────────────────────────
test.describe("再同意ゲート: 強制なし (既定) のお知らせ (#1174)", () => {
  test.skip(ENFORCED, "LEGAL_CONSENT_ENFORCE=on のときは対象外 (強制ありのテストを実行する)");
  test.setTimeout(180_000);

  test("★未同意でもホームに入れる (止まらない)。上部にお知らせが出て、リンクから同意画面へ行き、同意するとお知らせが消える", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: true });

    await page.goto("/home");
    await expect(banner(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    expect(new URL(page.url()).pathname).toBe("/home");

    // お知らせは画面の流れの中にある (固定表示でボトムナビ・ヘッダー・モーダルに重ならない)
    expect(await banner(page).evaluate((el) => getComputedStyle(el).position)).toBe("static");

    await banner(page).getByRole("link", { name: "確認して同意する" }).click();
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fhome$/, { timeout: NAVIGATION_TIMEOUT });

    await acceptOnConsentPage(page);
    await page.waitForURL((url) => url.pathname === "/home", URL_CHANGE);
    await expect(banner(page)).toHaveCount(0);

    expect(await readProfile(user.id)).toMatchObject({
      terms_version_accepted: CURRENT_TERMS,
      privacy_version_accepted: CURRENT_PRIVACY,
    });
  });

  test("同意済みのユーザーには、お知らせを出さない", async ({ page }) => {
    await signInAsNewUser(page, { profile: true, legal: { terms: CURRENT_TERMS, privacy: CURRENT_PRIVACY } });

    await page.goto("/home");
    await expect(page.locator("main")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(banner(page)).toHaveCount(0);
  });

  test("新規ユーザー (プロフィールの行なし) も止めない: 従来どおり初期設定へ回り、同意画面へは回さない", async ({ page }) => {
    await signInAsNewUser(page, { profile: false });

    await page.goto("/home");
    await page.waitForURL((url) => url.pathname.startsWith("/onboarding"), URL_CHANGE);
    expect(new URL(page.url()).pathname).not.toBe("/legal-consent");
  });
});
