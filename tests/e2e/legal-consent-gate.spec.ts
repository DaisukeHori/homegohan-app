/**
 * #1174 利用規約・プライバシーポリシーの再同意ゲート (E2E): 新規ユーザー -> ゲート -> 同意 -> ホーム
 *
 * 仕組み (lib/supabase/middleware.ts):
 *   サインイン中の利用者の user_profiles.terms_version_accepted / privacy_version_accepted が、
 *   packages/shared の LEGAL_DOCUMENTS (いま有効な版) と食い違うとき、
 *     - 環境変数 LEGAL_CONSENT_ENFORCE=on            : 同意画面 /legal-consent?next=<元のパス> へ回す
 *     - LEGAL_CONSENT_NOTICE=on (強制なし)            : 通す。(main) の画面の上に「同意のお願い」のお知らせを出すだけ
 *     - どちらも on でない (既定)                     : 何もしない (お知らせも出さず、誰も止めない)
 *   同意画面で 2 つのチェックを入れて「同意して続ける」を押すと、POST /api/legal/accept が DB 関数 accept_legal_documents を呼び、
 *   user_profiles の同意済みの版と、terms_acceptances の証跡 (版・日時・IP・user_agent) が残る。
 *
 * 実行 (ローカル Supabase と、Next のサーバーが要る):
 *   強制あり (ゲートの検証):
 *     LEGAL_CONSENT_ENFORCE=on npx playwright test tests/e2e/legal-consent-gate.spec.ts
 *   強制なし・お知らせあり (お知らせの検証):
 *     LEGAL_CONSENT_NOTICE=on npx playwright test tests/e2e/legal-consent-gate.spec.ts
 *   既定 = どちらもなし (何も出さず、止めないことの検証):
 *     npx playwright test tests/e2e/legal-consent-gate.spec.ts
 *   playwright.config.ts が dev サーバーを起動するときは、このプロセスの環境変数がサーバーに引き継がれる。
 *   PLAYWRIGHT_BASE_URL で起動済みのサーバーに向けるときは、サーバー側にも同じ LEGAL_CONSENT_ENFORCE / LEGAL_CONSENT_NOTICE を
 *   設定すること (この spec は、このプロセスの値を見て、どの検証をするかを決める)。
 *   値の読み方 (on のときだけ有効。大文字小文字と前後の空白は区別しない) は lib/legal-consent.ts の isLegalConsentFlagOn と同じ。
 *
 * #1435: 初回の作成 (新規登録・ログイン画面の「Googleで続ける」で初めて入った人) は、/auth/callback が
 *   フラグに関わらず同意画面へ回す (lib/legal-consent.ts の resolveFirstSignInDestination)。
 *   お知らせのリンクの戻り先は、middleware の強制の経路と同じく、いまのクエリも残す。
 *
 * #1173: 同意ゲートは生年月日 (user_profiles.birth_date) も見る。プロフィールを作る人には成人の placeholder の生年月日を入れ
 *   (同意画面に生年月日の欄が出ない)、行の無い新規ユーザーの同意画面では欄を埋める (acceptOnConsentPage)。
 *   18 歳未満の自己登録は断られ、「登録をやめる」でアカウントが消える (E2E-1)。
 *
 * テストユーザーは admin API で作り、終わったら削除する (user_profiles・terms_acceptances も連動して消える)。
 * 既存の共通ユーザー (e2e-user-01〜) は使わない: 同意済みかどうかを、テストごとに自分で決めたいため。
 */
import { test, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanupFreshUser, createFreshUser, injectSession } from "./fixtures/fresh-user";
import { acceptLegalConsentIfShown } from "./helpers/legal-consent";
import { serveTurnstileOffline } from "./helpers/turnstile-offline";
import { generateTestPassword } from "./helpers/credentials";
import { LEGAL_DOCUMENTS } from "../../packages/shared/src/legal-versions";
import { todayLocal } from "../../packages/shared/src/date-utils";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require("ws") as typeof WebSocket;

