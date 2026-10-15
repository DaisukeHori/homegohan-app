// @vitest-environment node
/**
 * tests/local-ci-slot-test-timeout.test.ts
 * tests/local-ci-slot.test.ts・tests/local-ci-slot-consumers.test.ts (#1488)・tests/mobile-easignore-bundle-inputs.test.ts (#1605) の
 * 時間切れ (tests/helpers/local-ci-slot-test-timeout.ts) の検査。
 *
 *   - 既定は 60 秒。環境変数 UNIT_SLOT_TEST_TIMEOUT_MS で上書きでき、正の整数でなければ止まる (黙って既定に戻さない)
 *   - 全体の既定 (vitest.config.ts の testTimeout) は変えない (延ばすのはこの 3 本だけ)
 *   - フック (beforeAll・afterAll など) を持つファイルは、フックの時間切れも同じ値にする (#1605。afterAll がフックの既定の 10 秒で落ちた)
 *   - 3 本のファイルが実際にその値を使っていることは、それぞれのファイルの「このファイルの時間切れ (#1488 / #1605)」が確かめる
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
const SLOT_TEST_FILES = [
  "tests/local-ci-slot.test.ts",
  "tests/local-ci-slot-consumers.test.ts",
  "tests/mobile-easignore-bundle-inputs.test.ts",
];
/** ファイルの時間切れを設定する行 (フックの時間切れは任意。フックがあるファイルは必須) */
const SET_CONFIG_LINE = /^vi\.setConfig\(\{ testTimeout: SLOT_TEST_TIMEOUT_MS(, hookTimeout: SLOT_TEST_TIMEOUT_MS)? \}\);$/m;
/** フックの登録 (行頭。字下げを含む)。フックは時間切れを設定してから登録する */
const HOOK_REGISTRATION = /^\s*(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/m;
/** 各ファイルの、時間切れが実際に効いているかを確かめる describe の見出し */
const SELF_CHECK_DESCRIBE = /^describe\(["']このファイルの時間切れ \(#\d+\)["']/m;

/** 既定 (根拠は tests/helpers/local-ci-slot-test-timeout.ts) */
const EXPECTED_DEFAULT_TIMEOUT_MS = 60_000;
/** 上書きに使う値 (既定と違えば何でもよい) */
const OVERRIDE_TIMEOUT_MS = 90_000;

/** フックの時間切れの設定の問題 (無ければ空)。フックがあるなら hookTimeout も同じ値で、最初のフックより前に設定する */
function hookProblems(file: string, text: string): string[] {
  const m = SET_CONFIG_LINE.exec(text);
  if (!m) return [`${file}: vi.setConfig({ testTimeout: SLOT_TEST_TIMEOUT_MS ... }) が無い`];
  const hook = HOOK_REGISTRATION.exec(text);
  if (!hook) return [];
  const name = hook[0].replace(/[\s(]/g, "");
  const problems: string[] = [];
  if (m[1] === undefined) problems.push(`${file}: フック (${name}) があるのに hookTimeout を設定していない`);
  if (hook.index < m.index) problems.push(`${file}: 時間切れを設定する前にフック (${name}) を登録している`);
  return problems;
}

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

describe("延ばすのは 3 本のファイルだけ", () => {
  it("全体の設定 (vitest.config.ts) は testTimeout を書かない (vitest の既定のまま)", () => {
    expect(vitestConfig.test?.testTimeout).toBeUndefined();
  });

  it("3 本のファイルは、テストを定義する前に、このファイルの時間切れを vi.setConfig する", () => {
    for (const file of SLOT_TEST_FILES) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      const m = SET_CONFIG_LINE.exec(text);
      expect(m, file).not.toBeNull();
      const setConfig = m?.index ?? -1;
      const firstDescribe = text.search(/^describe\(/m);
      expect(firstDescribe, file).toBeGreaterThan(setConfig);
      // フックを持つファイルは、フックの時間切れも同じ値にし、最初のフックより前で設定する
      // (beforeAll で bash を起動する #1496・afterAll で一時の git リポジトリを消す #1605。フックの既定の 10 秒で落ちた)
      expect(hookProblems(file, text)).toEqual([]);
      // 実際に効いているか (どのテストも全体の既定のまま残っていないか) は、各ファイルの「このファイルの時間切れ (#1488 / #1605)」が確かめる
      expect(SELF_CHECK_DESCRIBE.test(text), file).toBe(true);
    }
  });

  it("フックの検査は、hookTimeout の欠け (afterAll だけのファイルを含む)・設定より前のフックを見つける", () => {
    const both = "vi.setConfig({ testTimeout: SLOT_TEST_TIMEOUT_MS, hookTimeout: SLOT_TEST_TIMEOUT_MS });\n";
    const testOnly = "vi.setConfig({ testTimeout: SLOT_TEST_TIMEOUT_MS });\n";
    expect(hookProblems("ok", `${both}afterAll(() => {});\n`)).toEqual([]);
    expect(hookProblems("no-hook", `${testOnly}describe("a", () => {});\n`)).toEqual([]);
    expect(hookProblems("after-all", `${testOnly}describe("a", () => {\n  afterAll(() => {});\n});\n`).join()).toContain("hookTimeout");
    expect(hookProblems("before-each", `${testOnly}beforeEach(() => {});\n`).join()).toContain("hookTimeout");
    expect(hookProblems("early", `beforeAll(() => {});\n${both}`).join()).toContain("前にフック");
    expect(hookProblems("missing", "describe(\"a\", () => {});\n").join()).toContain("vi.setConfig");
  });

  it("scripts/local-ci.sh は、時間切れを上書きする環境変数を子プロセスに持ち込む", () => {
    const text = fs.readFileSync(path.join(ROOT, LOCAL_CI), "utf8");
    const m = /^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(text);
    expect(m, "ENV_ALLOWLIST が無い").not.toBeNull();
    expect((m?.[1] ?? "").split(/\s+/)).toContain(UNIT_SLOT_TEST_TIMEOUT_ENV);
  });
});
