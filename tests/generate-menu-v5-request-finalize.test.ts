import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_REQUEST_STATUSES,
  buildActiveRequestUpdate,
  wasRequestUpdated,
} from "../supabase/functions/generate-menu-v5/request-finalize";

// #1202: 献立生成キューは、止まった (リースが切れた) 行を別の cron が取り直して続きから再開する。
// 止まったと見なされた側のチェーンが遅れて動いていると、同じ request に 2 本が最後まで走り、
// 後から終わった側が先に確定した status / progress / generated_data を上書きしてしまう。
// 最終書き込み (completed / failed) は、まだ終わっていない行 (queued / processing) にだけ当てる。

type Row = { id: string; status: string; current_step: number; error_message: string | null };
type Filter = [column: string, op: "eq" | "in", value: unknown];

/** PostgREST の `.update().eq().in().select()` と同じ振る舞いをするメモリ上の偽クライアント */
function fakeClient(rows: Row[]) {
  const calls: Array<{ table: string; values: Record<string, unknown>; filters: Filter[]; select?: string }> = [];
  const client = {
    from(table: string) {
      const call = { table, values: {} as Record<string, unknown>, filters: [] as Filter[], select: undefined as string | undefined };
      calls.push(call);
      const builder = {
        update(values: Record<string, unknown>) {
          call.values = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, "eq", value]);
          return builder;
        },
        in(column: string, values: unknown[]) {
          call.filters.push([column, "in", values]);
          return builder;
        },
        select(columns: string) {
          call.select = columns;
          return builder;
        },
        // await されたときに、条件に合う行だけを更新して返す (0 件でもエラーにはしない)
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          const matched = rows.filter((row) =>
            call.filters.every(([column, op, value]) =>
              op === "eq"
                ? (row as Record<string, unknown>)[column] === value
                : (value as unknown[]).includes((row as Record<string, unknown>)[column]),
            ),
          );
          for (const row of matched) Object.assign(row, call.values);
          return Promise.resolve({ data: matched.map((row) => ({ id: row.id })), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const FINAL = { status: "completed", current_step: 6, error_message: null };

describe("buildActiveRequestUpdate: 最終書き込みの CAS (#1202)", () => {
  it("HF-1: 書き込める status は queued / processing の 2 つ (失敗側の CAS #122 と同じ集合)", () => {
    expect([...ACTIVE_REQUEST_STATUSES]).toEqual(["queued", "processing"]);
  });

  it("HF-2: 処理中 (processing) と待機中 (queued) の行には書き込める", async () => {
    for (const status of ["processing", "queued"]) {
      const rows: Row[] = [{ id: REQUEST_ID, status, current_step: 3, error_message: null }];
      const { client } = fakeClient(rows);
      const result = (await buildActiveRequestUpdate(client, REQUEST_ID, FINAL)) as { data: unknown; error: unknown };
      expect(result.error).toBeNull();
      expect(wasRequestUpdated(result.data)).toBe(true);
      expect(rows[0]).toMatchObject({ status: "completed", current_step: 6 });
    }
  });

  it("HF-3: すでに完了 (completed) / 失敗 (failed) / 取消 (cancelled) の行は、後から来た最終書き込みで上書きしない", async () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      const rows: Row[] = [{ id: REQUEST_ID, status, current_step: 3, error_message: "先に確定した結果" }];
      const { client } = fakeClient(rows);
      const result = (await buildActiveRequestUpdate(client, REQUEST_ID, { ...FINAL, error_message: null })) as {
        data: unknown;
        error: unknown;
      };
      // エラーにはならず、0 件更新 = 呼び出し側が「見送った」と判断できる
      expect(result.error).toBeNull();
      expect(wasRequestUpdated(result.data)).toBe(false);
      expect(rows[0]).toEqual({ id: REQUEST_ID, status, current_step: 3, error_message: "先に確定した結果" });
    }
  });

  it("HF-4: 対象の id の行だけを更新する (同じ status の別の行は触らない)", async () => {
    const rows: Row[] = [
      { id: REQUEST_ID, status: "processing", current_step: 3, error_message: null },
      { id: OTHER_ID, status: "processing", current_step: 2, error_message: null },
    ];
    const { client, calls } = fakeClient(rows);
    await buildActiveRequestUpdate(client, REQUEST_ID, FINAL);
    expect(rows[1]).toEqual({ id: OTHER_ID, status: "processing", current_step: 2, error_message: null });
    expect(calls).toEqual([
      {
        table: "weekly_menu_requests",
        values: FINAL,
        filters: [
          ["id", "eq", REQUEST_ID],
          ["status", "in", ["queued", "processing"]],
        ],
        select: "id",
      },
    ]);
  });

  it("HF-5: wasRequestUpdated は、1 行以上返ったときだけ true (null・空配列・配列以外は false)", () => {
    expect(wasRequestUpdated([{ id: REQUEST_ID }])).toBe(true);
    expect(wasRequestUpdated([])).toBe(false);
    expect(wasRequestUpdated(null)).toBe(false);
    expect(wasRequestUpdated(undefined)).toBe(false);
    expect(wasRequestUpdated({ id: REQUEST_ID })).toBe(false);
  });
});

// Edge Function 本体は Deno 専用の import を含み Vitest では読み込めないため、ソースで配線を確かめる
describe("generate-menu-v5 の配線 (#1202)", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../supabase/functions/generate-menu-v5/index.ts"),
    "utf8",
  );

  it("HF-6: 最終 status の書き込み (Step3 / Step6) は、どちらも finalizeMenuRequest を通る", () => {
    for (const label of ["weekly_menu_requests.v5_step3_final", "weekly_menu_requests.v5_step6_final"]) {
      const at = source.indexOf(label);
      expect(at, `${label} が見つからない`).toBeGreaterThan(-1);
      const call = source.lastIndexOf("finalizeMenuRequest(", at);
      expect(call, `${label} の直前に finalizeMenuRequest( が無い`).toBeGreaterThan(-1);
      // 呼び出しの開始からラベルまでの間に、別の関数や処理を挟まない (同じ呼び出しの引数であること)
      expect(source.slice(call, at)).not.toContain("\n}\n");
    }
  });

  it("HF-7: status: finalSummary.status を書く UPDATE は、生の .from(...).update(...) ではなく finalizeMenuRequest の引数である", () => {
    const occurrences = [...source.matchAll(/status: finalSummary\.status/g)].map((m) => m.index!);
    expect(occurrences).toHaveLength(2);
    for (const at of occurrences) {
      const helperCall = source.lastIndexOf("finalizeMenuRequest(", at);
      const rawFrom = source.lastIndexOf('.from("weekly_menu_requests")', at);
      expect(helperCall).toBeGreaterThan(rawFrom);
    }
  });

  it("HF-8: finalizeMenuRequest は buildActiveRequestUpdate で書き、書けなかったときは警告ログを残す", () => {
    const begin = source.indexOf("async function finalizeMenuRequest(");
    expect(begin).toBeGreaterThan(-1);
    const body = source.slice(begin, source.indexOf("\n}\n", begin));
    expect(body).toContain("buildActiveRequestUpdate(supabase, requestId, update)");
    expect(body).toContain("wasRequestUpdated(");
    expect(body).toContain(".warn(");
  });

  it("HF-9: 失敗側の更新 (fail_background / fail) は従来どおり queued / processing に限定している (#122)", () => {
    const guards = source.match(/\.in\("status", \["queued", "processing"\]\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it("HF-10: Step2 の穴埋め (時間予算の確認も進捗の書き込みも無く LLM を連続で呼ぶ) は、1 スロットごとにハートビートを書く", () => {
    const loop = source.indexOf("for (const missingSlot of missingSlots) {");
    const save = source.indexOf("weekly_menu_requests.recovery_save:", loop);
    expect(loop).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(loop);
    expect(source.slice(loop, save)).toContain("await touchRequestHeartbeat(supabase, requestId);");
  });

  it("HF-11: touchRequestHeartbeat は updated_at だけを、終わっていない行にだけ書き、失敗しても処理を止めない", () => {
    const begin = source.indexOf("async function touchRequestHeartbeat(");
    expect(begin).toBeGreaterThan(-1);
    const body = source.slice(begin, source.indexOf("\n}\n", begin));
    expect(body).toContain(".update({ updated_at: new Date().toISOString() })");
    expect(body).toContain('.in("status", [...ACTIVE_REQUEST_STATUSES])');
    expect(body).toContain("catch (error)");
  });
});
