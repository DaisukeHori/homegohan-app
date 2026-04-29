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
    const userId = "user-uuid-1234";
    const logger = createLogger("test-route").withUser(userId);
    logger.error("ユーザーエラー", new Error("user error"));

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(1));

    const [insertArg] = mockInsert.mock.calls[0];
    expect(insertArg.user_id).toBe(userId);
    expect(insertArg.error_message).toBe("user error");
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
