// @vitest-environment node
//
// #1407: generate-health-insights (Edge Function) は、分析する期間の開始日・終了日と analysis_date を
// new Date() の setDate(getDate() - N) と toISOString().split('T')[0] (どちらも UTC の暦日) で決めていた。
// Edge Function の時計は UTC なので、JST の 0:00〜8:59 に動くと、
//   - 期間の終了日が JST の昨日になり、JST の今日の health_records が分析に入らない
//   - analysis_date / period_start / period_end が 1 日前の日付で保存される
// という不具合になっていた。
//
// Edge Function 本体は Deno.serve を import 時に呼ぶ。Deno・supabase-js・ロガー・LLM の計測を差し替えて本物のハンドラを取り出し、
// 現在時刻 (Date だけ) を固定して実際に呼び、health_records の絞り込み・health_insights へ保存する日付・レスポンスの期間を確かめる。
// 期間の求め方そのもの (calculateJstLookbackPeriod / addDaysToDate) は tests/jst-period.test.ts が確かめる。
// 期待値は、実装とは別の計算 (Python の datetime で JST の暦を引いたもの) で求めた固定値。
//
// 注意: このテストの supabase-js は偽物なので、PostgREST が実際にクエリを受け付けるかは確かめない。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { argsOf, createRecordingSupabase, queriesOf, type RecordedQuery } from "./helpers/recording-supabase";

const USER_ID = "00000000-0000-4000-8000-000000000001";

const h = vi.hoisted(() => ({
  serve: null as null | ((req: Request) => Promise<Response>),
  client: null as null | { from: (table: string) => unknown },
  errors: [] as Array<{ message: string; error: unknown }>,
}));

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに止めることは tests/ai-consent-enforcement.test.ts が確かめる
vi.mock("../supabase/functions/_shared/ai-consent-guard.ts", () => import("./helpers/edge-ai-consent-guard-allowed"));
vi.mock("@supabase/functions-js/edge-runtime.d.ts", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    },
    from: (table: string) => h.client!.from(table),
  }),
}));

// ロガーは app_logs へ書き込むので差し替える (https://esm.sh の import も避けられる)
vi.mock("../supabase/functions/_shared/db-logger.ts", () => ({
  createLogger: () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string, error?: unknown) => {
        h.errors.push({ message, error });
      },
      withUser: () => logger,
    };
    return logger;
  },
  generateRequestId: () => "req_test",
}));

// LLM の使用量計測 (fetch を包んで DB へ書く) は、ここでは中身をそのまま実行するだけにする
vi.mock("../supabase/functions/_shared/llm-usage.ts", () => ({
  withOpenAIUsageContext: async <T,>(_ctx: unknown, fn: () => Promise<T>) => fn(),
  generateExecutionId: () => "exec_test",
}));

vi.mock("../supabase/functions/_shared/fast-llm.ts", () => ({
  getFastLLMApiKey: () => "test-key",
  getFastLLMChatCompletionsUrl: () => "http://127.0.0.1:1/v1/chat/completions",
  getFastLLMModel: () => "test-model",
}));

beforeAll(async () => {
  const env: Record<string, string> = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: "test-anon",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  };
  vi.stubGlobal("Deno", {
    env: { get: (key: string) => env[key] },
    serve: (handler: (req: Request) => Promise<Response>) => {
      h.serve = handler;
    },
  });
  await import("../supabase/functions/generate-health-insights/index.ts");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const originalTz = process.env.TZ;
let errorSpy: ReturnType<typeof vi.spyOn>;
const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));

