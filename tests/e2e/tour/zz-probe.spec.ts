/**
 * 一時的な調査用 (コミットしない)。
 */
import { test, expect, completeStep1, completeStep2, completeStep3, openTour, startTour } from "./helpers";

test.describe("probe", () => {
  test.setTimeout(150_000);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 640 },
  ]) {
    test(`probe: ${viewport.width}x${viewport.height} で Step 0 から通しで進める`, async ({ page, tourUser }) => {
      const log: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") log.push(`console.error: ${m.text().slice(0, 140)}`);
      });
      page.on("requestfailed", (r) => log.push(`requestfailed: ${r.url().slice(0, 100)} ${r.failure()?.errorText}`));
      page.on("response", (r) => {
        if (r.url().includes("/handson-tour/graduate") || r.url().includes("_rsc")) log.push(`response ${r.status()} ${r.url().slice(0, 100)}`);
      });
      await page.setViewportSize(viewport);
      await openTour(page);
      await startTour(page);
      let stage = "step1";
      try {
        await completeStep1(page);
        stage = "step2";
        await completeStep2(page);
        stage = "step3";
        await completeStep3(page);
        stage = "step4";
        await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: 20_000 });
        console.log(`PROBE ${viewport.width}x${viewport.height}: 卒業画面まで到達`);
      } catch (e) {
        const overlay = await page.getByTestId("tour-overlay").count();
        console.log(
          `PROBE ${viewport.width}x${viewport.height}: ${stage} で失敗 url=${page.url()} overlay=${overlay} err=${String(e).slice(0, 120)} log=${JSON.stringify(log.slice(-12))}`,
        );
        throw e;
      }
      expect(tourUser.id).toBeTruthy();
    });
  }
});
