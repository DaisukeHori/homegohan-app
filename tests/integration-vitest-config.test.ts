// @vitest-environment node
/**
 * tests/integration-vitest-config.test.ts
 *
 * 結合テストの vitest の設定 (vitest.integration.config.ts) の時間切れと並列数を検査する。
 *
 *   - 1 件のテストとフックの時間切れの既定は 120 秒 (負荷が高い機械で 30 秒を超えて毎回違うテストが落ちたため延ばした。根拠は設定のコメント)
 *   - 環境変数 INTEGRATION_TEST_TIMEOUT_MS / INTEGRATION_HOOK_TIMEOUT_MS で上書きでき、正の整数でなければ止まる (黙って既定に戻さない)
 *   - ファイルもテストも 1 本ずつ (認証のレート制限と DB の取り合いを避ける。変えると負荷の下でさらに落ちやすくなる)
 *   - scripts/local-ci.sh は、上書きの環境変数を結合テストまで持ち込む (親シェルの環境変数は許した名前しか持ち込まない)
 *
 * 設定は実際に評価して値を得る (文字列を読んで推測しない)。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import integrationConfig, { timeoutFromEnv } from "../vitest.integration.config";

const ROOT = process.cwd();
const LOCAL_CI = "scripts/local-ci.sh";
const TEST_TIMEOUT_ENV = "INTEGRATION_TEST_TIMEOUT_MS";
const HOOK_TIMEOUT_ENV = "INTEGRATION_HOOK_TIMEOUT_MS";
/** 設定の既定 (vitest.integration.config.ts の DEFAULT_INTEGRATION_*_TIMEOUT_MS) */
const EXPECTED_DEFAULT_TIMEOUT_MS = 120_000;
/** 上書きに使う値 (既定と違う値なら何でもよい) */
const OVERRIDE_TEST_TIMEOUT_MS = 45_000;
const OVERRIDE_HOOK_TIMEOUT_MS = 90_000;

type TestOptions = { testTimeout?: number; hookTimeout?: number; maxWorkers?: number | string; maxConcurrency?: number; pool?: string };

/** 設定を評価して test の値を得る (defineConfig に渡した関数を呼ぶ) */
async function evaluate(): Promise<TestOptions> {
  const resolved = typeof integrationConfig === "function" ? await integrationConfig({ mode: "test", command: "serve" }) : integrationConfig;
  return (resolved.test ?? {}) as TestOptions;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vitest.integration.config.ts の時間切れと並列数", () => {
  it("環境変数が無ければ、テストもフックも時間切れは 120 秒", async () => {
    vi.stubEnv(TEST_TIMEOUT_ENV, undefined);
    vi.stubEnv(HOOK_TIMEOUT_ENV, undefined);
    const test = await evaluate();
    expect(test.testTimeout).toBe(EXPECTED_DEFAULT_TIMEOUT_MS);
    expect(test.hookTimeout).toBe(EXPECTED_DEFAULT_TIMEOUT_MS);
  });

  it("環境変数で、テストとフックの時間切れを別々に上書きできる", async () => {
    vi.stubEnv(TEST_TIMEOUT_ENV, String(OVERRIDE_TEST_TIMEOUT_MS));
    vi.stubEnv(HOOK_TIMEOUT_ENV, String(OVERRIDE_HOOK_TIMEOUT_MS));
    const test = await evaluate();
    expect(test.testTimeout).toBe(OVERRIDE_TEST_TIMEOUT_MS);
    expect(test.hookTimeout).toBe(OVERRIDE_HOOK_TIMEOUT_MS);
  });

  it("環境変数が正の整数でなければ、設定の評価で止まる (黙って既定に戻さない)。空なら既定", async () => {
    for (const bad of ["0", "-1", "1.5", "abc", "30s"]) {
      expect(() => timeoutFromEnv({ [TEST_TIMEOUT_ENV]: bad }, TEST_TIMEOUT_ENV, EXPECTED_DEFAULT_TIMEOUT_MS), bad).toThrow(TEST_TIMEOUT_ENV);
    }
    expect(timeoutFromEnv({ [TEST_TIMEOUT_ENV]: " " }, TEST_TIMEOUT_ENV, EXPECTED_DEFAULT_TIMEOUT_MS)).toBe(EXPECTED_DEFAULT_TIMEOUT_MS);
    vi.stubEnv(HOOK_TIMEOUT_ENV, "abc");
    await expect(evaluate()).rejects.toThrow(HOOK_TIMEOUT_ENV);
  });

  it("ファイルもテストも 1 本ずつ回す (並列数 1)", async () => {
    const test = await evaluate();
    expect(test.pool).toBe("forks");
    expect(test.maxWorkers).toBe(1);
    expect(test.maxConcurrency).toBe(1);
  });

  it("scripts/local-ci.sh は、時間切れを上書きする環境変数を子プロセスに持ち込む", () => {
    const text = fs.readFileSync(path.join(ROOT, LOCAL_CI), "utf8");
    const m = /^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(text);
    expect(m, "ENV_ALLOWLIST が無い").not.toBeNull();
    const names = (m?.[1] ?? "").split(/\s+/);
    expect(names).toContain(TEST_TIMEOUT_ENV);
    expect(names).toContain(HOOK_TIMEOUT_ENV);
  });
});
