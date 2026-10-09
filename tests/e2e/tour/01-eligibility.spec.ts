/**
 * tests/e2e/tour/01-eligibility.spec.ts
 *
 * /api/handson-tour/status API のレスポンス reason 検証。
 * 未ログイン / onboarding 未完 / 完了 / 既存活動有り / admin / スキップ済 / 完了済 / 通常新規
 *
 * 注意: 実 API を叩く E2E。API モックは使用しない。
 * ブラウザは使わず、ユーザーの JWT を Bearer で渡して直接呼ぶ (モバイルアプリと同じ呼び方)。
 * 以前は「API が未実装の可能性」などの理由で test.skip にしていたが、API は実在し、ローカルの
 * Supabase に対して動く。失敗は skip にせず、ステータスと本文を付けて落とす (#846)。
 */

import { appBaseUrl, test, expect, fetchTourStatus, getAccessToken, insertRow, selectRows } from "./helpers";

test.describe("Tour - Eligibility API", () => {
  test.setTimeout(60_000);

  test("未ログインは 401 (unauthorized)", async ({ baseURL }) => {
    const res = await fetchTourStatus(appBaseUrl(baseURL));

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "unauthorized" } });
  });

  test("onboarding 未完のユーザーは reason=onboarding_not_completed", async ({ createUser, baseURL }) => {
    const user = await createUser("e2e-tour-eligi-noob", { onboarding_completed_at: null });

    const res = await fetchTourStatus(appBaseUrl(baseURL), await getAccessToken(user));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ should_show: false, reason: "onboarding_not_completed" });
  });

  test("onboarding 完了済のユーザーは reason=eligible (通常新規)", async ({ createUser, baseURL }) => {
    const user = await createUser("e2e-tour-eligi-new");

    const res = await fetchTourStatus(appBaseUrl(baseURL), await getAccessToken(user));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      should_show: true,
      reason: "eligible",
      completed_at: null,
      skipped_at: null,
    });
  });

  test("ハンズオンツアー完了済ユーザーは reason=already_completed", async ({ createUser, baseURL }) => {
    const completedAt = new Date().toISOString();
    const user = await createUser("e2e-tour-eligi-done", { handson_tour_completed_at: completedAt });

    const res = await fetchTourStatus(appBaseUrl(baseURL), await getAccessToken(user));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ should_show: false, reason: "already_completed" });
    // 完了日時は DB の値がそのまま返る
    const { completed_at } = res.body as { completed_at: string };
    expect(new Date(completed_at).getTime()).toBe(new Date(completedAt).getTime());
  });

  test("スキップ済ユーザーは reason=already_skipped", async ({ createUser, baseURL }) => {
    const skippedAt = new Date().toISOString();
    const user = await createUser("e2e-tour-eligi-skip", { handson_tour_skipped_at: skippedAt });

    const res = await fetchTourStatus(appBaseUrl(baseURL), await getAccessToken(user));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ should_show: false, reason: "already_skipped" });
    const { skipped_at } = res.body as { skipped_at: string };
    expect(new Date(skipped_at).getTime()).toBe(new Date(skippedAt).getTime());
  });

  test("admin ロールユーザーは reason=admin_role", async ({ createUser, baseURL }) => {
    const user = await createUser("e2e-tour-eligi-admin", { roles: ["user", "admin"] });

    const res = await fetchTourStatus(appBaseUrl(baseURL), await getAccessToken(user));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ should_show: false, reason: "admin_role" });
  });

  test("既存活動有りユーザーは reason=existing_user_auto_skip (以後は already_skipped)", async ({
    createUser,
    baseURL,
  }) => {
    const user = await createUser("e2e-tour-eligi-existing");
    // ツアーのお試し (is_sandbox = true) ではない、本物の食事の記録がある = すでに使っているユーザー。
    // user_has_non_sandbox_activity() が user_daily_meals の is_sandbox = false の行を見る
    await insertRow("user_daily_meals", {
      user_id: user.id,
      day_date: new Date().toISOString().slice(0, 10),
      is_sandbox: false,
    });
    const token = await getAccessToken(user);
    const url = appBaseUrl(baseURL);

    const first = await fetchTourStatus(url, token);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ should_show: false, reason: "existing_user_auto_skip" });
    const { skipped_at } = first.body as { skipped_at: string | null };
    expect(skipped_at).not.toBeNull();

    // 判定したときに、スキップ済みとして DB にも記録される (次からはツアーを出さない)
    const [profile] = await selectRows<{ handson_tour_skipped_at: string | null }>(
      "user_profiles",
      `id=eq.${user.id}&select=handson_tour_skipped_at`,
    );
    expect(profile.handson_tour_skipped_at).not.toBeNull();

    const second = await fetchTourStatus(url, token);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ should_show: false, reason: "already_skipped" });
  });
});
