/**
 * Bug-11 (#29): ホームの「カロリー 1616 kcal」がラベル不明
 *
 * 確認: ホーム「今日の進捗」内で「今日の献立合計」のラベルが kcal 値と並んで見える。
 */
import { test, expect } from "./fixtures/fresh-user";

test("home today's progress shows '今日の献立合計' label next to kcal", async ({ tourPendingUser }) => {
  await tourPendingUser.goto("/home");
  await expect(tourPendingUser.getByText("今日の献立合計", { exact: true })).toBeVisible();
});
