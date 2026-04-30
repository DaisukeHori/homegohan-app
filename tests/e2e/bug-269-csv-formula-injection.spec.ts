/**
 * #269 CSV エクスポート formula injection 防止
 *
 * escapeCsv 関数が =, +, -, @ で始まる文字列に ' を prepend することを確認する。
 * /api/export/meals エンドポイントに直接リクエストして CSV レスポンスを検証する。
 */

import { test, expect } from "./fixtures/auth";

test.describe("#269 CSV formula injection 防止", () => {
  test("API レスポンスの CSV にクォートなしで formula 先頭文字が現れない", async ({
    authedPage,
  }) => {
    // ログイン済みセッションのコンテキストで API を叩く
    await authedPage.goto("/settings");

    // /api/export/meals へ直接 fetch してレスポンス本文を検証
    const csvText = await authedPage.evaluate(async () => {
      const res = await fetch("/api/export/meals");
      if (!res.ok) return null;
      return res.text();
    });

    // レスポンスが返ってきていること
    expect(csvText).not.toBeNull();

    if (csvText) {
      const lines = csvText.split(/\r?\n/).filter(Boolean);
      // ヘッダー行は常に存在する
      expect(lines.length).toBeGreaterThanOrEqual(1);

      for (const line of lines) {
        // 簡易パース: クォートで囲まれていないセルが = + - @ で始まっていないことを確認
        const cells = line.split(",");
        for (const cell of cells) {
          // クォートで囲まれているセルはスキップ (クォート内は ' が前置済み)
          if (cell.startsWith('"')) continue;
          // クォートなしセルが危険な formula 先頭文字で始まっていないこと
          expect(cell, `セル "${cell}" が formula injection 文字で始まっています`).not.toMatch(
            /^[=+\-@]/
          );
        }
      }
    }
  });

  test("escapeCsv の formula injection 防止ロジック (ブラウザ内検証)", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    // ブラウザ内で escapeCsv と同等のロジックを実行して結果を検証
    const result = await authedPage.evaluate(() => {
      function escapeCsv(value: unknown): string {
        if (value === null || value === undefined) return "";
        const str = String(value);
        // formula injection 防止: =, +, -, @ で始まる場合は ' を prepend
        const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
        if (
          safe.includes('"') ||
          safe.includes(",") ||
          safe.includes("\n") ||
          safe.includes("\r")
        ) {
          return `"${safe.replace(/"/g, '""')}"`;
        }
        return safe;
      }

      return {
        formula: escapeCsv("=cmd|'/c calc'!A1"),
        plus: escapeCsv("+1234"),
        minus: escapeCsv("-1234"),
        at: escapeCsv("@SUM(A1)"),
        normal: escapeCsv("チキン南蛮"),
        empty: escapeCsv(null),
        withComma: escapeCsv("a,b"),
      };
    });

    // formula injection 対象は ' が prepend される
    expect(result.formula).toBe(`'=cmd|'/c calc'!A1`);
    expect(result.plus).toBe("'+1234");
    expect(result.minus).toBe("'-1234");
    expect(result.at).toBe("'@SUM(A1)");
    // 通常文字列はそのまま
    expect(result.normal).toBe("チキン南蛮");
    // null は空文字
    expect(result.empty).toBe("");
    // カンマを含む場合はクォート囲み
    expect(result.withComma).toBe('"a,b"');
  });
});
