/**
 * tests/e2e/tour/helpers.ts
 *
 * Playwright E2E ハンズオンツアー共通ヘルパー (#846)
 *
 * 方針:
 *   - テスト用ユーザーは service_role の admin API で作る (メール確認を飛ばす)。ローカルの Supabase に実際に書き込み、
 *     テストが終わったら (失敗・タイムアウトでも) 消す。API のモックは使わない。
 *   - 「ユーザーを作れなかった」「API が成功しなかった」「ボタンが出なかった」は、静かに skip せず、原因が分かるエラーで落とす。
 *     以前は `isVisible({ timeout })` (Playwright は timeout を無視して今の状態だけを返す) で「まだ出ていない」を
 *     「未実装」と取り違え、約 70 か所の test.skip に逃げていたため、CI で何も確かめないまま通っていた。
 *   - skip (test.fixme) にしてよいのは、テスト用ユーザーを作る環境変数が無いときだけ (provisioningGuard)。
 *     足りない変数の名前を理由に出す。
 *   - ツアー中は全面のオーバーレイ (tour-overlay) が下の画面にかぶさり、Spotlight の対象 (meal-save-button など) は
 *     直接クリックできない。進める操作は吹き出しの tour-next-button で行う (completeStep1〜3)。
 */

import { test as base, expect, type Locator, type Page, type Response } from "@playwright/test";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import { generateTestPassword } from "../helpers/credentials";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

export { expect };

// ─────────────────────────────────────────────────────────────────────────────
// 環境
// ─────────────────────────────────────────────────────────────────────────────

function readEnv() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  };
}

/** テスト用ユーザーを作るのに足りない環境変数の名前 (全部そろっていれば空) */
export function missingProvisioningEnv(): string[] {
  const { url, serviceRoleKey, anonKey } = readEnv();
  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!anonKey) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return missing;
}

/** 実行ごとにランダムなパスワード (リポジトリに固定のパスワードを置かない。tests/e2e/helpers/credentials.ts) */
const TEST_USER_PASSWORD = generateTestPassword();

/** テスト対象のアプリの URL (playwright.config.ts の use.baseURL と同じ決め方) */
export function appBaseUrl(baseURL?: string): string {
  return baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase (service_role) の呼び出し
// ─────────────────────────────────────────────────────────────────────────────

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const { serviceRoleKey } = readEnv();
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, ...extra };
}

/** 失敗 (2xx 以外) なら、何をしていたかと HTTP ステータス・応答の冒頭を付けて投げる。応答にパスワードは含まれない */
async function expectOk(resp: globalThis.Response, what: string): Promise<void> {
  if (resp.ok) return;
  const body = (await resp.text()).slice(0, 300);
  throw new Error(`[tour/helpers] ${what} に失敗しました (HTTP ${resp.status}): ${body}`);
}

/** service_role で 1 テーブルを読む。query は PostgREST のクエリ文字列 (例: `id=eq.xxx&select=roles`) */
export async function selectRows<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
  const { url } = readEnv();
  const resp = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: serviceHeaders() });
  await expectOk(resp, `${table} の読み取り`);
  return (await resp.json()) as T[];
}

/** service_role で 1 行 INSERT する。失敗したら投げる (列名の誤りで行が入らないまま通ることを防ぐ) */
export async function insertRow(
  table: string,
  row: Record<string, unknown>,
  prefer = "return=minimal",
): Promise<void> {
  const { url } = readEnv();
  const resp = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json", Prefer: prefer }),
    body: JSON.stringify(row),
  });
  await expectOk(resp, `${table} への INSERT`);
}

