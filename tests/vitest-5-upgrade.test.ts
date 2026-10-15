// @vitest-environment node
/**
 * tests/vitest-5-upgrade.test.ts
 *
 * vitest 5 へ上げたときに変わった既定のうち、このリポジトリのテストが前提にするものを焼き込む (#1621)。
 *
 *   - モックの呼び出しの記録は、テストごとに消える (vitest 5 の既定 clearMocks: true。設定では上書きしない)。
 *     前のテストの呼び出しで toHaveBeenCalled / toHaveBeenCalledWith が通ってしまう空振りが起きない。
 *     vitest 4 では記録が残り、消すには各ファイルで vi.clearAllMocks() を呼ぶ必要があった。
 *   - test.each の題名に差し込んだ文字列は引用符で囲まない (vitest 5 の変更)。題名で絞り込む (-t) ときは引用符を付けない。
 *
 * 設定は実際に評価して値を得る (文字列を読んで推測しない)。
 */
import { describe, expect, it, test, vi } from "vitest";

import vitestConfig from "../vitest.config";

describe("モックの呼び出しの記録はテストごとに消える (vitest 5 の既定 clearMocks: true)", () => {
  // ファイルの中のテストは書いた順に 1 本ずつ回る (concurrent を付けていない)。
  // 1 本目で呼んだ記録が、2 本目の始まりには消えていることを確かめる
  const shared = vi.fn();

  it("1 本目: 呼ぶと記録が残る", () => {
    shared("1 本目");
    expect(shared).toHaveBeenCalledTimes(1);
    expect(shared).toHaveBeenCalledWith("1 本目");
  });

  it("2 本目: 1 本目の呼び出しの記録は消えている (前のテストの記録で toHaveBeenCalled が通らない)", () => {
    expect(shared).not.toHaveBeenCalled();
  });

  it("設定 (vitest.config.ts) は clearMocks を上書きしない (vitest 5 の既定 true のまま)", () => {
    expect(vitestConfig.test?.clearMocks).toBeUndefined();
  });
});

describe("test.each の題名に差し込んだ文字列は引用符で囲まない (vitest 5)", () => {
  /** 題名に差し込む値 (引用符で囲まれずにそのまま出ることを確かめる) */
  const ROLE = "super_admin";

  test.each([ROLE])("%s の形", (role) => {
    expect(expect.getState().currentTestName).toBe(
      "test.each の題名に差し込んだ文字列は引用符で囲まない (vitest 5) > super_admin の形",
    );
    expect(role).toBe(ROLE);
  });

  test.each([{ role: ROLE }])("$role の形", ({ role }) => {
    expect(expect.getState().currentTestName).toBe(
      "test.each の題名に差し込んだ文字列は引用符で囲まない (vitest 5) > super_admin の形",
    );
    expect(role).toBe(ROLE);
  });
});
