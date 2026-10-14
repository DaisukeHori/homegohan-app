import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { verifyRequestOwnership } from "../supabase/functions/_shared/request-ownership.ts";

// #1240: regenerate-shopping-list-v2 は service role (RLS の対象外) で shopping_list_requests を更新する。
// body の requestId の持ち主を確かめずに書き込むと、他人のジョブ行 (status / progress / shopping_list_id) を
// 書き換えられる (IDOR)。書き込みの前に verifyRequestOwnership で確かめ、他人の行と存在しない行は 404 にする。

type Client = Parameters<typeof verifyRequestOwnership>[0];

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ table: string; columns?: string; eq?: [string, unknown] }> = [];
  const client = {
    from(table: string) {
      const call: { table: string; columns?: string; eq?: [string, unknown] } = { table };
      calls.push(call);
      return {
        select(columns: string) {
          call.columns = columns;
          return {
            eq(column: string, value: unknown) {
              call.eq = [column, value];
              return { maybeSingle: async () => result };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as Client, calls };
}

describe("verifyRequestOwnership (#1240)", () => {
  it("RO-1: 本人の行なら ok。id で 1 行だけ user_id を読む", async () => {
    const { client, calls } = fakeClient({ data: { user_id: OWNER }, error: null });
    await expect(verifyRequestOwnership(client, "shopping_list_requests", REQUEST_ID, OWNER)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ table: "shopping_list_requests", columns: "user_id", eq: ["id", REQUEST_ID] }]);
  });

  it("RO-2: 他人の行なら not_owner", async () => {
    const { client } = fakeClient({ data: { user_id: OTHER }, error: null });
    await expect(verifyRequestOwnership(client, "shopping_list_requests", REQUEST_ID, OWNER)).resolves.toEqual({
      ok: false,
      reason: "not_owner",
    });
  });

  it("RO-3: 行が無ければ not_found", async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(verifyRequestOwnership(client, "shopping_list_requests", REQUEST_ID, OWNER)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("RO-4: UUID でない requestId は、問い合わせずに not_found", async () => {
    for (const requestId of ["not-a-uuid", "", 123, null, undefined, { id: REQUEST_ID }]) {
      const { client, calls } = fakeClient({ data: { user_id: OWNER }, error: null });
      await expect(verifyRequestOwnership(client, "shopping_list_requests", requestId, OWNER)).resolves.toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(calls).toEqual([]);
    }
  });

  it("RO-5: 問い合わせに失敗したら lookup_failed (書き込みには進まない)", async () => {
    const { client } = fakeClient({ data: null, error: { message: "connection reset" } });
    await expect(verifyRequestOwnership(client, "shopping_list_requests", REQUEST_ID, OWNER)).resolves.toEqual({
      ok: false,
      reason: "lookup_failed",
      message: "connection reset",
    });
  });
});

// Edge Function 本体は Deno 専用の import を含み Vitest では読み込めないため、ソースで配線を確かめる
describe("regenerate-shopping-list-v2 の配線 (#1240)", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../supabase/functions/regenerate-shopping-list-v2/index.ts"),
    "utf8",
  );

  it("RO-6: 処理を始める前に requestId の所有権を確かめ、確認できなければ 404 / 500 で返す", () => {
    const check = source.indexOf('verifyRequestOwnership(supabase, "shopping_list_requests", requestId, userId)');
    const start = source.indexOf("const backgroundTask = processRegeneration(");
    expect(check).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(check);
    const guard = source.slice(check, start);
    expect(guard).toContain("if (!ownership.ok)");
    expect(guard).toContain("status: 404");
    expect(guard).toContain("status: 500");
  });

  it("RO-7: ジョブ行の更新 (進捗・完了・失敗) は id と user_id の両方で絞る", () => {
    for (const fn of ["async function updateProgress(", "async function markCompleted(", "async function markFailed("]) {
      const begin = source.indexOf(fn);
      expect(begin).toBeGreaterThan(-1);
      const body = source.slice(begin, source.indexOf("\n}\n", begin));
      expect(body).toContain('.from("shopping_list_requests")');
      expect(body).toContain('.eq("id", requestId)');
      expect(body).toContain('.eq("user_id", userId)');
    }
  });
});
