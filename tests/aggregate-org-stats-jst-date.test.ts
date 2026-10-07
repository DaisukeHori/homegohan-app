// @vitest-environment node
//
// #1210: aggregate-org-stats は「対象日」を省略されると今日の日付を使う。
// 以前は new Date().toISOString().split('T')[0] (= UTC の暦日) だったため、
// JST 00:00〜08:59 は前日の日付で集計・保存していた。
// 集計の突き合わせ先 (meal_plan_days.day_date) は JST の暦日なので、JST の「今日」を使う。
//
// Edge Function 本体は Deno.serve を import 時に呼ぶ。Deno と supabase-js / ロガーを
// 差し替えて本物のハンドラを取り出し、省略時の対象日を実際に呼んで確かめる。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const CRON_SECRET = "test-cron-secret";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

type Call = { table: string; method: string; args: unknown[] };

const h = vi.hoisted(() => ({
  serve: null as null | ((req: Request) => Promise<Response>),
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  members: [] as Array<{ id: string }>,
  logs: [] as string[],
}));

// supabase-js: 呼び出しを記録するだけの偽クライアント。await できる (thenable) クエリビルダーを返す。
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in"]) {
        builder[method] = (...args: unknown[]) => {
          h.calls.push({ table, method, args });
          return builder;
        };
      }
      builder.upsert = (...args: unknown[]) => {
        h.calls.push({ table, method: "upsert", args });
        return Promise.resolve({ error: null });
      };
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const data =
          table === "organizations" ? [{ id: ORG_ID }] : table === "user_profiles" ? h.members : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return builder;
    },
  }),
}));

// ロガーは app_logs へ書き込むので差し替える (https://esm.sh の import も避けられる)
vi.mock("../supabase/functions/_shared/db-logger.ts", () => ({
  createLogger: () => ({
    debug: () => {},
    warn: () => {},
    info: (message: string) => {
      h.logs.push(message);
    },
    error: (message: string) => {
      h.logs.push(`ERROR: ${message}`);
    },
  }),
  generateRequestId: () => "req_test",
}));

beforeAll(async () => {
  const env: Record<string, string> = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    CRON_SECRET,
  };
  vi.stubGlobal("Deno", {
    env: { get: (key: string) => env[key] },
    serve: (handler: (req: Request) => Promise<Response>) => {
      h.serve = handler;
    },
  });
  await import("../supabase/functions/aggregate-org-stats/index.ts");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  h.calls.length = 0;
  h.logs.length = 0;
  h.members = [{ id: USER_ID }];
  // Date だけ偽物にする (Promise / タイマーはそのまま動かす)
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function callAggregate(body: Record<string, unknown> = {}) {
  if (!h.serve) throw new Error("Deno.serve のハンドラを取得できていません");
  const res = await h.serve(
    new Request("http://localhost/functions/v1/aggregate-org-stats", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res;
}

function findCall(table: string, method: string): Call | undefined {
  return h.calls.find((c) => c.table === table && c.method === method);
}

describe("aggregate-org-stats: 対象日を省略したときは JST の今日 (#1210)", () => {
  // [UTC の現在時刻, JST での時刻 (説明用), 期待する対象日]
  const cases: Array<[string, string, string]> = [
    ["2026-07-12T14:59:59.999Z", "JST 7/12 23:59:59.999", "2026-07-12"],
    ["2026-07-12T15:00:00.000Z", "JST 7/13 00:00:00", "2026-07-13"],
    ["2026-07-12T16:00:00.000Z", "JST 7/13 01:00 (Issue の再現例)", "2026-07-13"],
    ["2026-07-12T23:59:59.999Z", "JST 7/13 08:59:59.999", "2026-07-13"],
    ["2026-07-13T00:00:00.000Z", "JST 7/13 09:00:00", "2026-07-13"],
    ["2026-07-13T14:59:59.999Z", "JST 7/13 23:59:59.999", "2026-07-13"],
    ["2026-07-13T15:00:00.000Z", "JST 7/14 00:00:00", "2026-07-14"],
  ];

  it.each(cases)("%s (%s) → 保存する日付と突き合わせる日付は %s", async (nowUtc, _jst, expectedDate) => {
    vi.setSystemTime(new Date(nowUtc));

    const res = await callAggregate({ organizationId: ORG_ID });
    expect(res.status).toBe(200);

    // 食事データの突き合わせ先 (meal_plan_days.day_date は JST の暦日)
    expect(findCall("planned_meals", "eq")?.args).toEqual(["meal_plan_days.day_date", expectedDate]);
    // 集計結果の保存先 (org_daily_stats.date)
    expect(findCall("org_daily_stats", "upsert")?.args[0]).toMatchObject({
      organization_id: ORG_ID,
      date: expectedDate,
    });
    expect(h.logs).toContain(`Aggregating stats for date: ${expectedDate}`);
  });

  it("メンバーが 0 人の組織でも、0 埋めの行は JST の今日の日付で保存する", async () => {
    h.members = [];
    vi.setSystemTime(new Date("2026-07-12T16:00:00.000Z")); // JST 7/13 01:00

    const res = await callAggregate();
    expect(res.status).toBe(200);

    expect(findCall("planned_meals", "eq")).toBeUndefined();
    expect(findCall("org_daily_stats", "upsert")?.args[0]).toMatchObject({
      organization_id: ORG_ID,
      date: "2026-07-13",
      member_count: 0,
    });
  });

  it("date を指定したときは、現在時刻に関わらずその日付をそのまま使う", async () => {
    vi.setSystemTime(new Date("2026-07-12T16:00:00.000Z"));

    const res = await callAggregate({ date: "2026-01-02", organizationId: ORG_ID });
    expect(res.status).toBe(200);

    expect(findCall("planned_meals", "eq")?.args).toEqual(["meal_plan_days.day_date", "2026-01-02"]);
    expect(findCall("org_daily_stats", "upsert")?.args[0]).toMatchObject({ date: "2026-01-02" });
  });
});
