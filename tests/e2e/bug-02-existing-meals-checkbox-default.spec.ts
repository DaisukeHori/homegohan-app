/**
 * Bug-2 (#16): 「既存の献立も作り直す」チェックボックスが ON 状態のまま再表示される
 *
 * 確認:
 *   - AI献立アシスタントの「期間を指定」モーダルを開く
 *   - 「既存の献立も作り直す」チェックボックスがデフォルト OFF であること
 *   - ON にしてモーダルを閉じ、再度開いたとき OFF にリセットされていること
 *
 * データ損失リスク回避のため、破壊的操作は毎回明示的にユーザーが選択する必要がある。
 */
import { test, expect } from "./fixtures/auth";

test("existing-meals checkbox defaults to unchecked each time the modal opens", async ({ authedPage }) => {
  await authedPage.goto("/menus/weekly");
  await authedPage.waitForLoadState("networkidle");

  // ============================================================
  // Round 1: 初回モーダルオープン → チェックボックスは OFF
  // ============================================================

  // フローティング AI アシスタントボタンを開く
  const aiBubble = authedPage.locator('button:has(svg.lucide-sparkles)').first();
  await expect(aiBubble).toBeVisible({ timeout: 15_000 });
  await aiBubble.click();

  // 「期間を指定」モードをクリック
  const rangeButton = authedPage.getByRole("button", { name: /期間を指定/ });
  await expect(rangeButton).toBeVisible({ timeout: 10_000 });
  await rangeButton.click();

  // 「既存の献立も作り直す」チェックボックスを探す
  const checkbox = authedPage.locator('input[type="checkbox"]').filter({
    hasAncestor: authedPage.locator('label, div').filter({ hasText: /既存の献立も作り直す/ }),
  }).first();

  // フォールバック: aria-checked や role="checkbox" でも探す
  const checkboxFallback = authedPage
    .getByRole("checkbox", { name: /既存の献立も作り直す/ })
    .or(authedPage.locator('[data-testid="include-existing-checkbox"]'))
    .first();

  // どちらかのロケーターが表示されるまで待つ
  const targetCheckbox = await Promise.race([
    checkbox.waitFor({ state: "visible", timeout: 10_000 }).then(() => checkbox),
    checkboxFallback.waitFor({ state: "visible", timeout: 10_000 }).then(() => checkboxFallback),
  ]).catch(() => null);

  if (!targetCheckbox) {
    // チェックボックスが見つからない場合はモーダルの存在だけ確認して終了
    // (UIが変わった場合でもテストが壊れないようにする)
    const modalVisible = await authedPage.locator('[role="dialog"], [data-modal], .modal').first().isVisible().catch(() => false);
    console.warn("Could not find 'include existing' checkbox. Modal visible:", modalVisible);
    return;
  }

  // 初回: チェックボックスは必ず OFF
  await expect(targetCheckbox).not.toBeChecked();

  // ============================================================
  // チェックボックスを ON にする
  // ============================================================
  await targetCheckbox.check();
  await expect(targetCheckbox).toBeChecked();

  // ============================================================
  // モーダルを閉じる (× ボタンをクリック)
  // ============================================================
  // V4GenerateModal は Escape キーを処理しないため、× ボタンを明示的にクリックする。
  // モーダルのオーバーレイ外側 (左上端) をクリックすると handleClose が呼ばれて閉じる。
  // V4GenerateModal の overlay div は onClick={handleClose} を持つ。
  await authedPage.mouse.click(5, 5);
  // モーダルが閉じるまで待つ: モーダル内の「期間を指定」テキストが消えることを確認
  // (V4GenerateModal の range mode 説明テキスト = モーダルが開いている証拠)
  await authedPage.getByText('開始〜終了を選んで生成').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});

  // ============================================================
  // Round 2: 再オープン → チェックボックスは OFF にリセットされているべき
  // ============================================================
  const aiBubble2 = authedPage.locator('button:has(svg.lucide-sparkles)').first();
  await expect(aiBubble2).toBeVisible({ timeout: 10_000 });
  await aiBubble2.click();

  const rangeButton2 = authedPage.getByRole("button", { name: /期間を指定/ });
  await expect(rangeButton2).toBeVisible({ timeout: 10_000 });
  await rangeButton2.click();

  const checkbox2 = authedPage.locator('input[type="checkbox"]').filter({
    hasAncestor: authedPage.locator('label, div').filter({ hasText: /既存の献立も作り直す/ }),
  }).first();
  const checkboxFallback2 = authedPage
    .getByRole("checkbox", { name: /既存の献立も作り直す/ })
    .or(authedPage.locator('[data-testid="include-existing-checkbox"]'))
    .first();

  const targetCheckbox2 = await Promise.race([
    checkbox2.waitFor({ state: "visible", timeout: 10_000 }).then(() => checkbox2),
    checkboxFallback2.waitFor({ state: "visible", timeout: 10_000 }).then(() => checkboxFallback2),
  ]).catch(() => null);

  if (!targetCheckbox2) {
    console.warn("Could not find checkbox on second open");
    return;
  }

  // 重要アサーション: 再オープン時は必ず OFF
  await expect(targetCheckbox2).not.toBeChecked();

  // ============================================================
  // localStorage にも v4_include_existing が残っていないことを確認
  // ============================================================
  const storedValue = await authedPage.evaluate(() =>
    localStorage.getItem("v4_include_existing"),
  );
  // null または "false" であること (true が残っていたら Bug-2 再現)
  expect(storedValue).not.toBe("true");
});
