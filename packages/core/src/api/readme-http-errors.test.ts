import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpClient } from "./httpClient";

/**
 * #1049 F7-12 / 整合ゲート: packages/core/README.md の「HTTP client のタイムアウトとリトライ」の節が、
 * HTTP のエラーの形を実際の動きどおりに書いていることを確かめる。
 * 成功の応答 (2xx) でも本文が JSON として読めないときは、エラー応答 (4xx / 5xx) と同じ
 * `HTTP <status> <statusText>: <本文>` の Error になる (SyntaxError ではない)。README にこの 1 行が無かった。
 */

const README = fs.readFileSync(path.resolve(__dirname, "../../README.md"), "utf8");
const HTTP_SECTION = README.slice(README.indexOf("## HTTP client のタイムアウトとリトライ"), README.indexOf("## 含めないもの"));
const ERROR_SHAPE = "`HTTP <status> <statusText>: <本文>`";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("packages/core/README.md の HTTP のエラーの節 (#1049 F7-12)", () => {
  it("節を拾えている", () => {
    expect(HTTP_SECTION.length).toBeGreaterThan(0);
    expect(HTTP_SECTION).toContain("HTTP のエラー応答 (4xx / 5xx)");
  });

  it("2xx で JSON が読めないときも、エラー応答と同じ形の Error になると書いている", () => {
    const line = HTTP_SECTION.split("\n").find((l) => l.includes("2xx") && l.includes("JSON として読めない"));
    expect(line).toBeDefined();
    expect(line).toContain(ERROR_SHAPE);
    expect(line).toContain("SyntaxError");
  });

  it("書いてあるとおりに動く: 2xx の HTML は README の形の Error (元の SyntaxError は cause)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("<html>login</html>", { status: 200, statusText: "OK", headers: { "Content-Type": "text/html" } }),
    ) as unknown as typeof fetch;
    const client = createHttpClient({ baseUrl: "https://api.example.com", retry: false });

    const error = await client.get("/x").then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toBe("HTTP 200 OK: <html>login</html>");
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
  });
});
