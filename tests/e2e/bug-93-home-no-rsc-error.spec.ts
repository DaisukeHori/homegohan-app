/**
 * Bug-93: /home ロード時に毎回 `Failed to fetch RSC payload for /health` が発生する
 *
 * 原因: /home の <Link href="/health"> に prefetch={false} が付いておらず、
 *       Next.js が /health を RSC prefetch しようとして失敗していた。
 *
 * 修正: <Link href="/health" prefetch={false}> を付与し、prefetch を抑制。
 *
 * このテストでは:
 *   - /home をロードし、コンソールに "Failed to fetch RSC payload for /health" が
 *     出力されないことを確認する。
 */
import { test, expect } from "./fixtures/auth";

test("bug-93: /home load does not emit RSC fetch error for /health", async ({
  authedPage: page,
}) => {
  const rscErrors: string[] = [];

  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      msg.text().includes("Failed to fetch RSC payload") &&
      msg.text().includes("/health")
    ) {
      rscErrors.push(msg.text());
    }
  });

  // /home をロードして networkidle まで待つ (prefetch が走るタイミングを包含)
  await page.goto("/home", { waitUntil: "networkidle" });

  // prefetch は hover 時にも発火するため、/health リンクにホバーしてみる
  const healthLink = page.locator('a[href="/health"]').first();
  const isVisible = await healthLink.isVisible().catch(() => false);
  if (isVisible) {
    await healthLink.hover();
    // 短時間待機して prefetch が走る余地を与える
    await page.waitForTimeout(1000);
  }

  expect(
    rscErrors,
    `RSC error for /health should not appear, but got: ${JSON.stringify(rscErrors)}`,
  ).toHaveLength(0);
});
