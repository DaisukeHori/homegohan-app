// @vitest-environment node
/**
 * tests/local-ci-slot-test-timeout.test.ts
 * tests/local-ci-slot.test.ts と tests/local-ci-slot-consumers.test.ts の時間切れ (tests/helpers/local-ci-slot-test-timeout.ts) の検査 (#1488)。
 *
 *   - 既定は 60 秒。環境変数 UNIT_SLOT_TEST_TIMEOUT_MS で上書きでき、正の整数でなければ止まる (黙って既定に戻さない)
 *   - 全体の既定 (vitest.config.ts の testTimeout) は変えない (延ばすのはこの 2 本だけ)
 *   - 2 本のファイルが実際にその値を使っていることは、それぞれのファイルの「このファイルの時間切れ (#1488)」が確かめる
 *   - scripts/local-ci.sh は、上書きの環境変数を unit の段まで持ち込む
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config";
import {
  DEFAULT_UNIT_SLOT_TEST_TIMEOUT_MS,
  UNIT_SLOT_TEST_TIMEOUT_ENV,
  resolveUnitSlotTestTimeout,
} from "./helpers/local-ci-slot-test-timeout";

const ROOT = process.cwd();
const LOCAL_CI = "scripts/local-ci.sh";
const SLOT_TEST_FILES = ["tests/local-ci-slot.test.ts", "tests/local-ci-slot-consumers.test.ts"];

/** 既定 (根拠は tests/helpers/local-ci-slot-test-timeout.ts) */
const EXPECTED_DEFAULT_TIMEOUT_MS = 60_000;
/** 上書きに使う値 (既定と違えば何でもよい) */
const OVERRIDE_TIMEOUT_MS = 90_000;

describe("tests/helpers/local-ci-slot-test-timeout.ts の既定と上書き", () => {
  it("環境変数が無ければ 60 秒", () => {
    expect(DEFAULT_UNIT_SLOT_TEST_TIMEOUT_MS).toBe(EXPECTED_DEFAULT_TIMEOUT_MS);
    expect(resolveUnitSlotTestTimeout({})).toBe(EXPECTED_DEFAULT_TIMEOUT_MS);
  });

  it("環境変数で上書きできる。空なら既定", () => {
    expect(resolveUnitSlotTestTimeout({ [UNIT_SLOT_TEST_TIMEOUT_ENV]: String(OVERRIDE_TIMEOUT_MS) })).toBe(OVERRIDE_TIMEOUT_MS);
    expect(resolveUnitSlotTestTimeout({ [UNIT_SLOT_TEST_TIMEOUT_ENV]: " " })).toBe(EXPECTED_DEFAULT_TIMEOUT_MS);
  });

  it("環境変数が正の整数でなければ止まる (黙って既定に戻さない)", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "30s"]) {
      expect(() => resolveUnitSlotTestTimeout({ [UNIT_SLOT_TEST_TIMEOUT_ENV]: bad }), bad).toThrow(UNIT_SLOT_TEST_TIMEOUT_ENV);
    }
  });
});

describe("延ばすのは 2 本のファイルだけ", () => {
  it("全体の設定 (vitest.config.ts) は testTimeout を書かない (vitest の既定のまま)", () => {
    expect(vitestConfig.test?.testTimeout).toBeUndefined();
  });

  it("2 本のファイルは、テストを定義する前に、このファイルの時間切れを vi.setConfig する", () => {
    for (const file of SLOT_TEST_FILES) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      const setConfig = text.indexOf("vi.setConfig({ testTimeout: SLOT_TEST_TIMEOUT_MS });");
      expect(setConfig, file).toBeGreaterThan(-1);
      const firstDescribe = text.search(/^describe\(/m);
      expect(firstDescribe, file).toBeGreaterThan(setConfig);
      // 実際に効いているか (どのテストも全体の既定のまま残っていないか) は、各ファイルの「このファイルの時間切れ (#1488)」が確かめる
      expect(text, file).toContain('describe("このファイルの時間切れ (#1488)"');
    }
  });

  it("scripts/local-ci.sh は、時間切れを上書きする環境変数を子プロセスに持ち込む", () => {
    const text = fs.readFileSync(path.join(ROOT, LOCAL_CI), "utf8");
    const m = /^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(text);
    expect(m, "ENV_ALLOWLIST が無い").not.toBeNull();
    expect((m?.[1] ?? "").split(/\s+/)).toContain(UNIT_SLOT_TEST_TIMEOUT_ENV);
  });
});
