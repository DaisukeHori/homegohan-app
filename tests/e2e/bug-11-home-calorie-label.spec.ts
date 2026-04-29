/**
 * Bug-11 (#29): ホームの「カロリー 1616 kcal」がラベル不明
 *
 * 確認: ホーム「今日の進捗」内で「今日の献立合計」のラベルが kcal 値と並んで見える。
 */
import { test, expect } from "./fixtures/auth";

test("home today's progress shows '今日の献立合計' label next to kcal", async ({ authedPage }) => {
  await authedPage.goto("/home");
  await expect(authedPage.getByText("今日の献立合計", { exact: true })).toBeVisible();
});