// 共有ログイン状態 (storageState) を引き継がず、各テストが自分のユーザーで入る
test.use({ storageState: { cookies: [], origins: [] } });

const ENFORCED = process.env.LEGAL_CONSENT_ENFORCE?.trim().toLowerCase() === "on";
const NOTICE = process.env.LEGAL_CONSENT_NOTICE?.trim().toLowerCase() === "on";
const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
/** 成人の placeholder。#1173 で生年月日が無いと同意画面に回されるため */
const ADULT_BIRTH_DATE = "1990-01-01";
/** 2 月 29 日の生まれを平年に写すときの日 (2 月 28 日) */
const LEAP_DAY_FALLBACK = "02-28";

/**
 * JST の今日に age 歳になる生年月日 (今日の年から age を引いた年の同じ月日)。
 * 今日が 2 月 29 日で、その年が閏年でなければ 2 月 28 日にする (Date の toISOString は使わない)
 */
function birthDateForAge(age: number): string {
  const [year, month, day] = todayLocal().split("-");
  const birthYear = Number(year) - age;
  const isLeapYear = (birthYear % 4 === 0 && birthYear % 100 !== 0) || birthYear % 400 === 0;
  const monthDay = month === "02" && day === "29" && !isLeapYear ? LEAP_DAY_FALLBACK : `${month}-${day}`;
  return `${String(birthYear).padStart(4, "0")}-${monthDay}`;
}

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
  /** プロフィールがあるとき、user_profiles.birth_date (service_role が直接入れる)。省略は ADULT_BIRTH_DATE、null は未入力 (#1173) */
  birthDate?: string | null;
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
      birth_date: options.birthDate === undefined ? ADULT_BIRTH_DATE : options.birthDate,
    });
    if (error) throw new Error(`user_profiles INSERT 失敗: ${error.message}`);
  }

  await injectSession(page, user.email);
  return user;
}

