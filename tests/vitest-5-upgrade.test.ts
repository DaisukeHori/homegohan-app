// @vitest-environment node
/**
 * tests/vitest-5-upgrade.test.ts
 *
 * vitest 5 へ上げたときに変わった既定のうち、このリポジトリが決めた扱いを焼き込む (#1621)。
 *
 *   - test.each / test.for の題名に差し込む値を切り詰めない。vitest 5 は既定で 40 文字に切り詰め、
 *     「止める経路: analyze-meal-photo (食事の写真 → Edge Func…」のように行を見分ける部分が消えた。
 *     単体 (vitest.config.ts) と結合 (vitest.integration.config.ts) の両方の設定で切り詰めを外している。
 *   - モックの呼び出しの記録は、テストごとに消える (vitest 5 の既定 clearMocks: true をそのまま使う)。
 *     前のテストの呼び出しで toHaveBeenCalled が通ってしまう空振りが起きない。
 *
 * 設定は実際に評価して値を得る (文字列を読んで推測しない)。
 */
import { describe, expect, it, test, vi } from "vitest";

import vitestConfig, { TASK_TITLE_VALUE_NO_TRUNCATE } from "../vitest.config";
import integrationConfig from "../vitest.integration.config";

/** vitest 5 の既定の切り詰めの長さ (40 文字) を十分に超える値。末尾の目印まで題名に出ることを確かめる */
const LONG_VALUE_REPEAT = 80;
const TAIL_MARK = "末尾の目印";
const LONG_VALUE = `${"あ".repeat(LONG_VALUE_REPEAT)}${TAIL_MARK}`;
/** 切り詰めたときに vitest が付ける印 */
const TRUNCATION_MARK = "…";

/** 結合テストの設定を評価して test の値を得る (defineConfig に渡した関数を呼ぶ) */
async function evaluateIntegrationTest(): Promise<{ taskTitleValueFormatTruncate?: number }> {
  const resolved =
    typeof integrationConfig === "function" ? await integrationConfig({ mode: "test", command: "serve" }) : integrationConfig;
  return resolved.test ?? {};
}

describe("test.each の題名に差し込む値を切り詰めない (#1621)", () => {
  test.each([LONG_VALUE])("%s の形でも値をそのまま出す", (value) => {
    const name = expect.getState().currentTestName ?? "";
    expect(name).toContain(value);
    expect(name).toContain(TAIL_MARK);
    expect(name).not.toContain(TRUNCATION_MARK);
  });

  test.each([{ label: LONG_VALUE }])("$label の形でも値をそのまま出す", ({ label }) => {
    const name = expect.getState().currentTestName ?? "";
    expect(name).toContain(label);
    expect(name).toContain(TAIL_MARK);
    expect(name).not.toContain(TRUNCATION_MARK);
  });

  it("単体と結合の両方の設定が、切り詰めない値 (0) を置いている", async () => {
    expect(TASK_TITLE_VALUE_NO_TRUNCATE).toBe(0);
    expect(vitestConfig.test?.taskTitleValueFormatTruncate).toBe(TASK_TITLE_VALUE_NO_TRUNCATE);
    const integration = await evaluateIntegrationTest();
    expect(integration.taskTitleValueFormatTruncate).toBe(TASK_TITLE_VALUE_NO_TRUNCATE);
  });
});

describe("モックの呼び出しの記録はテストごとに消える (vitest 5 の既定 clearMocks: true)", () => {
  // ファイルの中のテストは書いた順に 1 本ずつ回る (concurrent を付けていない)。
  // 1 本目で呼んだ記録が、2 本目の始まりには消えていることを確かめる
  const shared = vi.fn();

  it("1 本目: 呼ぶと記録が残る", () => {
    shared("1 本目");
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it("2 本目: 1 本目の呼び出しの記録は消えている (前のテストの記録で toHaveBeenCalled が通らない)", () => {
    expect(shared).not.toHaveBeenCalled();
    expect(vitestConfig.test?.clearMocks).toBeUndefined();
  });
});
