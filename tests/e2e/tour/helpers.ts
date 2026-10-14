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
 *     service_role の鍵が無い環境では、ほかの fixture (fixtures/fresh-user.ts・helpers/persona-api.ts) と同じく例外で失敗する。
 *   - ログインした状態は、テスト用のセッション (#1547。helpers/test-session.mjs の createTestSession。パスワードのログインは使わない)
 *     を Cookie に入れて作る。共有のログイン状態 (global-setup の storageState) は使わない (各 spec が EMPTY_STORAGE_STATE にする)。
 *   - ツアー中は全面のオーバーレイ (tour-overlay) が下の画面にかぶさり、Spotlight の対象 (meal-save-button など) は
 *     直接クリックできない。進める操作は吹き出しの tour-next-button で行う (completeStep1〜3)。
 */

import { test as base, expect, type Locator, type Page, type Response } from "@playwright/test";
import { createTestSession, describeTestSessionFailure } from "../helpers/test-session.mjs";
import { cleanupFreshUser, createFreshUser, getAdminClient, injectSession } from "../fixtures/fresh-user";
import { E2E_BASE_URL, EMPTY_STORAGE_STATE, serviceRoleRest } from "../helpers/persona-api";

export { expect, EMPTY_STORAGE_STATE };

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

/** テスト用ユーザーの user_profiles.nickname (Step 0 のタイトルに差し込まれる) */
export const TOUR_USER_NICKNAME = "E2E Test User";

/**
 * 自動で進む段階を待つ上限。いちばん長い Step 1 は intro 2.5 秒 + カメラ 2 秒 + 解析 1.5 秒 + 0.5 秒
 * (packages/handson-tour-shared/src/constants.ts の HANDSON_TOUR_CONSTANTS) で、本番ビルドの初回の描画を含めても足りる長さ
 */
export const AUTO_ADVANCE_TIMEOUT_MS = 20_000;

/** 画面遷移を待つ上限 (本番ビルドの初回の描画・サーバーでのリダイレクトを含めて足りる長さ。ほかの spec と同じ) */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/** 吹き出しの本文が次の段階のものに変わるのを待つ上限 (クリックからの再描画だけなので短い) */
const BUBBLE_CHANGE_TIMEOUT_MS = 10_000;

/**
 * バッジを読み込む間の画面 (tour-step-3-loading) を確かめるときに /api/badges の応答を遅らせる時間。
 * 速い環境では読み込み中の画面が一瞬で消え、確かめようとすると運次第になるため。expect の既定の待ち (10 秒) より十分短い
 */
export const BADGES_API_DELAY_MS = 1_500;

/** 失敗のメッセージに載せる、応答の本文の先頭の長さ */
const ERROR_BODY_PREVIEW_CHARS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Supabase (service_role) の呼び出し
// ─────────────────────────────────────────────────────────────────────────────

/** service_role で 1 テーブルを読む。query は PostgREST のクエリ文字列 (例: `id=eq.xxx&select=roles`) */
export async function selectRows<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
  return serviceRoleRest<T>(`${table}?${query}`, { method: "GET" });
}

/** service_role で 1 行 INSERT する。失敗したら投げる (列名の誤りで行が入らないまま通ることを防ぐ) */
export async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  await serviceRoleRest(table, { method: "POST", body: row });
}

export type TourUser = { id: string; email: string };

/**
 * auth admin API で新規ユーザーを作り、user_profiles に onboarding 完了済みの初期レコードを入れる。
 * onboarding_completed_at があるので、ツアーは「対象 (eligible)」になり /handson-tour が開く。
 *
 * @param profile user_profiles に上書きする列 (例: `{ roles: ["user", "admin"] }`、`{ onboarding_completed_at: null }`)。
 *   service_role の INSERT なので、roles や handson_tour_* などの特権列も入れられる。
 */