beforeEach(() => {
  h.errors.length = 0;
  h.client = null;
  fetchMock.mockClear();
  // AI の総合分析は外へ出さない (失敗扱い → その 1 件だけ作られない)
  vi.stubGlobal("fetch", fetchMock);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  errorSpy.mockRestore();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** 現在時刻 (Date) だけを固定する (setTimeout などには触れない) */
function setNow(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

type Row = Record<string, unknown>;

/** 偽の DB。health_records は gte / lte の record_date の絞り込みを、PostgREST と同じように (YYYY-MM-DD の文字列比較で) 適用する */
function install(healthRecords: Row[]) {
  const recording = createRecordingSupabase((query: RecordedQuery) => {
    switch (query.table) {
      case "health_records": {
        const bound = (method: string) =>
          argsOf(query, method).find((args) => args[0] === "record_date")?.[1] as string | undefined;
        const [gte, lte] = [bound("gte"), bound("lte")];
        const rows = healthRecords.filter((row) => {
          const day = String(row.record_date);
          return (gte === undefined || day >= gte) && (lte === undefined || day <= lte);
        });
        return { data: rows };
      }
      case "user_profiles":
        return { data: { id: USER_ID } };
      case "health_goals":
        return { data: [] };
      case "health_insights":
        return { data: null };
      default:
        throw new Error(`unexpected table: ${query.table}`);
    }
  });
  h.client = recording.client;
  return recording;
}

async function invoke(body: Record<string, unknown>) {
  const res = await h.serve!(
    new Request("http://localhost/generate-health-insights", {
      method: "POST",
      headers: { Authorization: "Bearer test-user-jwt", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Row };
}

/** 2 件以上の体重があれば体重トレンドのインサイトが 1 件作られ、health_insights に保存される */
const weightRecord = (recordDate: string, weight: number): Row => ({ record_date: recordDate, weight });

describe("generate-health-insights: 期間と保存する日付は JST の暦日で決まる (#1407)", () => {
  // [period_type (undefined は省略), 現在時刻 (UTC), 期間の開始日, 期間の終了日 (= analysis_date), 説明]
  const cases: Array<[string | undefined, string, string, string, string]> = [
    ["weekly", "2026-07-12T14:59:59.999Z", "2026-07-05", "2026-07-12", "JST 7/12 23:59:59.999 は、まだ 7/12 が今日"],
    ["weekly", "2026-07-12T15:00:00.000Z", "2026-07-06", "2026-07-13", "JST 7/13 0:00 ちょうど (UTC はまだ 7/12。修正前は 7/05〜7/12 だった)"],
    ["weekly", "2026-07-12T23:59:59.999Z", "2026-07-06", "2026-07-13", "JST 7/13 8:59:59.999 (UTC はまだ 7/12)"],
    ["weekly", "2026-07-13T00:00:00.000Z", "2026-07-06", "2026-07-13", "JST 7/13 9:00 (UTC も 7/13)"],
    [undefined, "2026-07-12T15:00:00.000Z", "2026-07-06", "2026-07-13", "period_type を省略すると weekly"],
    ["daily", "2026-07-31T15:00:00.000Z", "2026-07-31", "2026-08-01", "月をまたぐ: JST 8/1 0:00 (UTC はまだ 7/31。修正前は 7/30〜7/31)"],
    ["daily", "2026-07-31T14:59:59.999Z", "2026-07-30", "2026-07-31", "月末 JST 7/31 23:59:59.999"],
    ["monthly", "2026-12-31T15:00:00.000Z", "2026-12-02", "2027-01-01", "年をまたぐ: JST 元日 0:00 (UTC はまだ 12/31。修正前は 12/01〜12/31)"],
    ["monthly", "2026-12-31T23:59:59.999Z", "2026-12-02", "2027-01-01", "年をまたぐ: JST 元日 8:59:59.999 (UTC はまだ 12/31)"],
    ["monthly", "2028-02-29T15:00:00.000Z", "2028-01-31", "2028-03-01", "うるう日の翌日 JST 3/1 0:00 (UTC はまだ 2/29)"],
    ["yearly", "2026-12-31T15:00:00.000Z", "2026-12-02", "2027-01-01", "想定外の period_type は monthly と同じ 30 日"],
  ];

  it.each(cases)("%s @ %s → %s 〜 %s (%s)", async (periodType, now, start, end) => {
    setNow(now);
    const { queries } = install([weightRecord(start, 60), weightRecord(end, 61)]);

    const { status, json } = await invoke(periodType === undefined ? {} : { period_type: periodType });
    expect(status).toBe(200);
    expect(h.errors).toEqual([]);

    // health_records は JST の暦日の期間で絞る (両端を含む)
    const [recordsQuery] = queriesOf(queries, "health_records");
    expect(argsOf(recordsQuery, "gte")).toEqual([["record_date", start]]);
    expect(argsOf(recordsQuery, "lte")).toEqual([["record_date", end]]);

    // 保存する日付も JST の暦日 (analysis_date は JST の今日 = 期間の終了日)
    const inserts = queriesOf(queries, "health_insights").map((q) => argsOf(q, "insert")[0][0] as Row);
    expect(inserts.length).toBeGreaterThan(0);
    for (const row of inserts) {
      expect(row).toMatchObject({
        user_id: USER_ID,
        analysis_date: end,
        period_start: start,
        period_end: end,
        period_type: periodType ?? "weekly",
      });
    }

    // レスポンスの期間も同じ
    expect(json.period).toEqual({ start, end, type: periodType ?? "weekly" });
    expect(json.records_analyzed).toBe(2);
  });

  it("JST の 0:00〜8:59 でも、JST の今日の記録が分析に入る (修正前は UTC の昨日までで絞っていたので入らなかった)", async () => {
    // JST 2026-07-13 03:00 (UTC は 2026-07-12 18:00)
    setNow("2026-07-12T18:00:00.000Z");
    const { queries } = install([
      weightRecord("2026-07-05", 59), // JST の期間 (7/06〜7/13) の外。修正前の UTC の期間 (7/05〜7/12) には入っていた
      weightRecord("2026-07-06", 60),
      weightRecord("2026-07-13", 61), // JST の今日
    ]);

    const { status, json } = await invoke({ period_type: "weekly" });
    expect(status).toBe(200);
    expect(json.records_analyzed).toBe(2);
    expect(json.period).toEqual({ start: "2026-07-06", end: "2026-07-13", type: "weekly" });

    // 体重トレンドは 7/06 (60kg) → 7/13 (61kg) の変化 = JST の今日の記録が最後の値として使われている
    const weightInsight = queriesOf(queries, "health_insights")
      .map((q) => argsOf(q, "insert")[0][0] as Row)
      .find((row) => row.insight_type === "weight_trend");
    expect(weightInsight).toBeDefined();
    expect(weightInsight).toMatchObject({ analysis_date: "2026-07-13", period_start: "2026-07-06", period_end: "2026-07-13" });
  });

  it("実行環境のタイムゾーンに左右されない", async () => {
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      setNow("2026-12-31T15:00:00.000Z"); // JST 2027-01-01 0:00
      const { queries } = install([weightRecord("2026-12-02", 60), weightRecord("2027-01-01", 61)]);

      const { status, json } = await invoke({ period_type: "monthly" });
      expect(status, tz).toBe(200);
      expect(json.period, tz).toEqual({ start: "2026-12-02", end: "2027-01-01", type: "monthly" });
      const [recordsQuery] = queriesOf(queries, "health_records");
      expect(argsOf(recordsQuery, "gte"), tz).toEqual([["record_date", "2026-12-02"]]);
      expect(argsOf(recordsQuery, "lte"), tz).toEqual([["record_date", "2027-01-01"]]);
      vi.useRealTimers();
    }
  });
});
