// @vitest-environment node
/**
 * tests/e2e/helpers/credentials.ts の単体テスト (#1114 #1272)
 *
 * e2e の認証情報は環境変数からだけ取り、既定のアカウントやパスワードを持たない。
 * 環境変数が無いときに、既定値へ静かに切り替わらず、何が足りないかが分かるエラーで止まることを確かめる。
 * (特定のアカウントのメールアドレスやパスワードがリポジトリに残っていないことは
 *  tests/no-committed-credentials.test.ts が確かめる)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateTestPassword,
  getExistingUserPassword,
  requireE2eUserCredentials,
  requireExistingUserPassword,
} from "./e2e/helpers/credentials";

// 実在のアカウントやパスワードに見えないテスト用の値
const EMAIL = "someone@example.test";
const PASSWORD = "random-for-this-test-Aa1!";

/** テストの外の環境変数に左右されないよう、関係する変数をいったん全部消す */
function clearCredentialEnv(): void {
  vi.stubEnv("E2E_USER_EMAIL", undefined);
  vi.stubEnv("E2E_USER_PASSWORD", undefined);
  for (let i = 1; i <= 10; i++) {
    vi.stubEnv(`E2E_USER_${String(i).padStart(2, "0")}_PASSWORD`, undefined);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireE2eUserCredentials (共通テストユーザー)", () => {
  it("E2E_USER_EMAIL と E2E_USER_PASSWORD が両方あれば、その値を返す", () => {
    clearCredentialEnv();
    vi.stubEnv("E2E_USER_EMAIL", EMAIL);
    vi.stubEnv("E2E_USER_PASSWORD", PASSWORD);
    expect(requireE2eUserCredentials()).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it("両方とも未設定なら、既定のアカウントを使わずにエラーで止まる (両方の名前を示す)", () => {
    clearCredentialEnv();
    expect(() => requireE2eUserCredentials()).toThrowError(/E2E_USER_EMAIL.*E2E_USER_PASSWORD/);
  });

  it("E2E_USER_EMAIL だけ未設定なら、E2E_USER_EMAIL が足りないと示す", () => {
    clearCredentialEnv();
    vi.stubEnv("E2E_USER_PASSWORD", PASSWORD);
    let message = "";
    try {
      requireE2eUserCredentials();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("E2E_USER_EMAIL");
    expect(message).not.toContain("E2E_USER_PASSWORD");
    // 環境変数のパスワードの値をエラーに出さない
    expect(message).not.toContain(PASSWORD);
  });

  it("E2E_USER_PASSWORD だけ未設定なら、E2E_USER_PASSWORD が足りないと示す", () => {
    clearCredentialEnv();
    vi.stubEnv("E2E_USER_EMAIL", EMAIL);
    let message = "";
    try {
      requireE2eUserCredentials();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("E2E_USER_PASSWORD");
    expect(message).not.toContain("E2E_USER_EMAIL");
  });

  it("空文字は未設定として扱う (.env.example の `E2E_USER_EMAIL=` のまま使われても既定値に切り替わらない)", () => {
    clearCredentialEnv();
    vi.stubEnv("E2E_USER_EMAIL", "");
    vi.stubEnv("E2E_USER_PASSWORD", "");
    expect(() => requireE2eUserCredentials()).toThrowError(/E2E_USER_EMAIL.*E2E_USER_PASSWORD/);
  });

  it("個別のパスワード (E2E_USER_01_PASSWORD) だけでは足りない (共通のテストユーザーのパスワードは E2E_USER_PASSWORD だけ)", () => {
    clearCredentialEnv();
    vi.stubEnv("E2E_USER_EMAIL", EMAIL);
    vi.stubEnv("E2E_USER_01_PASSWORD", PASSWORD);
    expect(() => requireE2eUserCredentials()).toThrowError(/E2E_USER_PASSWORD/);
  });

  it("モジュールを読み込んだだけでは環境変数を確認しない (未設定でも import は失敗しない)", async () => {
    clearCredentialEnv();
    vi.resetModules();
    await expect(import("./e2e/helpers/credentials")).resolves.toBeDefined();
  });
});

describe("getExistingUserPassword / requireExistingUserPassword (既存アカウントのパスワード)", () => {
  it("個別 (E2E_USER_XX_PASSWORD) が共通 (E2E_USER_PASSWORD) より優先される", () => {
    clearCredentialEnv();
    vi.stubEnv("E2E_USER_PASSWORD", "common-Aa1!");
    vi.stubEnv("E2E_USER_02_PASSWORD", "per-user-Aa1!");
    expect(getExistingUserPassword("02")).toBe("per-user-Aa1!");
    // 個別の値が無い番号は共通の値になる
    expect(getExistingUserPassword("03")).toBe("common-Aa1!");
    // 番号を省略したときは共通の値だけを見る
    expect(getExistingUserPassword()).toBe("common-Aa1!");
  });

  it("どちらも無ければ undefined を返し、require 版は既定値を使わずエラーで止まる", () => {
    clearCredentialEnv();
    expect(getExistingUserPassword("01")).toBeUndefined();
    expect(() => requireExistingUserPassword("01")).toThrowError(/E2E_USER_01_PASSWORD/);
    expect(() => requireExistingUserPassword()).toThrowError(/E2E_USER_PASSWORD/);
  });
});

describe("generateTestPassword (テストの中で新しく作るユーザー用)", () => {
  it("アプリのパスワード要件 (8 文字以上・英大文字・英小文字・数字・記号) を満たす", () => {
    const password = generateTestPassword();
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
  });

  it("呼ぶたびに違う値になる (固定の値を返さない)", () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generateTestPassword()));
    expect(passwords.size).toBe(20);
  });
});