export async function createTourUser(prefix: string, profile: Record<string, unknown> = {}): Promise<TourUser> {
  const user = await createFreshUser(getAdminClient(), { emailPrefix: prefix });
  try {
    await insertRow("user_profiles", {
      id: user.id,
      nickname: TOUR_USER_NICKNAME,
      age_group: "30s",
      gender: "unspecified",
      onboarding_completed_at: new Date().toISOString(),
      ...profile,
    });
  } catch (err) {
    // プロフィールを作れなかったユーザーを残さない
    await deleteTourUser(user.id).catch(() => {});
    throw err;
  }
  return { id: user.id, email: user.email };
}

/** auth admin API でユーザーを消す (user_profiles や獲得バッジなど、ユーザーにぶら下がる行も一緒に消える) */
export async function deleteTourUser(userId: string): Promise<void> {
  await cleanupFreshUser(getAdminClient(), userId);
}

/** バッジのマスター (badges) の id。無い code は、静かに無視せず投げる */
async function badgeIdOf(badgeCode: string): Promise<string> {
  const badges = await selectRows<{ id: string }>("badges", `code=eq.${badgeCode}&select=id`);
  if (badges.length !== 1) {
    throw new Error(`[tour/helpers] badges に code=${badgeCode} の行が ${badges.length} 件あります (1 件のはず)`);
  }
  return badges[0].id;
}

/** バッジを直接付与する (前の Step を終えたあとの状態を作る) */
export async function awardBadge(userId: string, badgeCode: string): Promise<void> {
  await insertRow("user_badges", {
    user_id: userId,
    badge_id: await badgeIdOf(badgeCode),
    obtained_at: new Date().toISOString(),
  });
}

/** ユーザーがそのバッジを獲得済みか */
export async function hasBadge(userId: string, badgeCode: string): Promise<boolean> {
  const badgeId = await badgeIdOf(badgeCode);
  const rows = await selectRows("user_badges", `user_id=eq.${userId}&badge_id=eq.${badgeId}&select=badge_id`);
  return rows.length > 0;
}

export type TourProfileRecord = { handson_tour_completed_at: string | null; handson_tour_skipped_at: string | null };

