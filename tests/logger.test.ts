/**
 * tests/logger.test.ts
 *
 * src/lib/db-logger.ts の createLogger / generateRequestId の
 * フォーマット検証とオプションフィールド省略耐性を確認する。
 *
 * Supabase への実際の INSERT は行わない（モックで差し替え）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Supabase クライアントをモック ──────────────────────────────────────────
const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: mockFrom })),
}));

// 環境変数を設定（getSupabaseClient が null を返さないように）
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

// モック設定後にインポート
import { createLogger, generateRequestId } from "../src/lib/db-logger";

// ── テスト ─────────────────────────────────────────────────────────────────

describe("createLogger – フォーマット検証", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockFrom.mockClear();
    // 毎回 mockFrom が { insert } を返すよう再設定
    mockFrom.mockReturnValue({ insert: mockInsert });
  });

  it("error() が app_logs に必須フィールドを含む INSERT を呼び出す", async () => {
    const logger = createLogger("test-route", "req_abc123");
    const err = new Error("something went wrong");

    logger.error("テストエラーが発生しました", err, { foo: "bar" });

    // saveLog は async で fire-and-forget なので少し待つ
    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg).toMatchObject({
      level: "error",
      source: "api-route",
      function_name: "test-route",
      request_id: "req_abc123",
      message: "テストエラーが発生しました",
      error_message: "something went wrong",
      metadata: { foo: "bar" },
    });
    expect(typeof insertArg.error_stack).toBe("string");
  });

  it("warn() は level='warn' で保存される", async () => {
    const logger = createLogger("test-route");
    logger.warn("警告メッセージ", { key: "value" });

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.level).toBe("warn");
    expect(insertArg.message).toBe("警告メッセージ");
    expect(insertArg.metadata).toEqual({ key: "value" });
  });

  it("withUser() が user_id を含める", async () => {
    // #1171: app_logs.user_id は uuid 列なので、uuid の形をした値だけが user_id として保存される
    const userId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const logger = createLogger("test-route").withUser(userId);
    logger.error("ユーザーエラー", new Error("user error"));

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.user_id).toBe(userId);
    expect(insertArg.error_message).toBe("user error");
  });

  it("withUser() に uuid でない値を渡しても、user_id を省略してログ自体は保存する (#1171)", async () => {
    // uuid 列 + auth.users への外部キーなので、"unknown" のような値を入れると insert が失敗してログごと捨てられていた
    const logger = createLogger("test-route").withUser("unknown");
    logger.error("ユーザー不明のエラー", new Error("no user"));

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.user_id).toBeUndefined();
    expect(insertArg.message).toBe("ユーザー不明のエラー");
    expect(insertArg.error_message).toBe("no user");
  });

  it("metadata が undefined でも INSERT が失敗しない", async () => {
    const logger = createLogger("test-route");
    // metadata を渡さない
    logger.error("エラー（メタデータなし）", new Error("bare error"));

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.level).toBe("error");
    // metadata を渡さなかった場合、プロパティが無いか undefined であることを確認
    expect(insertArg.metadata == null).toBe(true);
  });

  it("request_id を省略しても動作する（オプションフィールドの省略耐性）", async () => {
    const logger = createLogger("no-request-id-route");
    logger.info("情報メッセージ");

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.level).toBe("info");
    expect(insertArg.request_id).toBeUndefined();
  });

  it("error に Error 以外（文字列）を渡しても crash しない", async () => {
    const logger = createLogger("test-route");
    logger.error("エラー（文字列）", "string error value");

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.error_message).toBe("string error value");
    expect(insertArg.error_stack).toBeUndefined();
  });
});

// ── #1171: app_logs に保存する前の秘密情報マスキング ───────────────────────────
// 秘密情報に見える文字列は、リポジトリのシークレットスキャンに誤検知されないよう実行時に組み立てる
const FAKE_JWT = ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join("");
const FAKE_OPENAI_KEY = ["sk-", "proj-", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join("");

describe("createLogger – app_logs 保存前の秘密情報マスキング (#1171)", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockFrom.mockClear();
    mockFrom.mockReturnValue({ insert: mockInsert });
  });

  it("error(): error_message と error_stack に混入したトークンとパスワードをマスクして保存する", async () => {
    const logger = createLogger("x");
    logger.error("m", new Error(`boom Bearer ${FAKE_JWT} password=hunter2`));

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.error_message).toBe("boom Bearer *** password=***");
    expect(insertArg.error_message).not.toContain("hunter2");
    // スタックの 1 行目にはエラーメッセージが入る
    expect(typeof insertArg.error_stack).toBe("string");
    expect(insertArg.error_stack).not.toContain("hunter2");
    expect(insertArg.error_stack).not.toContain("eyJ");
    expect(insertArg.error_stack).toContain("boom Bearer *** password=***");
  });

  it("error(): message の中の秘密情報もマスクする", async () => {
    createLogger("x").error(`DB 接続に失敗: postgresql://postgres:hunter2@db.example.com:5432/postgres`, new Error("connect failed"));

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.message).toBe("DB 接続に失敗: postgresql://postgres:***@db.example.com:5432/postgres");
  });

  it("info / warn: message と、metadata の文字列の値 (キー名が無関係でも) をマスクする", async () => {
    const logger = createLogger("x");
    logger.warn(`upstream rejected ${FAKE_OPENAI_KEY}`, { error: `Incorrect API key: ${FAKE_OPENAI_KEY}`, status: 401 });

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.message).toBe("upstream rejected ***");
    expect(insertArg.metadata).toEqual({ error: "Incorrect API key: ***", status: 401 });
  });

  it("error(): metadata の文字列の値の中のキーもマスクする", async () => {
    createLogger("x").error("m", new Error("e"), { error: `... ${FAKE_OPENAI_KEY}`, nested: { list: [`password=hunter2`] } });

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.metadata).toEqual({ error: "... ***", nested: { list: ["password=***"] } });
  });

  it("withUser().error(): ユーザー付きの経路でもマスクする。user_id はそのまま残る", async () => {
    const userId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    createLogger("x").withUser(userId).error("m", new Error("token=abc123 failed"), { note: "ok" });

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.user_id).toBe(userId);
    expect(insertArg.error_message).toBe("token=*** failed");
    expect(insertArg.metadata).toEqual({ note: "ok" });
  });

  it("極端に長い message / error_message / error_stack は切り詰めて保存する", async () => {
    createLogger("x").error("m".repeat(10_000), new Error("e".repeat(10_000)));

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.message.length).toBeLessThan(2100);
    expect(insertArg.error_message.length).toBeLessThan(2100);
    expect(insertArg.error_stack.length).toBeLessThan(8100);
    expect(insertArg.message.endsWith("…[truncated]")).toBe(true);
  });

  it("insert する行は app_logs の列だけで構成される", async () => {
    createLogger("x", "req_1").error("m", new Error("e"), { a: 1 });

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    const columns = ["error_message", "error_stack", "function_name", "level", "message", "metadata", "request_id", "source", "user_id"];
    for (const key of Object.keys(insertArg)) expect(columns).toContain(key);
    expect(insertArg).toMatchObject({ level: "error", source: "api-route", function_name: "x", request_id: "req_1", message: "m" });
  });
});

describe("generateRequestId", () => {
  it("req_ プレフィックスを持つ文字列を返す", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_\d+_[a-z0-9]+$/);
  });

  it("呼び出すたびに異なる ID を生成する", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateRequestId()));
    expect(ids.size).toBe(10);
  });
});
