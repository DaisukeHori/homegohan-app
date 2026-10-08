// @vitest-environment node
/**
 * tests/e2e/global-setup.ts が、パスワードを環境変数からだけ取ることの単体テスト (#1114 #1272)
 *
 * 単一ユーザーモード (E2E_USER_EMAIL が e2e-user-NN@homegohan.test 以外) でも、
 * マルチユーザーモード (e2e-user-01〜04) でも、パスワードが環境変数に無いときに既定値でログインしようとしない。
 * E2E_REQUIRE_LOGIN=1 (CI) では全テストを走らせずに止め、未設定 (ローカル) では警告だけ出して続行する。
 *
 * ブラウザは起動しない (chromium は差し替える)。ファイルの書き込みも差し替えて、リポジトリの tests/e2e/.auth を触らない。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const launch = vi.fn(async () => {
  throw new Error("MOCK_LAUNCH_CALLED");
});

vi.mock("@playwright/test", () => ({
  chromium: { launch: () => launch() },
}));
vi.mock("./e2e/setup/seed-classify-fixtures", () => ({ seedClassifyFixtures: vi.fn() }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  // 保存先の作成・書き込み・リンクの作成だけを差し替える。読み取りは本物のまま
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    symlinkSync: vi.fn(),
    copyFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

// 実在のアカウントやパスワードに見えないテスト用の値
const SINGLE_USER_EMAIL = "someone@example.test";
const PASSWORD = "random-for-this-test-Aa1!";

const config = { projects: [{ use: { baseURL: "http://localhost:3999" } }] } as never;

/** テストの外の環境変数に左右されないよう、関係する変数をいったん全部消す */
function clearCredentialEnv(): void {
  vi.stubEnv("E2E_USER_EMAIL", undefined);
  vi.stubEnv("E2E_USER_PASSWORD", undefined);
  vi.stubEnv("E2E_REQUIRE_LOGIN", undefined);
  for (let i = 1; i <= 10; i++) {
    vi.stubEnv(`E2E_USER_${String(i).padStart(2, "0")}_PASSWORD`, undefined);
  }
}

async function runGlobalSetup(): Promise<void> {
  const mod = await import("./e2e/global-setup");
  await mod.default(config);
}

describe("global-setup: パスワードが環境変数に無いとき、既定値でログインしない", () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    launch.mockClear();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    clearCredentialEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("単一ユーザーモード (E2E_USER_EMAIL が e2e-user-NN@homegohan.test 以外)", () => {
    it("E2E_USER_PASSWORD が無ければ、警告だけ出してログインを試みずに終わる", async () => {
      vi.stubEnv("E2E_USER_EMAIL", SINGLE_USER_EMAIL);
      await runGlobalSetup();
      expect(launch).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        `[global-setup] ${SINGLE_USER_EMAIL} のパスワードが未設定です。E2E_USER_PASSWORD を設定してください (既定値はありません)。 storageState なしで続行します。`,
      ]);
    });

    it("E2E_REQUIRE_LOGIN=1 なら、全テストを走らせずに止める", async () => {
      vi.stubEnv("E2E_USER_EMAIL", SINGLE_USER_EMAIL);
      vi.stubEnv("E2E_REQUIRE_LOGIN", "1");
      await expect(runGlobalSetup()).rejects.toThrowError(
        `[global-setup] ${SINGLE_USER_EMAIL} のパスワードが未設定です。E2E_USER_PASSWORD を設定してください (既定値はありません)。 (E2E_REQUIRE_LOGIN=1)`,
      );
      expect(launch).not.toHaveBeenCalled();
    });

    it("E2E_USER_PASSWORD があれば、そのパスワードでログインを試みる", async () => {
      vi.stubEnv("E2E_USER_EMAIL", SINGLE_USER_EMAIL);
      vi.stubEnv("E2E_USER_PASSWORD", PASSWORD);
      await expect(runGlobalSetup()).rejects.toThrowError("MOCK_LAUNCH_CALLED");
      expect(launch).toHaveBeenCalledTimes(1);
    });
  });

  describe("マルチユーザーモード (e2e-user-01〜04)", () => {
    it("どのユーザーも、個別も共通もパスワードが無ければ、警告だけ出してログインを試みずに終わる", async () => {
      await runGlobalSetup();
      expect(launch).not.toHaveBeenCalled();
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(4);
      expect(messages[0]).toBe(
        "[global-setup] e2e-user-01@homegohan.test のパスワードが未設定です。E2E_USER_01_PASSWORD または E2E_USER_PASSWORD を設定してください (既定値はありません)。 storageState なしで続行します。",
      );
    });

    it("E2E_REQUIRE_LOGIN=1 なら、全テストを走らせずに止める", async () => {
      vi.stubEnv("E2E_REQUIRE_LOGIN", "1");
      await expect(runGlobalSetup()).rejects.toThrowError(
        "[global-setup] e2e-user-01@homegohan.test のパスワードが未設定です。E2E_USER_01_PASSWORD または E2E_USER_PASSWORD を設定してください (既定値はありません)。 (E2E_REQUIRE_LOGIN=1)",
      );
      expect(launch).not.toHaveBeenCalled();
    });

    it("共通の E2E_USER_PASSWORD があれば、ログインを試みる", async () => {
      vi.stubEnv("E2E_USER_PASSWORD", PASSWORD);
      await expect(runGlobalSetup()).rejects.toThrowError("MOCK_LAUNCH_CALLED");
      expect(launch).toHaveBeenCalledTimes(1);
    });
  });
});
