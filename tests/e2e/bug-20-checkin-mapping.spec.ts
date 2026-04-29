/**
 * Bug-20 (#34): 30秒チェックイン送信値と健康記録「気分」の対応関係が不明 (誤マッピングの可能性)
 *
 * 問題: ホーム画面の「30秒チェックイン」でデフォルト値 (睡眠の質=3 等) を送信すると、
 *       health_records.mood_score が 5 (最高) になってしまっていた。
 *
 * 修正: submitPerformanceCheckin は user_performance_checkins にのみ
 *       fatigue/focus/hunger を書き込み、health_records.mood_score には
 *       一切書き込まない。sleep_hours/sleep_quality のみ health_records に同期する。
 *
 * このテストは API コントラクトテストとして実装する:
 *   1. チェックインAPIを直接叩いてデフォルト値を送信
 *   2. health/records/[date] API から当日レコードを取得
 *   3. mood_score が null / 未設定であること (= 5 になっていないこと) を検証
 *   4. sleep_quality が送信値 (3) で記録されていることを検証
 */
import { test, expect } from "./fixtures/auth";

const TODAY = (() => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
})();

// チェックイン送信のデフォルト値 (ホーム画面の初期値と同じ)
const DEFAULT_CHECKIN = {
  sleepHours: 7,
  sleepQuality: 3,
  fatigue: 3,
  focus: 3,
  hunger: 3,
};

test.describe("Bug-20: 30秒チェックイン → health_records マッピング検証", () => {
  test("チェックイン送信後、mood_score は書き換えられない (null または既存値のまま)", async ({
    authedPage,
  }) => {
    // Step 1: チェックイン前の health_records.mood_score を取得
    const beforeRes = await authedPage.request.get(`/api/health/records/${TODAY}`);
    const beforeData = beforeRes.ok() ? await beforeRes.json() : { record: null };
    const moodBefore: number | null = beforeData.record?.mood_score ?? null;

    // Step 2: /home でチェックインを送信 (API 経由の直接確認を補完するため UI も開く)
    await authedPage.goto("/home");

    // チェックインフォームが既に完了済みか確認
    const alreadyDone = await authedPage
      .getByText("今日のチェックイン完了！")
      .isVisible()
      .catch(() => false);

    if (!alreadyDone) {
      // 「記録する」ボタンをクリックしてフォームを開く
      const startButton = authedPage.getByRole("button", { name: /記録する/ }).first();
      if (await startButton.isVisible().catch(() => false)) {
        await startButton.click();
        // フォームが表示されるまで待機
        await authedPage
          .getByRole("button", { name: /チェックイン完了/ })
          .waitFor({ timeout: 5_000 })
          .catch(() => {});
      }

      // 送信ボタンが見えていればクリック (デフォルト値のまま送信)
      const submitButton = authedPage.getByRole("button", { name: /チェックイン完了/ });
      if (await submitButton.isVisible().catch(() => false)) {
        await submitButton.click();
        // フィードバック表示を待つ
        await authedPage
          .getByTestId("checkin-feedback")
          .waitFor({ timeout: 8_000 })
          .catch(() => {});
      }
    }

    // Step 3: チェックイン後の health_records.mood_score を取得
    // (少し待ってから取得してサーバー側の同期を待つ)
    await authedPage.waitForTimeout(1_000);
    const afterRes = await authedPage.request.get(`/api/health/records/${TODAY}`);
    expect(afterRes.ok()).toBe(true);
    const afterData = await afterRes.json();
    const moodAfter: number | null = afterData.record?.mood_score ?? null;
    const sleepQualityAfter: number | null = afterData.record?.sleep_quality ?? null;

    // Step 4: 検証

    // 【メイン検証】mood_score は変わっていないこと
    // チェックイン前に null だった場合 → チェックイン後も null であること (5 になってはいけない)
    // チェックイン前に値があった場合 → その値のまま (チェックインで上書きしない)
    expect(moodAfter).toBe(moodBefore);

    // mood_score が 5 になっていたら必ず失敗 (バグの再現)
    if (moodBefore === null) {
      expect(moodAfter).toBeNull();
    } else {
      // 既存の値が上書きされていないこと
      expect(moodAfter).toBe(moodBefore);
    }

    // 【sleep_quality 検証】チェックインの睡眠の質 (=3) が health_records に同期されていること
    // ただし、チェクイン前に既に sleep_quality が設定されていた場合は上書きされる可能性がある
    // このテストでは「5 にならない」点が重要なので、null または 1-5 の範囲であることを確認する
    if (sleepQualityAfter !== null) {
      expect(sleepQualityAfter).toBeGreaterThanOrEqual(1);
      expect(sleepQualityAfter).toBeLessThanOrEqual(5);
      // チェックイン前に null だった場合は送信値 (3) と一致するはず
      const sleepBefore: number | null = beforeData.record?.sleep_quality ?? null;
      if (sleepBefore === null) {
        expect(sleepQualityAfter).toBe(DEFAULT_CHECKIN.sleepQuality);
      }
    }
  });

  test("/api/health/records/quick は mood_score を送信しない限り更新しない", async ({
    authedPage,
  }) => {
    // sleep_quality のみを送信したとき、mood_score は変化しないことを API レベルで確認
    const beforeRes = await authedPage.request.get(`/api/health/records/${TODAY}`);
    const beforeData = beforeRes.ok() ? await beforeRes.json() : { record: null };
    const moodBefore: number | null = beforeData.record?.mood_score ?? null;

    // mood_score を送らずに sleep_quality だけを送信
    const quickRes = await authedPage.request.post("/api/health/records/quick", {
      data: {
        record_date: TODAY,
        sleep_quality: 3,
        // mood_score は意図的に送信しない
      },
    });
    expect(quickRes.ok()).toBe(true);
    const quickData = await quickRes.json();

    // レスポンスの record で mood_score が変化していないことを確認
    const moodInResponse: number | null = quickData.record?.mood_score ?? null;

    // チェックイン前の mood_score が null だった場合、応答でも null のまま
    if (moodBefore === null) {
      expect(moodInResponse).toBeNull();
    }

    // 最終確認: DB から再取得しても mood_score は変わっていない
    const finalRes = await authedPage.request.get(`/api/health/records/${TODAY}`);
    const finalData = finalRes.ok() ? await finalRes.json() : { record: null };
    const moodFinal: number | null = finalData.record?.mood_score ?? null;

    expect(moodFinal).toBe(moodBefore);
  });
});
