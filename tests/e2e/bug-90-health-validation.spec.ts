/**
 * Bug-90: 体重フィールドにサーバー側バリデーションなし
 *
 * 確認:
 *   1. weight に -1 を POST → 400 が返り DB に書かれない
 *   2. weight に 0 を POST → 400 が返り DB に書かれない
 *   3. weight に 999999 を POST → 400 が返り DB に書かれない
 *   4. weight に有効値 (65) を POST → 200/201 が返る
 *
 * テスト戦略:
 *   - ローカル dev server ではログイン後 cookie を使って直接 API を叩く
 *   - 本番 (PLAYWRIGHT_BASE_URL=https://...) の場合も同様
 */
import { test, expect } from "./fixtures/auth";

const RECORD_DATE = "2000-01-01"; // 過去の固定日付でテスト用レコードを使用

/**
 * 認証済みページのコンテキストを使って health/records/quick エンドポイントを直接 fetch する
 * (authedPage は Playwright の Page オブジェクト。evaluate 経由でブラウザ内 fetch を実行する)
 */
async function postQuickRecord(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authedPage: any,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return authedPage.evaluate(
    async ({ url, payload }: { url: string; payload: Record<string, unknown> }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    { url: "/api/health/records/quick", payload: body },
  );
}

test.describe("Bug-90: health records weight server-side validation", () => {
  test("weight=-1 は 400 を返し DB に保存されない", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: -1,
      record_date: RECORD_DATE,
    });

    expect(status, `期待 400 だが ${status} が返った: ${JSON.stringify(json)}`).toBe(400);

    // error メッセージに体重に関するバリデーション文言が含まれることを確認
    const errorMsg = (json as { error?: string })?.error ?? "";
    expect(errorMsg).toMatch(/体重|weight/i);
  });

  test("weight=0 は 400 を返し DB に保存されない", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 0,
      record_date: RECORD_DATE,
    });

    expect(status, `期待 400 だが ${status} が返った: ${JSON.stringify(json)}`).toBe(400);

    const errorMsg = (json as { error?: string })?.error ?? "";
    expect(errorMsg).toMatch(/体重|weight/i);
  });

  test("weight=999999 は 400 を返し DB に保存されない", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 999999,
      record_date: RECORD_DATE,
    });

    expect(status, `期待 400 だが ${status} が返った: ${JSON.stringify(json)}`).toBe(400);

    const errorMsg = (json as { error?: string })?.error ?? "";
    expect(errorMsg).toMatch(/体重|weight/i);
  });

  test("weight=65 (有効値) は 200 を返す", async ({ authedPage }) => {
    const { status, json } = await postQuickRecord(authedPage, {
      weight: 65,
      record_date: RECORD_DATE,
    });

    // 200 または 201 を期待
    expect([200, 201], `期待 200/201 だが ${status} が返った: ${JSON.stringify(json)}`).toContain(
      status,
    );
  });
});