/** ツアーの記録 (完了・スキップの日時) を DB から読む */
export async function readTourProfile(userId: string): Promise<TourProfileRecord> {
  const rows = await selectRows<TourProfileRecord>(
    "user_profiles",
    `id=eq.${userId}&select=handson_tour_completed_at,handson_tour_skipped_at`,
  );
  if (rows.length !== 1) {
    throw new Error(`[tour/helpers] user_profiles に id=${userId} の行が ${rows.length} 件あります (1 件のはず)`);
  }
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// セッション
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ユーザーの access_token (JWT)。API を Bearer で直接呼ぶときに使う。
 * テスト用のセッション (#1547) を管理用の鍵で作る。作れなければ、どの段で失敗したかを付けて投げる (skip にしない)
 */
export async function getAccessToken(user: TourUser): Promise<string> {
  const result = await createTestSession(user.email);
  if (!result.ok) {
    throw new Error(`[tour/helpers] テスト用のセッションを作れませんでした: ${describeTestSessionFailure(result)}`);
  }
  return result.session.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Playwright fixture
// ─────────────────────────────────────────────────────────────────────────────

type TourFixtures = {
  /** テスト用ユーザーを作る。作ったユーザーは、テストが終わったら成否にかかわらず消す */
  createUser: (prefix: string, profile?: Record<string, unknown>) => Promise<TourUser>;
  /** onboarding 完了済み・ツアー未実施の新規ユーザー。page には、このユーザーでログインした状態が入っている */
  tourUser: TourUser;
};

export const test = base.extend<TourFixtures>({
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

  tourUser: async ({ page, createUser }, use) => {
    const user = await createUser("e2e-tour");
    await injectSession(page, user.email);
    await use(user);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/handson-tour/status
// ─────────────────────────────────────────────────────────────────────────────

export type ApiResponseResult = { status: number; body: unknown };

/** 本文を JSON として読む (JSON でなければ文字列のまま) */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 失敗の expect のメッセージ用に、応答の本文の先頭を文字列にする */
export function describeBody(body: unknown): string {
  return (JSON.stringify(body) ?? String(body)).substring(0, ERROR_BODY_PREVIEW_CHARS);
}

/**
 * ツアーの対象かを返す API を、ブラウザの Cookie なしで直接呼ぶ。
 * accessToken があれば Bearer で渡す (モバイルアプリと同じ呼び方)。無ければ未ログインの呼び出し。
 * 失敗 (401 など) も握りつぶさず、ステータスと本文をそのまま返す。判定は呼び出し側の expect で行う。
 */
export async function fetchTourStatus(accessToken?: string): Promise<ApiResponseResult> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const resp = await fetch(new URL("/api/handson-tour/status", E2E_BASE_URL).toString(), { headers });
  return { status: resp.status, body: parseBody(await resp.text()) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ツアーを進める操作
//
// 画面の文言: packages/handson-tour-shared/src/i18n.ts (HANDSON_TOUR_I18N_JA)
// 自動で進む時間: packages/handson-tour-shared/src/constants.ts (HANDSON_TOUR_CONSTANTS)
// ─────────────────────────────────────────────────────────────────────────────

/** ツアーの保存 API の応答を、画面遷移で読めなくなる前にその場で読む */
async function readResponse(response: Response): Promise<ApiResponseResult> {
  const text = await response.text().catch(() => "");
  return { status: response.status(), body: parseBody(text) };
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
  await expect(button).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  const body = page.getByTestId("tour-bubble-body");
  const before = (await body.textContent()) ?? "";
  await button.click({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  await expect(body).not.toHaveText(before, { timeout: BUBBLE_CHANGE_TIMEOUT_MS });
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
    { timeout: NAVIGATION_TIMEOUT_MS },
  );
}

/** ログイン済みのユーザーで Step 0 (ウェルカム) を開く。ボタンを押せる状態になるまで待つ */
export async function openTour(page: Page): Promise<void> {
  await page.goto("/handson-tour");
  await expect(page.getByTestId("tour-step-0")).toBeVisible({ timeout: NAVIGATION_TIMEOUT_MS });
  await waitForReactHandlers(page, "tour-step-0-start");
}

/** Step 0 の「はじめる」を押して Step 1 (写真) へ進む */
export async function startTour(page: Page): Promise<void> {
  await page.getByTestId("tour-step-0-start").click({ timeout: NAVIGATION_TIMEOUT_MS });
  await page.waitForURL("**/handson-tour/photo", { timeout: NAVIGATION_TIMEOUT_MS });
}

/** Step 0 の「あとで」を押して /home へ戻る (openTour のあとに呼ぶ) */
export async function skipTourAtStep0(page: Page): Promise<void> {
  await waitForReactHandlers(page, "tour-step-0-skip");
  await page.getByTestId("tour-step-0-skip").click({ timeout: NAVIGATION_TIMEOUT_MS });
  await page.waitForURL("**/home", { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "commit" });
}

/**
 * Step 1 (/handson-tour/photo) を最後まで進める。
 * intro → カメラ → 解析中 (ここまで自動) → 結果 → [次へ] → [保存] → Step 2 (/handson-tour/menu) へ。
 * 保存の通信 (POST /api/meal-plans/add-from-photo) の応答を返す。
 * 保存が失敗すると、画面はエラー (tour-step-1-error) を出して先へ進まない (設計書 03-step1 §3.10。#1604)。
 * Step 2 への遷移の時間切れで落ちると原因が分からないので、思っていた応答でなければその本文を付けて投げる。
 * @param options.expectedStatus 思っている応答のステータス。既定は成功 (2xx)。設定からのやり直しでは、お試しの保存は
 *   409 sandbox_not_eligible で断られ、画面はエラーにせず Step 2 へ進む (#1604)。そのときは 409 を渡す
 */
export async function completeStep1(
  page: Page,
  options: { expectedStatus?: number } = {},
): Promise<ApiResponseResult> {
  await expect(page.getByTestId("meal-result-dish-name")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  await nextButton(page, "次へ").click({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  // 保存ボタンの Spotlight 段階。meal-save-button 自体はオーバーレイの下なので、押すのは吹き出しの [保存]
  await expect(page.getByTestId("meal-save-button")).toBeVisible();
  const [saved] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/meal-plans/add-from-photo") && r.request().method() === "POST",
      { timeout: NAVIGATION_TIMEOUT_MS },
    ),
    nextButton(page, "保存").click({ timeout: AUTO_ADVANCE_TIMEOUT_MS }),
  ]);
  const result = await readResponse(saved);
  const asExpected = options.expectedStatus === undefined ? saved.ok() : result.status === options.expectedStatus;
  if (!asExpected) {
    throw new Error(
      `[tour/helpers] Step 1 の保存が ${result.status} でした (期待: ${options.expectedStatus ?? "2xx"}): ${describeBody(result.body)}`,
    );
  }
  await page.waitForURL("**/handson-tour/menu", { timeout: NAVIGATION_TIMEOUT_MS });
  return result;
}

/**
 * Step 2 (/handson-tour/menu) を最後まで進める。
 * intro (自動) → 条件フラグ → 自由メモ → [生成する] → ローディング (自動) → 結果 → [次へ] → [献立に追加] → Step 3 (/handson-tour/badges) へ。
 * 追加の通信 (POST /api/menu-plans/add) の応答を返す。
 */
export async function completeStep2(page: Page): Promise<ApiResponseResult> {
  await expect(page.getByTestId("v4-no-cook-toggle")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  await clickNextAndWaitForNextBubble(page, "次へ"); // 2.2 条件フラグ → 2.3 自由メモ
  await clickNextAndWaitForNextBubble(page, "次へ"); // 2.3 自由メモ → 2.4 生成ボタン
  await expect(page.getByTestId("v4-generate-button")).toBeVisible();
  await nextButton(page, "生成する").click({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  await expect(page.getByTestId("v4-result-card")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS }); // 2.5 (自動) → 2.6
  await clickNextAndWaitForNextBubble(page, "次へ"); // 2.6 結果 → 2.7 追加ボタン
  await expect(page.getByTestId("v4-add-to-menu-button")).toBeVisible();
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/menu-plans/add") && r.request().method() === "POST", {
      timeout: NAVIGATION_TIMEOUT_MS,
    }),
    nextButton(page, "献立に追加").click({ timeout: AUTO_ADVANCE_TIMEOUT_MS }),
  ]);
  const result = await readResponse(saved);
  await page.waitForURL("**/handson-tour/badges", { timeout: NAVIGATION_TIMEOUT_MS });
  return result;
}

/**
 * Step 3 (/handson-tour/badges) を最後まで進める。
 * 読み込み → intro (自動) → first_bite → planner → tutorial_complete (それぞれ [次へ]) → Step 4 (/handson-tour/graduate) へ。
 */
export async function completeStep3(page: Page): Promise<void> {
  await expect(page.getByTestId("badge-card-first_bite")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  await clickNextAndWaitForNextBubble(page, "次へ"); // 3.2 first_bite → 3.3 planner (intro は自動)
  await clickNextAndWaitForNextBubble(page, "次へ"); // 3.3 planner → 3.4 tutorial_complete
  await nextButton(page, "次へ").click({ timeout: AUTO_ADVANCE_TIMEOUT_MS }); // 3.4 tutorial_complete → Step 4
  await page.waitForURL("**/handson-tour/graduate", { timeout: NAVIGATION_TIMEOUT_MS });
}

/**
 * /api/badges の応答を指定の時間だけ遅らせる (中身は本物の応答のまま、遅らせるだけでモックではない)。
 * バッジの読み込み中の画面 (tour-step-3-loading) は、速い環境では一瞬で消え、確かめようとすると運次第になるため。
 */
export async function delayBadgesApi(page: Page, ms = BADGES_API_DELAY_MS): Promise<void> {
  await page.route("**/api/badges", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {
      // 遅らせている間にページが閉じられた (テスト終了) ときは何もしない
    });
  });
}
