import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { replaceActiveShoppingList } from "../supabase/functions/_shared/shopping-list-replace.ts";

// #1312: 買い物リストの再生成 (regenerate-shopping-list-v2) は、以前は「今のアクティブなリストを archived にする ->
// 新しいアクティブなリストを INSERT する」を別々の HTTP 呼び出しで行っていた。その間に「レシピから追加」
// (add-recipe) がリストを作ると、INSERT が部分ユニーク索引 idx_shopping_lists_active_unique の 23505 で失敗した。
// 今は DB 関数 replace_active_shopping_list に任せる (アーカイブと INSERT を 1 トランザクションで行い、add-recipe 側の
// get_or_create_active_shopping_list と同じユーザーごとのロックを取る)。
// DB 関数の振る舞い (ロック・原子性・権限) は tests/integration/security/shopping-list-active-lock.test.ts で確かめる。
// ここでは Edge Function 側が関数を正しい引数で呼ぶことと、エラーを握りつぶさないことを確かめる。

type Client = Parameters<typeof replaceActiveShoppingList>[0];

const USER_ID = "11111111-1111-4111-8111-111111111111";
const LIST_ID = "44444444-4444-4444-8444-444444444444";

function fakeClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => result);
  return { client: { rpc } as unknown as Client, rpc };
}

describe("replaceActiveShoppingList (#1312)", () => {
  it("RP-1: replace_active_shopping_list を 1 回だけ呼び、作られたリストの id を返す", async () => {
    const { client, rpc } = fakeClient({ data: LIST_ID, error: null });

    const id = await replaceActiveShoppingList(client, {
      userId: USER_ID,
      startDate: "2026-10-08",
      endDate: "2026-10-14",
      servingsConfig: { default: 2, byDayMeal: {} },
    });

    expect(id).toBe(LIST_ID);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("replace_active_shopping_list", {
      p_user_id: USER_ID,
      p_title: "2026-10-08〜2026-10-14の買い物リスト",
      p_start_date: "2026-10-08",
      p_end_date: "2026-10-14",
      p_servings_config: { default: 2, byDayMeal: {} },
    });
  });

  it("RP-2: 人数設定が無い (undefined / null) ときは、引数を落とさず null を明示して送る", async () => {
    for (const servingsConfig of [undefined, null]) {
      const { client, rpc } = fakeClient({ data: LIST_ID, error: null });

      await replaceActiveShoppingList(client, {
        userId: USER_ID,
        startDate: "2026-10-08",
        endDate: "2026-10-14",
        servingsConfig,
      });

      const args = rpc.mock.calls[0][1];
      // undefined のままだと JSON から落ち、PostgREST が引数名の集合で関数を探せなくなる
      expect(Object.keys(args).sort()).toEqual(["p_end_date", "p_servings_config", "p_start_date", "p_title", "p_user_id"]);
      expect(args.p_servings_config).toBeNull();
    }
  });

  it("RP-3: DB 関数のエラーは握りつぶさず、そのまま投げる (呼び出し側が failed にしてログに残す)", async () => {
    const dbError = { code: "23505", message: "duplicate key value violates unique constraint", details: null, hint: null };
    const { client } = fakeClient({ data: null, error: dbError });

    await expect(
      replaceActiveShoppingList(client, { userId: USER_ID, startDate: "2026-10-08", endDate: "2026-10-14" }),
    ).rejects.toBe(dbError);
  });

  it.each([
    ["null", null],
    ["空文字", ""],
    ["文字列でない値", { id: LIST_ID }],
  ])("RP-4: エラーなしで id が返らなかった場合 (%s) は、成功扱いにせず投げる", async (_label, data) => {
    const { client } = fakeClient({ data, error: null });

    await expect(
      replaceActiveShoppingList(client, { userId: USER_ID, startDate: "2026-10-08", endDate: "2026-10-14" }),
    ).rejects.toThrow("replace_active_shopping_list returned no list id");
  });
});

// Edge Function 本体は Deno 専用の import を含み Vitest では読み込めないため、ソースで配線を確かめる
describe("regenerate-shopping-list-v2 の配線 (#1312)", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../supabase/functions/regenerate-shopping-list-v2/index.ts"),
    "utf8",
  );

  it("RP-5: 共有モジュール _shared/shopping-list-replace.ts の replaceActiveShoppingList を使う", () => {
    expect(source).toContain('import { replaceActiveShoppingList } from "../_shared/shopping-list-replace.ts";');
    const call = source.indexOf("await replaceActiveShoppingList(supabase, {");
    expect(call).toBeGreaterThan(-1);
    const args = source.slice(call, source.indexOf("});", call));
    expect(args).toContain("userId,");
    expect(args).toContain("startDate,");
    expect(args).toContain("endDate,");
    expect(args).toContain("servingsConfig: effectiveServingsConfig,");
  });

  it("RP-6: shopping_lists を直接 UPDATE / INSERT しない (アーカイブ -> INSERT に戻すと #1312 が再発する)", () => {
    expect(source).not.toContain('.from("shopping_lists")');
    expect(source).not.toContain("'shopping_lists'");
    expect(source).not.toMatch(/status:\s*"archived"/);
  });

  it("RP-7: リストの差し替えは、AI による整理 (LLM 呼び出し) より前に行い、リストの id で食材を保存する", () => {
    const replace = source.indexOf("await replaceActiveShoppingList(supabase, {");
    const llm = source.indexOf("await callOpenAI(prompt)");
    const save = source.indexOf('.from("shopping_list_items")');
    expect(replace).toBeGreaterThan(-1);
    expect(llm).toBeGreaterThan(replace);
    expect(save).toBeGreaterThan(llm);
    expect(source).toContain("shopping_list_id: shoppingListId,");
  });
});