async function readProfile(userId: string) {
  const { data, error } = await admin
    .from("user_profiles")
    .select("terms_version_accepted, privacy_version_accepted, legal_accepted_at, birth_date")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_profiles SELECT 失敗: ${error.message}`);
  return data as {
    terms_version_accepted: string | null;
    privacy_version_accepted: string | null;
    legal_accepted_at: string | null;
    birth_date: string | null;
  } | null;
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
const birthDateField = (page: Page) => page.getByLabel("生年月日", { exact: true });
const banner = (page: Page) => page.getByTestId("legal-consent-banner");
/**
 * 帯は 1 ページに 1 つ (#1774)。page.goto は読み込みの終わり (load) まで待つので、その時点の DOM を、待たずに (再試行せずに) 数える。
 * このときはサーバーが送った HTML が全部 DOM に入っていて、React が後送りの中身 (<div hidden id="S:n">) を入れ替える前のことがある。
 * 以前は、ここで帯が 2 つ (fallback と、隠れた中身) あり、getByTestId が strict mode で間欠的に落ちていた
 */
async function expectSingleBannerAfterLoad(page: Page) {
  expect(await banner(page).count(), "読み込みの終わりの時点で、帯はちょうど 1 つ").toBe(1);
  await expect(banner(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  await expect(banner(page)).toHaveCount(1);
}

/**
 * 同意画面で 2 つのチェックを入れて「同意して続ける」を押す。
 * 途中で必ず確かめること: 何も入れていない間・片方だけの間は押せず、両方入れて初めて押せる。
 * 画面の引き継ぎ前にチェックを入れて未チェックに戻っても、確かめ直せるよう、全体を結果が出るまでやり直す
 */
async function acceptOnConsentPage(page: Page) {
  await expect(consentHeading(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  // 2 つのチェックは、どちらも必須として支援技術に伝わる
  await expect(termsCheckbox(page)).toHaveAttribute("aria-required", "true");
  await expect(privacyCheckbox(page)).toHaveAttribute("aria-required", "true");
  await waitForHydration(page, 'input[type="checkbox"]');
  await expect(async () => {
    // #1173: 生年月日の無い人 (行の無い新規ユーザー) には欄が出る。欄を埋めないと押せない
    if (await birthDateField(page).isVisible()) await birthDateField(page).fill(ADULT_BIRTH_DATE, { timeout: 5_000 });
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
    // #1672: e2e のアプリは Turnstile のテスト用サイトキー付きでビルドするので、「登録して始める」はウィジェットがトークンを出すまで押せない。
    // ここで確かめたいのは同意のチェックだけなので、ウィジェットは外のネットワーク (challenges.cloudflare.com) に繋がずに動かす
    // (常設の e2e で、本物のウィジェットのトークンが 5 秒以内に出ずに、チェック後も押せないまま落ちることがあった)
    await serveTurnstileOffline(page);
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
// 初回の作成: /auth/callback が必ず同意画面を通す (強制の有無に関わらない。#1435)
// ─────────────────────────────────────────────────────────────────────────────
test.describe("初回の作成は、必ず同意画面を通る (#1435)", () => {
  test.setTimeout(180_000);

  test("★メール確認 (/auth/callback?token_hash=...) で初めて入った人は、フラグに関わらず同意画面へ回り、同意すると初期設定へ進む。同意が記録される", async ({ page, baseURL }) => {
    const appBaseURL = baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const email = `e2e-legal-first-${Date.now()}-${Math.floor(Math.random() * 100000)}@homegohan.test`;
    // ログイン画面の「Googleで続ける」(OAuth) は E2E で再現できないので、同じ /auth/callback を通るメール確認の経路で確かめる
    const { data, error } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password: generateTestPassword(),
      options: { redirectTo: `${appBaseURL}/auth/callback` },
    });
    expect(error).toBeNull();
    const userId = data.user?.id;
    const hashedToken = data.properties?.hashed_token;
    expect(userId).toBeTruthy();
    expect(hashedToken).toBeTruthy();
    createdUserIds.push(userId!);

    await page.goto(`/auth/callback?token_hash=${hashedToken}&type=signup`);
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fonboarding%2Fwelcome$/, { timeout: NAVIGATION_TIMEOUT });
    expect(await readProfile(userId!)).toBeNull();

    await acceptOnConsentPage(page);
    await page.waitForURL((url) => url.pathname === "/onboarding/welcome", URL_CHANGE);

    const profile = await readProfile(userId!);
    expect(profile).toMatchObject({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY });
    expect(profile?.legal_accepted_at).not.toBeNull();
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
    // #1672: 読み込み直す前に、同意画面からホームへの遷移 (LegalConsentForm の window.location.assign) の読み込みが進む
    // (DOMContentLoaded) のを待つ。waitForURL は URL_CHANGE (waitUntil: "commit") なので、新しい文書が確定した瞬間に返り、
    // 以前はその直後 (遷移の途中) に reload を送っていた。常設の e2e で、この reload が「Not attached to an active page」で落ちた。
    // この文言は Chromium の DevTools が、ページの接続先の文書 (RenderFrameHost) が active でないときに Page.reload を断る応答
    // (content/browser/devtools/protocol/page_handler.cc の kErrorInactivePage) で、遷移による文書の入れ替えの途中に送ったときに出る。
    // 新しい文書の読み込みが進んで DOMContentLoaded が来たあとなら、入れ替えは終わっている
    await page.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT });
    await page.reload({ waitUntil: "domcontentloaded" });
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
    // #1672: acceptLegalConsentIfShown は遷移の確定 (commit) で返る。次の遷移を送る前に、上の reload と同じく読み込みが進むのを待つ
    await page.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT });
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

  test("★「同意しない」: ログアウトされ、ご利用いただけないことと、もう一度ログインすれば同意しなくても退会と書き出しができること (#1901 Q-23) が案内される。同意は記録されない", async ({ page }) => {
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
    // #1901 (cross/20 Q-23): お問い合わせによる削除は約束せず、ログインの後に同意しなくても使える退会と書き出しの画面へ案内する
    await expect(declined).not.toContainText("ご本人であることを確認のうえ");
    await expect(declined.getByRole("link", { name: "ログインして、退会・データの書き出しの画面へ" })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent("/legal-consent/account")}`,
    );

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

    // /api/* は画面の判定の対象外: 307 で同意画面へ回さない。/api/legal/accept は API の同意ゲート (#1442) の許可リストなので
    // middleware を通り、route まで届く (この API は POST だけなので、GET は 405)
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

  test("[強制あり] 新規ユーザーが同意画面で 15 歳の生年月日を入れると断られ、「登録をやめる」でアカウントが消える (#1173 E2E-1・S4)", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: false });

    await page.goto("/home");
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fhome$/, { timeout: NAVIGATION_TIMEOUT });
    await expect(consentHeading(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await waitForHydration(page, 'input[type="checkbox"]');
    await expect(async () => {
      await birthDateField(page).fill(birthDateForAge(15), { timeout: 5_000 });
      await termsCheckbox(page).check({ timeout: 5_000 });
      await privacyCheckbox(page).check({ timeout: 5_000 });
      await expect(acceptButton(page)).toBeEnabled({ timeout: 5_000 });
    }).toPass({ timeout: HYDRATION_TIMEOUT });
    await acceptButton(page).click();

    await expect(page.getByRole("heading", { level: 1, name: "18歳未満の方はご自身では登録できません" })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    // 断ったときは何も記録しない
    expect(await readProfile(user.id)).toBeNull();

    await page.getByRole("button", { name: "登録をやめる（アカウントを削除する）" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "登録をやめました" })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

    const { data, error } = await admin.auth.admin.getUserById(user.id);
    expect(data.user).toBeNull();
    expect(error).not.toBeNull();
  });

  test("[強制あり] 新規ユーザーの同意画面には生年月日の欄が出て、共通の helper acceptLegalConsentIfShown が 1990-01-01 で埋めて同意し、初期設定へ進む (#1173 E2E-3・S1)", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: false });

    await page.goto("/home");
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fhome$/, { timeout: NAVIGATION_TIMEOUT });
    await expect(birthDateField(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

    expect(await acceptLegalConsentIfShown(page)).toBe(true);
    await page.waitForURL((url) => url.pathname.startsWith("/onboarding"), URL_CHANGE);

    const profile = await readProfile(user.id);
    expect(profile).toMatchObject({
      terms_version_accepted: CURRENT_TERMS,
      privacy_version_accepted: CURRENT_PRIVACY,
      birth_date: ADULT_BIRTH_DATE,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 既定 (強制なし・お知らせなし): 何も出さない。誰も止めない
// ─────────────────────────────────────────────────────────────────────────────
test.describe("再同意ゲート: 既定 (強制なし・お知らせなし) (#1174)", () => {
  test.skip(ENFORCED || NOTICE, "LEGAL_CONSENT_ENFORCE / LEGAL_CONSENT_NOTICE のどちらも on でないときだけ実行する");
  test.setTimeout(180_000);

  test("★未同意でもホームに入れる (止まらない)。お知らせも出さない", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    await page.goto("/home");
    await expect(page.locator("main")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    expect(new URL(page.url()).pathname).toBe("/home");
    await expect(banner(page)).toHaveCount(0);
  });

  test("同意画面を自分で開けば、既定でも同意を記録できる", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: true });

    await page.goto("/legal-consent?next=%2Fhome");
    await acceptOnConsentPage(page);
    await page.waitForURL((url) => url.pathname === "/home", URL_CHANGE);
    await expect(banner(page)).toHaveCount(0);

    expect(await readProfile(user.id)).toMatchObject({
      terms_version_accepted: CURRENT_TERMS,
      privacy_version_accepted: CURRENT_PRIVACY,
    });
  });

  test("新規ユーザー (プロフィールの行なし) も止めない: 従来どおり初期設定へ回り、同意画面へは回さない", async ({ page }) => {
    await signInAsNewUser(page, { profile: false });

    await page.goto("/home");
    await page.waitForURL((url) => url.pathname.startsWith("/onboarding"), URL_CHANGE);
    expect(new URL(page.url()).pathname).not.toBe("/legal-consent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 強制なし・お知らせあり (LEGAL_CONSENT_NOTICE=on): お知らせだけ。誰も止めない
// ─────────────────────────────────────────────────────────────────────────────
test.describe("再同意ゲート: 強制なし・お知らせあり (LEGAL_CONSENT_NOTICE=on) (#1174)", () => {
  test.skip(ENFORCED || !NOTICE, "LEGAL_CONSENT_NOTICE=on で、LEGAL_CONSENT_ENFORCE=on でないときだけ実行する");
  test.setTimeout(180_000);

  test("★未同意でもホームに入れる (止まらない)。上部にお知らせが出て、リンクから同意画面へ行き、同意するとお知らせが消える", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: true });

    await page.goto("/home");
    await expectSingleBannerAfterLoad(page);
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

  test("お知らせのリンクは、いまのクエリも戻り先 (next) に残す (#1435)", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    await page.goto("/home?from=e2e");
    await expectSingleBannerAfterLoad(page);
    await expect(banner(page).getByRole("link", { name: "確認して同意する" })).toHaveAttribute(
      "href",
      "/legal-consent?next=%2Fhome%3Ffrom%3De2e",
      // クエリはハイドレーションのあとに読まれることがある (Suspense)。読めるまで待つ
      { timeout: HYDRATION_TIMEOUT },
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// API の同意ゲート (#1442 / 設計書 docs/design/cross/13a-legal-consent-api-server.md §6.14 F)
// middleware の /api の分岐が、未同意の人の API を 403 { error, code: "LEGAL_CONSENT_REQUIRED" } で止める (許可リストを除く)。
// page.request は page のセッション Cookie を使う
// ─────────────────────────────────────────────────────────────────────────────
const LEGAL_CONSENT_REQUIRED_CODE = "LEGAL_CONSENT_REQUIRED";

async function codeOf(res: { json: () => Promise<unknown> }): Promise<unknown> {
  const body = await res.json().catch(() => null);
  return body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
}

async function readLegalStatus(page: Page) {
  const res = await page.request.get("/api/legal/status", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  return (await res.json()) as { enforced: boolean; accepted: boolean; required: boolean };
}

test.describe("API の同意ゲート: 強制あり (LEGAL_CONSENT_ENFORCE=on) (#1442)", () => {
  test.skip(!ENFORCED, "LEGAL_CONSENT_ENFORCE=on のときだけ実行する");
  test.setTimeout(180_000);

  test("[強制あり] API: 未同意の人の GET /api/profile は 403 で code が LEGAL_CONSENT_REQUIRED", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    const res = await page.request.get("/api/profile", { maxRedirects: 0 });
    expect(res.status()).toBe(403);
    expect(await codeOf(res)).toBe(LEGAL_CONSENT_REQUIRED_CODE);
  });

  test("[強制あり] API: GET /api/legal/status は未同意でも 200 で required が true", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    const status = await readLegalStatus(page);
    expect(status).toMatchObject({ enforced: true, accepted: false, required: true });
  });

  test("[強制あり] API: 同意 (POST /api/legal/accept) のあとは GET /api/profile が 200、status の required が false", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    const accept = await page.request.post("/api/legal/accept", {
      data: { terms_version: CURRENT_TERMS, privacy_version: CURRENT_PRIVACY },
      headers: { "Content-Type": "application/json" },
      maxRedirects: 0,
    });
    expect(accept.status()).toBe(200);

    const profile = await page.request.get("/api/profile", { maxRedirects: 0 });
    expect(profile.status()).toBe(200);
    expect(await readLegalStatus(page)).toMatchObject({ enforced: true, accepted: true, required: false });
  });

  test("[強制あり] API: 未同意でも GET /api/account/export は 403 LEGAL_CONSENT_REQUIRED にならない", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    const res = await page.request.get("/api/account/export", { maxRedirects: 0 });
    const code = await codeOf(res);
    expect(code).not.toBe(LEGAL_CONSENT_REQUIRED_CODE);
    expect(res.status()).not.toBe(403);
  });

  test("[強制あり] API: 古い版に同意済みの人 (改定のあと) は GET /api/profile が 403 LEGAL_CONSENT_REQUIRED。/home を開くと同意画面 (「改定あり」) へ回り、再同意すると GET /api/profile が 200 (S5・S14)", async ({ page }) => {
    await signInAsNewUser(page, { profile: true, legal: { terms: "v0-old", privacy: CURRENT_PRIVACY } });

    const before = await page.request.get("/api/profile", { maxRedirects: 0 });
    expect(before.status()).toBe(403);
    expect(await codeOf(before)).toBe(LEGAL_CONSENT_REQUIRED_CODE);

    await page.goto("/home");
    await expect(page).toHaveURL(/\/legal-consent\?next=%2Fhome$/, { timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByTestId("legal-doc-terms_of_service")).toContainText("改定あり");

    await acceptOnConsentPage(page);
    await page.waitForURL((url) => url.pathname === "/home", URL_CHANGE);

    const after = await page.request.get("/api/profile", { maxRedirects: 0 });
    expect(after.status()).toBe(200);
  });
});

test.describe("API の同意ゲート: 強制なし (既定 / お知らせあり) (#1442)", () => {
  test.skip(ENFORCED, "LEGAL_CONSENT_ENFORCE=on でないときだけ実行する");
  test.setTimeout(180_000);

  test("[既定 / お知らせあり] API: 未同意でも GET /api/profile は 200、status の required は false", async ({ page }) => {
    await signInAsNewUser(page, { profile: true });

    const profile = await page.request.get("/api/profile", { maxRedirects: 0 });
    expect(profile.status()).toBe(200);
    expect(await readLegalStatus(page)).toMatchObject({ enforced: false, accepted: false, required: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 本人の権利の請求 (#1751): 開示・訂正・利用停止・消去の請求は、規約への同意も初期設定の完了も条件にできない。
// 同意の画面の案内を押すのは多くが新規登録の直後の人 (user_profiles の行がまだ無い) なので、その人で通しで確かめる:
// 同意の画面の案内 → 請求の画面 (同意ゲート・初期設定の差し戻しの対象外) → 一覧の読み込み (GET 200) → 請求 (POST 201)。
// 強制の有無で結果は変わらないので、3 つの設定 (既定・強制あり・お知らせあり) のどれでも流す。
// ─────────────────────────────────────────────────────────────────────────────
test.describe("本人の権利の請求: プロフィールの行が無い新規ユーザー (#1751)", () => {
  test.setTimeout(180_000);

  test("★未同意・初期設定の前の新規ユーザーが、同意の画面の案内から請求の画面を開き、一覧を読み、請求を出せる (行は作られない)", async ({ page }) => {
    const user = await signInAsNewUser(page, { profile: false });

    await page.goto("/legal-consent");
    await expect(consentHeading(page)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await page.getByTestId("legal-consent-dsr-link").getByRole("link").click();
    await page.waitForURL((url) => url.pathname === "/settings/data-requests", URL_CHANGE);

    // 一覧の読み込み (GET /api/account/data-requests) が 200 で、まだ請求が無い。401 なら読み込みの失敗の表示になる
    await expect(page.getByTestId("dsr-list-empty")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByTestId("dsr-load-failed")).toHaveCount(0);

    const created = await page.request.post("/api/account/data-requests", {
      data: { request_type: "disclosure", details: "保有している個人情報を開示してください" },
      headers: { "Content-Type": "application/json" },
      maxRedirects: 0,
    });
    expect(created.status()).toBe(201);
    expect(await created.json()).toMatchObject({ request: { status: "pending_verification", request_type: "disclosure" } });

    const list = await page.request.get("/api/account/data-requests", { maxRedirects: 0 });
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { requests: Array<{ request_type: string; status: string }> };
    expect(body.requests.map((request) => [request.request_type, request.status])).toEqual([["disclosure", "pending_verification"]]);

    // 請求は user_profiles の行を作らない (同意も初期設定もしていないまま)
    expect(await readProfile(user.id)).toBeNull();
  });
});