/** ユニークなテストメールを生成する */
export function generateTestEmail(prefix = "e2e-tour"): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@homegohan.test`;
}

export type TourUser = { id: string; email: string; password: string };

/**
 * auth admin API で新規ユーザーを作り、user_profiles に onboarding 完了済みの初期レコードを入れる。
 * anon key の signup ではなく admin API (email_confirm: true) を使い、メール確認を飛ばす。
 * onboarding_completed_at があるので、ツアーは「対象 (eligible)」になり /handson-tour が開く。
 *
 * @param profile user_profiles に上書きする列 (例: `{ roles: ["user", "admin"] }`、`{ onboarding_completed_at: null }`)。
 *   service_role の INSERT なので、roles などの特権列も入れられる。
 */
export async function createTourUser(
  prefix: string,
  profile: Record<string, unknown> = {},
): Promise<TourUser> {
  const { url } = readEnv();
  const email = generateTestEmail(prefix);
  const password = TEST_USER_PASSWORD;

  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  await expectOk(created, "テスト用ユーザーの作成 (auth admin API)");
  const { id } = (await created.json()) as { id?: string };
  if (!id) throw new Error("[tour/helpers] auth admin API の応答にユーザー id がありません");

  try {
    await insertRow("user_profiles", {
      id,
      nickname: "E2E Test User",
      age_group: "30s",
      gender: "unspecified",
      onboarding_completed_at: new Date().toISOString(),
      ...profile,
    });
  } catch (err) {
    // プロフィールを作れなかったユーザーを残さない
    await deleteTourUser(id).catch(() => {});
    throw err;
  }
  return { id, email, password };
}

/** auth admin API でユーザーを消す (user_profiles や獲得バッジなど、ユーザーにぶら下がる行も一緒に消える)。無ければ何もしない */
export async function deleteTourUser(userId: string): Promise<void> {
  const { url } = readEnv();
  const resp = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: serviceHeaders(),
  });
  if (resp.status === 404) return;
  await expectOk(resp, `テスト用ユーザーの削除 (${userId})`);
}

/** バッジを直接付与する。マスター (badges) に無い code は、静かに無視せず投げる */
export async function awardBadge(userId: string, badgeCode: string): Promise<void> {
  await insertRow(
    "user_badges",
    { user_id: userId, badge_id: await badgeIdOf(badgeCode), obtained_at: new Date().toISOString() },
    "resolution=ignore-duplicates,return=minimal",
  );
}

/** ユーザーがそのバッジを獲得済みか。マスター (badges) に無い code は、false にせず投げる */
export async function hasBadge(userId: string, badgeCode: string): Promise<boolean> {
  const badgeId = await badgeIdOf(badgeCode);
  const rows = await selectRows("user_badges", `user_id=eq.${userId}&badge_id=eq.${badgeId}&select=badge_id`);
  return rows.length > 0;
}

async function badgeIdOf(badgeCode: string): Promise<string> {
  const badges = await selectRows<{ id: string }>("badges", `code=eq.${badgeCode}&select=id`);
  if (badges.length !== 1) {
    throw new Error(`[tour/helpers] badges に code=${badgeCode} の行が ${badges.length} 件あります (1 件のはず)`);
  }
  return badges[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// ログイン (パスワード認証 → Cookie 注入)
// ─────────────────────────────────────────────────────────────────────────────

/** パスワード認証でセッション (access_token など) を取る。レート制限 (429) は少し待ってやり直す */
async function passwordGrant(user: TourUser): Promise<Record<string, unknown>> {
  const { url, anonKey } = readEnv();
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    if (resp.status === 429 && attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
      continue;
    }
    await expectOk(resp, "テスト用ユーザーのログイン (パスワード認証)");
    const session = (await resp.json()) as Record<string, unknown>;
    if (!session.access_token) throw new Error("[tour/helpers] ログインの応答に access_token がありません");
    return session;
  }
}

/** ユーザーの access_token (JWT)。API を Bearer で直接呼ぶときに使う */
export async function getAccessToken(user: TourUser): Promise<string> {
  return (await passwordGrant(user)).access_token as string;
}

/**
 * ログイン済みの状態を作る。@supabase/ssr は Cookie でセッションを持つので、Cookie を直接注入する。
 * 設定で共有されているログイン状態 (global-setup の storageState) の Cookie は先に消す。
 */
async function injectSession(page: Page, baseURL: string, user: TourUser): Promise<void> {
  const { url } = readEnv();
  const session = await passwordGrant(user);
  const supabaseRef = new URL(url).hostname.split(".")[0];
  const expiresAt = (session.expires_at as number | undefined) ?? Math.floor(Date.now() / 1000) + 3600;

  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: `sb-${supabaseRef}-auth-token`,
      value: encodeURIComponent(JSON.stringify(session)),
      domain: new URL(baseURL).hostname,
      path: "/",
      expires: expiresAt,
      httpOnly: false,
      secure: baseURL.startsWith("https"),
      sameSite: "Lax",
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Playwright fixture
// ─────────────────────────────────────────────────────────────────────────────

type TourFixtures = {
  /** テスト用ユーザーを作る。作ったユーザーは、テストが終わったら成否にかかわらず消す */
  createUser: (prefix: string, profile?: Record<string, unknown>) => Promise<TourUser>;
  /** onboarding 完了済み・ツアー未実施の新規ユーザー。page には、このユーザーでログインした状態が入っている */
  tourUser: TourUser;
  /** (自動) テスト用ユーザーを作る環境変数が無いときだけ、理由付きで test.fixme にする */
  provisioningGuard: void;
};

export const test = base.extend<TourFixtures>({
  provisioningGuard: [
    async ({}, use, testInfo) => {
      const missing = missingProvisioningEnv();
      testInfo.fixme(
        missing.length > 0,
        `テスト用ユーザーを作る環境変数 (${missing.join(", ")}) が無い環境 (本番 URL に向けた実行など) では動かせない。` +
          "ローカルは bash scripts/supabase-local.sh env .env.local で用意する",
      );
      await use();
    },
    { auto: true },
  ],

  createUser: async ({}, use) => {
    const created: string[] = [];
    try {
      await use(async (prefix, profile) => {
        const user = await createTourUser(prefix, profile);
        created.push(user.id);
        return user;
      });
    } finally {
      const errors: unknown[] = [];
      for (const id of created) {
        try {
          await deleteTourUser(id);
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length > 0) throw errors[0];
    }
  },

  tourUser: async ({ page, baseURL, createUser }, use) => {
    const user = await createUser("e2e-tour");
    await injectSession(page, appBaseUrl(baseURL), user);
    await use(user);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/handson-tour/status
// ─────────────────────────────────────────────────────────────────────────────

export type TourStatusResult = { status: number; body: unknown };

/**
 * ツアーの対象かを返す API を、ブラウザの Cookie なしで直接呼ぶ。
 * accessToken があれば Bearer で渡す (モバイルアプリと同じ呼び方)。無ければ未ログインの呼び出し。
 * 失敗 (401 など) も握りつぶさず、ステータスと本文をそのまま返す。判定は呼び出し側の expect で行う。
 */
export async function fetchTourStatus(baseURL: string, accessToken?: string): Promise<TourStatusResult> {
  const headers: Record<string, string> = { Cookie: "" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const resp = await fetch(`${baseURL}/api/handson-tour/status`, { headers });
  const text = await resp.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // JSON でない本文はそのまま返す
  }
  return { status: resp.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// ツアーを進める操作
//
// 画面の文言: packages/handson-tour-shared/src/i18n.ts (HANDSON_TOUR_I18N_JA)
// 自動で進む時間: packages/handson-tour-shared/src/constants.ts (HANDSON_TOUR_CONSTANTS)
// ─────────────────────────────────────────────────────────────────────────────

/** 自動で進む段階 (Step 1 は intro 2.5s + カメラ 2s + 解析 1.5s + 0.5s) を待つのに十分な時間 */
const AUTO_ADVANCE_TIMEOUT = 20_000;
/** 画面遷移を待つ時間。next dev の初回コンパイルでも足りるように長めにとる */
const NAVIGATION_TIMEOUT = 30_000;

/** ツアーの保存 API の応答 (ステータスと本文)。画面遷移のあとでは読めなくなるため、その場で読んでから渡す */
export type SavedResponse = { status: number; body: unknown };

async function readSavedResponse(response: Response): Promise<SavedResponse> {
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // JSON でない本文はそのまま返す
  }
  return { status: response.status(), body };
}

/** 吹き出しの主ボタン (tour-next-button)。ラベルは段階ごとに違う (次へ / 保存 / 生成する / 献立に追加) */
export function nextButton(page: Page, label: string): Locator {
  return page.getByTestId("tour-next-button").filter({ hasText: label });
}

/**
 * 吹き出しの主ボタンを押し、吹き出しの本文が次の段階のものに変わるまで待つ。
 * 「次へ」が続く段階 (Step 2 の 2.2→2.3→2.4、Step 3 の 3.2→3.3→3.4) で、押したつもりが前の段階のボタンだった、を防ぐ。
 * 押す前の本文は、ボタンが出てから読む (ボタンが出た時点で、その段階の吹き出しになっている)。
 */
export async function clickNextAndWaitForNextBubble(page: Page, label: string): Promise<void> {
  const button = nextButton(page, label);
  await expect(button).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT });
  const body = page.getByTestId("tour-bubble-body");
  const before = (await body.textContent()) ?? "";
  await button.click();
  await expect(body).not.toHaveText(before, { timeout: 10_000 });
}

/**
 * 要素に React のイベントハンドラが付くまで待つ。
 * サーバーで描かれた HTML は、React が付く (hydrate される) までの間、ボタンが見えていてもクリックが何も起こさない。
 * Step 0 のようにサーバーで描かれる画面では、ボタンが見えてから押せるようになるまでに隙間がある。
 * React が DOM に付ける内部のキー (__reactProps$...) が出るのを待つ (tests/e2e/global-setup.ts のログイン画面と同じ方法)。
 */
export async function waitForReactHandlers(page: Page, testId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return !!el && Object.keys(el).some((key) => key.startsWith("__reactProps"));
    },
    testId,
    { timeout: NAVIGATION_TIMEOUT },
  );
}

/** ログイン済みのユーザーで Step 0 (ウェルカム) を開く。ボタンを押せる状態になるまで待つ */
export async function openTour(page: Page): Promise<void> {
  await page.goto("/handson-tour");
  await expect(page.getByTestId("tour-step-0")).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  await waitForReactHandlers(page, "tour-step-0-start");
}

/** Step 0 の「はじめる」を押して Step 1 (写真) へ進む */
export async function startTour(page: Page): Promise<void> {
  await page.getByTestId("tour-step-0-start").click();
  await page.waitForURL("**/handson-tour/photo", { timeout: NAVIGATION_TIMEOUT });
}

/**
 * Step 1 (/handson-tour/photo) を最後まで進める。
 * intro → カメラ → 解析中 (ここまで自動) → 結果 → [次へ] → [保存] → Step 2 (/handson-tour/menu) へ。
 * 保存の通信 (POST /api/meal-plans/add-from-photo) の応答を返す。画面は、保存が失敗しても先へ進む (体験モードのため)。
 */
export async function completeStep1(page: Page): Promise<SavedResponse> {
  await expect(page.getByTestId("meal-result-dish-name")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT });
  await nextButton(page, "次へ").click({ timeout: AUTO_ADVANCE_TIMEOUT });
  // 保存ボタンの Spotlight 段階。meal-save-button 自体はオーバーレイの下なので、押すのは吹き出しの [保存]
  await expect(page.getByTestId("meal-save-button")).toBeVisible();
  const [saved] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/meal-plans/add-from-photo") && r.request().method() === "POST",
      { timeout: NAVIGATION_TIMEOUT },
    ),
    nextButton(page, "保存").click(),
  ]);
  const result = await readSavedResponse(saved);
  await page.waitForURL("**/handson-tour/menu", { timeout: NAVIGATION_TIMEOUT });
  return result;
}

/**
 * Step 2 (/handson-tour/menu) を最後まで進める。
 * intro (自動) → 条件フラグ → 自由メモ → [生成する] → ローディング (自動) → 結果 → [次へ] → [献立に追加] → Step 3 (/handson-tour/badges) へ。
 * 追加の通信 (POST /api/menu-plans/add) の応答を返す。
 */
export async function completeStep2(page: Page): Promise<SavedResponse> {
  await expect(page.getByTestId("v4-no-cook-toggle")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT });
  await clickNextAndWaitForNextBubble(page, "次へ"); // 2.2 条件フラグ → 2.3 自由メモ
  await clickNextAndWaitForNextBubble(page, "次へ"); // 2.3 自由メモ → 2.4 生成ボタン
  await expect(page.getByTestId("v4-generate-button")).toBeVisible();
  await nextButton(page, "生成する").click();
  await expect(page.getByTestId("v4-result-card")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT }); // 2.5 (自動 2 秒) → 2.6
  await clickNextAndWaitForNextBubble(page, "次へ"); // 2.6 結果 → 2.7 追加ボタン
  await expect(page.getByTestId("v4-add-to-menu-button")).toBeVisible();
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/menu-plans/add") && r.request().method() === "POST", {
      timeout: NAVIGATION_TIMEOUT,
    }),
    nextButton(page, "献立に追加").click(),
  ]);
  const result = await readSavedResponse(saved);
  await page.waitForURL("**/handson-tour/badges", { timeout: NAVIGATION_TIMEOUT });
  return result;
}

/**
 * Step 3 (/handson-tour/badges) を最後まで進める。
 * 読み込み → intro (自動) → first_bite → planner → tutorial_complete (それぞれ [次へ]) → Step 4 (/handson-tour/graduate) へ。
 */
export async function completeStep3(page: Page): Promise<void> {
  await expect(page.getByTestId("badge-card-first_bite")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT });
  await clickNextAndWaitForNextBubble(page, "次へ"); // 3.2 first_bite → 3.3 planner (intro は自動で 2 秒)
  await clickNextAndWaitForNextBubble(page, "次へ"); // 3.3 planner → 3.4 tutorial_complete
  await nextButton(page, "次へ").click(); // 3.4 tutorial_complete → Step 4
  await page.waitForURL("**/handson-tour/graduate", { timeout: NAVIGATION_TIMEOUT });
}

/**
 * /api/badges の応答を指定の時間だけ遅らせる (中身は本物の応答のまま、遅らせるだけでモックではない)。
 * バッジの読み込み中の画面 (tour-step-3-loading) は、速い環境では一瞬で消え、確かめようとすると運次第になるため。
 */
export async function delayBadgesApi(page: Page, ms = 1_500): Promise<void> {
  await page.route("**/api/badges", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {
      // 遅らせている間にページが閉じられた (テスト終了) ときは何もしない
    });
  });
}
