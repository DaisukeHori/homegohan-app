// @vitest-environment node
//
// #1306: calculate-segment-stats は planned_meals を `meal_plan_days!inner(day_date, meal_plans!inner(user_id))` で
// 取得していた。この 2 テーブルは date-based model への移行で削除済み (本番にも無い) ため、クエリは必ず PGRST200 で
// 失敗した。しかも結果の error を見ずに `data ?? []` としていたので、planned_meals 由来の指標
// (朝食実行率・野菜スコア・栄養スコア・メニュー実行率) は、全員 0 が「正しい値」として保存され続けた。
// 所有者と日付は user_daily_meals (planned_meals.daily_meal_id でつながる) にある。
//
// Edge Function 本体は Deno.serve を import 時に呼ぶ。Deno・supabase-js・ロガーを差し替えて本物のハンドラを取り出し、
// 実際に呼んで、発行されたクエリ・保存された指標・失敗時の振る舞いを確かめる。
//
// 注意: このテストの supabase-js は偽物なので、PostgREST が実際にクエリを受け付けるかは確かめない。
// 実 DB での確認は tests/integration/rls/stats-edge-functions-user-daily-meals.test.ts が担当する。
// 期間 (週の境界) の求め方は #1211 の担当なので、具体的な日付は固定せず、
// 「レスポンスの periodStart / periodEnd と、クエリに渡した日付が一致する」ことだけを見る。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  argsOf,
  createRecordingSupabase,
  eqValue,
  firstMethodOf,
  pageOf,
  queriesOf,
  type QueryOutcome,
  type RecordedQuery,
} from "./helpers/recording-supabase";

const CRON_SECRET = "test-cron-secret";
const DAY = "2026-10-08";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const h = vi.hoisted(() => ({
  serve: null as null | ((req: Request) => Promise<Response>),
  client: null as null | { from: (table: string) => unknown },
  errors: [] as Array<{ message: string; error: unknown }>,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (table: string) => h.client!.from(table) }),
}));

// ロガーは app_logs へ書き込むので差し替える (https://esm.sh の import も避けられる)
vi.mock("../supabase/functions/_shared/db-logger.ts", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, error?: unknown) => {
      h.errors.push({ message, error });
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
  await import("../supabase/functions/calculate-segment-stats/index.ts");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.errors.length = 0;
  h.client = null;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

// ── 偽の DB (書き込みを覚えて、後の読み取りで返す) ───────────────────────────────

const METRICS = [
  { id: "m-exec", code: "menu_execution_rate", name: "メニュー実行率", higher_is_better: true, is_active: true },
  { id: "m-bf", code: "breakfast_rate", name: "朝食実行率", higher_is_better: true, is_active: true },
  { id: "m-veg", code: "veg_score_avg", name: "野菜スコア", higher_is_better: true, is_active: true },
  { id: "m-nut", code: "nutrition_score", name: "栄養スコア", higher_is_better: true, is_active: true },
];
const SEGMENT = { id: "s-all", code: "all", name: "全ユーザー", axes: {}, level: 0, is_active: true };

interface PlannedRow {
  meal_type: string;
  is_completed: boolean;
  veg_score: number | null;
  user_daily_meals: { user_id: string; day_date: string };
}

const pm = (userNo: number, mealType: string, completed: boolean, vegScore: number | null): PlannedRow => ({
  meal_type: mealType,
  is_completed: completed,
  veg_score: vegScore,
  user_daily_meals: { user_id: uid(userNo), day_date: DAY },
});

// 5 人 (セグメントは 5 人未満だと統計を作らない)。メニュー実行率が 100 / 75 / 50 / 25 / 0 になるように食事を置く。
//   u1: 朝昼夕間 4 件すべて完了 (スコア 5, 4, 3, なし)      → 実行率 100, 朝食 100, 野菜 4.0, 栄養 80
//   u2: 3 件完了 (間食は未完了)  (スコア 4, 4, 4, なし)      → 実行率  75, 朝食 100, 野菜 4.0, 栄養 80
//   u3: 2 件完了                 (スコア 3, 3, 3, なし)      → 実行率  50, 朝食 100, 野菜 3.0, 栄養 60
//   u4: 昼だけ完了               (スコア 2, 2, 2, 2)         → 実行率  25, 朝食   0, 野菜 2.0, 栄養 40
//   u5: 何も完了していない       (スコア 1, 1, 1, 1)         → 実行率   0, 朝食   0, 野菜 1.0, 栄養 20
function fivePeoplePlannedMeals(): PlannedRow[] {
  return [
    pm(1, "breakfast", true, 5), pm(1, "lunch", true, 4), pm(1, "dinner", true, 3), pm(1, "snack", true, null),
    pm(2, "breakfast", true, 4), pm(2, "lunch", true, 4), pm(2, "dinner", true, 4), pm(2, "snack", false, null),
    pm(3, "breakfast", true, 3), pm(3, "lunch", true, 3), pm(3, "dinner", false, 3), pm(3, "snack", false, null),
    pm(4, "breakfast", false, 2), pm(4, "lunch", true, 2), pm(4, "dinner", false, 2), pm(4, "snack", false, 2),
    pm(5, "breakfast", false, 1), pm(5, "lunch", false, 1), pm(5, "dinner", false, 1), pm(5, "snack", false, 1),
  ];
}

type Row = Record<string, any>;

interface Db {
  planned: PlannedRow[];
  profiles: Row[];
  /** 前の期間の user_metrics (変化率の計算元) */
  prevMetrics: Row[];
  badges: Row[];
  /** 書き込まれた行 */
  saved: { user_metrics: Row[]; segment_stats: Row[]; user_segment_rankings: Row[]; user_badges: Row[] };
  /** 失敗させたいクエリなら error を返す */
  fail?: (query: RecordedQuery) => QueryOutcome["error"] | undefined;
}

function newDb(overrides: Partial<Db> = {}): Db {
  return {
    planned: fivePeoplePlannedMeals(),
    profiles: [1, 2, 3, 4, 5].map((n) => ({ id: uid(n), age_group: "30s", gender: "female", perf_modes: null })),
    prevMetrics: [],
    badges: [],
    saved: { user_metrics: [], segment_stats: [], user_segment_rankings: [], user_badges: [] },
    ...overrides,
  };
}

/** upsert の第 1 引数 (行、または行の配列) を、行の配列にして返す */
function upsertedRows(query: RecordedQuery): Row[] {
  const arg = argsOf(query, "upsert")[0][0];
  return Array.isArray(arg) ? arg : [arg];
}

function install(db: Db) {
  const recording = createRecordingSupabase((query) => {
    const failure = db.fail?.(query);
    if (failure) return { error: failure };

    switch (query.table) {
      case "metric_definitions":
        return { data: METRICS };
      case "segment_definitions":
        return { data: [SEGMENT] };
      case "user_profiles":
        return { data: pageOf(db.profiles, query) };
      case "health_streaks":
      case "meals":
        return { data: [] };
      case "planned_meals":
        return { data: pageOf(db.planned, query) };
      case "badges":
        return { data: db.badges };

      case "user_metrics": {
        if (firstMethodOf(query) === "upsert") {
          db.saved.user_metrics.push(...upsertedRows(query));
          return { data: null };
        }
        // ユーザー + 指標で 1 行を引く = バッジ判定の改善率。そうでなければ前の期間の一括取得
        if (eqValue(query, "user_id") !== undefined) {
          const row = db.saved.user_metrics.find(
            (r) => r.user_id === eqValue(query, "user_id") && r.metric_id === eqValue(query, "metric_id"),
          );
          return { data: row ? { change_rate: row.change_rate } : null };
        }
        return { data: pageOf(db.prevMetrics, query) };
      }

      case "segment_stats": {
        if (firstMethodOf(query) === "upsert") {
          db.saved.segment_stats.push(...upsertedRows(query));
          return { data: null };
        }
        const row = db.saved.segment_stats.find(
          (r) => r.segment_id === eqValue(query, "segment_id") && r.metric_id === eqValue(query, "metric_id"),
        );
        return { data: row ? { avg_value: row.avg_value } : null };
      }

      case "user_segment_rankings": {
        if (firstMethodOf(query) === "upsert") {
          db.saved.user_segment_rankings.push(...upsertedRows(query));
          return { data: null };
        }
        return {
          data: db.saved.user_segment_rankings.map((r) => ({
            ...r,
            segment_definitions: { code: SEGMENT.code, name: SEGMENT.name },
            metric_definitions: METRICS.filter((m) => m.id === r.metric_id).map((m) => ({ code: m.code, name: m.name }))[0],
          })),
        };
      }

      case "user_badges":
        db.saved.user_badges.push(...upsertedRows(query));
        return { data: null };

      default:
        throw new Error(`想定していないテーブル: ${query.table}`);
    }
  });
  h.client = recording.client;
  return recording;
}

async function call(body: Record<string, unknown> = { periodType: "weekly" }, headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  if (!h.serve) throw new Error("Deno.serve のハンドラを取得できていません");
  const res = await h.serve(
    new Request("http://localhost/functions/v1/calculate-segment-stats", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: await res.json() };
}

/** 保存された user_metrics から、(ユーザー番号, 指標の id) の行を引く */
function metricRow(db: Db, userNo: number, metricId: string): Row {
  const row = db.saved.user_metrics.find((r) => r.user_id === uid(userNo) && r.metric_id === metricId);
  if (!row) throw new Error(`user_metrics が保存されていない: u${userNo} / ${metricId}`);
  return row;
}

const WRITE_TABLES = ["user_metrics", "segment_stats", "user_segment_rankings", "user_badges"];

/** 何かを書き込むクエリ (upsert) が 1 つも発行されていないこと */
function expectNoWrites(queries: RecordedQuery[]) {
  const writes = queries.filter((q) => WRITE_TABLES.includes(q.table) && firstMethodOf(q) === "upsert");
  expect(writes).toEqual([]);
}

// ── テスト ───────────────────────────────────────────────────────────────────

describe("calculate-segment-stats: planned_meals を user_daily_meals 経由で読む (#1306)", () => {
  it("存在しない meal_plan_days / meal_plans は使わず、user_daily_meals!inner で期間・非ハンズオンに絞る", async () => {
    const db = newDb();
    const { queries } = install(db);

    const { res, json } = await call();
    expect(res.status).toBe(200);

    expect(JSON.stringify(queries)).not.toMatch(/meal_plan/);

    const planned = queriesOf(queries, "planned_meals");
    expect(planned).toHaveLength(1);
    const [select] = argsOf(planned[0], "select")[0] as [string];
    expect(select).toContain("user_daily_meals!inner(user_id, day_date)");
    for (const column of ["meal_type", "is_completed", "veg_score"]) {
      expect(select).toContain(column);
    }
    // day_date は date 型 (JST の暦日)。期間の開始日・終了日の文字列とそのまま比較する
    expect(argsOf(planned[0], "gte")).toEqual([["user_daily_meals.day_date", json.periodStart]]);
    expect(argsOf(planned[0], "lte")).toEqual([["user_daily_meals.day_date", json.periodEnd]]);
    // ハンズオン (チュートリアル) 用の仮データは実際の食事ではないので除く
    expect(argsOf(planned[0], "eq")).toEqual([["user_daily_meals.is_sandbox", false]]);
    // 件数が上限未満なら、order / range を足さず 1 回で終わる
    expect(argsOf(planned[0], "range")).toEqual([]);
  });

  it("セグメントの判定に使う列だけを user_profiles から読む (select('*') で全列を運ばない)", async () => {
    const { queries } = install(newDb());

    await call();

    expect(argsOf(queriesOf(queries, "user_profiles")[0], "select")).toEqual([["id, age_group, gender, perf_modes"]]);
  });

  it("planned_meals 由来の指標が、所有者ごとに正しく計算されて保存される (全員 0 にならない)", async () => {
    const db = newDb({
      // u1 は前の期間のメニュー実行率が 50 だった → 変化率 +100%
      prevMetrics: [{ user_id: uid(1), metric_id: "m-exec", value: 50 }],
    });
    install(db);

    const { res, json } = await call();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, processedUsers: 5, processedSegments: 1, periodType: "weekly" });

    const expected: Record<string, number[]> = {
      "m-exec": [100, 75, 50, 25, 0],
      "m-bf": [100, 100, 100, 0, 0],
      "m-veg": [4, 4, 3, 2, 1],
      "m-nut": [80, 80, 60, 40, 20],
    };
    for (const [metricId, values] of Object.entries(expected)) {
      values.forEach((value, i) => {
        expect(metricRow(db, i + 1, metricId)).toMatchObject({
          value,
          period_type: "weekly",
          period_start: json.periodStart,
          period_end: json.periodEnd,
        });
      });
    }
    expect(db.saved.user_metrics).toHaveLength(20);
    expect(metricRow(db, 1, "m-exec")).toMatchObject({ previous_value: 50, change_rate: 100 });
    expect(metricRow(db, 2, "m-exec")).toMatchObject({ previous_value: null, change_rate: null });
  });

  it("セグメントの統計とランキングも、その指標から作られる", async () => {
    const db = newDb();
    install(db);

    const { json } = await call();

    const stat = db.saved.segment_stats.find((r) => r.metric_id === "m-exec")!;
    expect(stat).toMatchObject({
      segment_id: "s-all",
      period_type: "weekly",
      period_start: json.periodStart,
      user_count: 5,
      avg_value: 50,
      median_value: 50,
      min_value: 0,
      max_value: 100,
      p10_value: 10,
      p25_value: 25,
      p75_value: 75,
      p90_value: 90,
    });

    const rankings = db.saved.user_segment_rankings
      .filter((r) => r.metric_id === "m-exec")
      .sort((a, b) => a.rank - b.rank);
    expect(rankings.map((r) => [r.user_id, r.rank, r.total_users, r.percentile, r.value, r.vs_avg_rate])).toEqual([
      [uid(1), 1, 5, 80, 100, 100],
      [uid(2), 2, 5, 60, 75, 50],
      [uid(3), 3, 5, 40, 50, 0],
      [uid(4), 4, 5, 20, 25, -50],
      [uid(5), 5, 5, 0, 0, -100],
    ]);
  });

  it("1 回の応答が API の上限 (1000 行) に達したら、ページ送りで取り直して全件を集計する", async () => {
    // u1 だけ 2200 件 (半分が完了)。ほかの 4 人は通常どおり 4 件ずつ
    const manyForU1 = Array.from({ length: 2200 }, (_, i) => pm(1, "lunch", i % 2 === 0, null));
    const others = fivePeoplePlannedMeals().filter((r) => r.user_daily_meals.user_id !== uid(1));
    const db = newDb({ planned: [...manyForU1, ...others] });
    const { queries } = install(db);

    const { res } = await call();

    expect(res.status).toBe(200);
    const planned = queriesOf(queries, "planned_meals");
    // 1 回目はそのまま (1000 行で打ち切られる) → order + range のページ送り 4 回 (1000, 1000, 216, 空)
    expect(planned).toHaveLength(5);
    expect(argsOf(planned[0], "range")).toEqual([]);
    expect(planned.slice(1).map((q) => argsOf(q, "range")[0])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2216, 3215],
    ]);
    expect(planned.slice(1).every((q) => argsOf(q, "order")[0]?.[0] === "id")).toBe(true);
    // 打ち切られた 1000 行だけでなく、2200 行すべてを数えている (半分が完了 → 50)
    expect(metricRow(db, 1, "m-exec").value).toBe(50);
  });
});

describe("calculate-segment-stats: 失敗を成功に見せない (#1306)", () => {
  const boom = { message: "Could not find a relationship between 'planned_meals' and 'meal_plan_days' in the schema cache", code: "PGRST200" };

  // [表示名, 失敗させるクエリ, エラー文に含まれるラベル]
  const readFailures: Array<[string, (q: RecordedQuery) => boolean, string]> = [
    ["planned_meals", (q) => q.table === "planned_meals", "planned_meals (期間内) の取得"],
    ["health_streaks (meal_record)", (q) => q.table === "health_streaks" && eqValue(q, "streak_type") === "meal_record", "health_streaks (meal_record) の取得"],
    ["health_streaks (breakfast)", (q) => q.table === "health_streaks" && eqValue(q, "streak_type") === "breakfast", "health_streaks (breakfast) の取得"],
    ["meals (期間内)", (q) => q.table === "meals" && argsOf(q, "gte").length > 0, "meals (期間内) の取得"],
    ["meals (全期間)", (q) => q.table === "meals" && argsOf(q, "gte").length === 0, "meals (全期間) の取得"],
    ["user_profiles", (q) => q.table === "user_profiles", "user_profiles の取得"],
    ["user_metrics (前期間)", (q) => q.table === "user_metrics" && firstMethodOf(q) === "select", "user_metrics (前期間) の取得"],
    ["metric_definitions", (q) => q.table === "metric_definitions", "metric_definitions の取得"],
    ["segment_definitions", (q) => q.table === "segment_definitions", "segment_definitions の取得"],
  ];

  it.each(readFailures)("%s の取得に失敗したら、0 の指標を保存せず、ログに残して 500 で返す", async (_name, matches, label) => {
    const db = newDb({ fail: (q) => (matches(q) ? boom : undefined) });
    const { queries } = install(db);

    const { res, json } = await call();

    expect(res.status).toBe(500);
    expect(json.error).toContain(label);
    expect(json.error).toContain("PGRST200");
    // 失敗したまま「行が無い」ものとして計算し、0 の指標・統計・ランキングを保存してはいけない
    expectNoWrites(queries);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].message).toBe("Segment stats calculation error");
    expect((h.errors[0].error as Error).message).toContain(label);
  });

  // [表示名, 失敗させるクエリ, エラー文に含まれるラベル]
  const writeFailures: Array<[string, (q: RecordedQuery) => boolean, string]> = [
    ["user_metrics の保存", (q) => q.table === "user_metrics" && firstMethodOf(q) === "upsert", "user_metrics の保存"],
    ["segment_stats の保存", (q) => q.table === "segment_stats" && firstMethodOf(q) === "upsert", "segment_stats の保存"],
    ["segment_stats の取得", (q) => q.table === "segment_stats" && firstMethodOf(q) === "select", "segment_stats の取得"],
    ["user_segment_rankings の保存", (q) => q.table === "user_segment_rankings" && firstMethodOf(q) === "upsert", "user_segment_rankings の保存"],
  ];

  it.each(writeFailures)("%s に失敗したら、無視せず 500 で返してログに残す", async (_name, matches, label) => {
    const db = newDb({ fail: (q) => (matches(q) ? { message: "permission denied", code: "42501" } : undefined) });
    install(db);

    const { res, json } = await call();

    expect(res.status).toBe(500);
    expect(json.error).toContain(label);
    expect(json.error).toContain("42501");
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].message).toBe("Segment stats calculation error");
  });
});

describe("calculate-segment-stats: バッジの付与 (#1306)", () => {
  const rank1Badge = { id: "b-rank1", code: "segment_rank_1", icon: "🏆", metric_code: null, condition_json: { type: "segment_rank", rank: 1 } };
  const improvedBadge = { id: "b-improved", code: "improved_10", icon: "📈", metric_code: null, condition_json: { type: "improvement", threshold: 10 } };

  it("badges は condition_json->>type (text) で絞る。`->` (jsonb) だと eq.segment_rank が json として解釈されて 22P02 になる", async () => {
    const { queries } = install(newDb());

    await call();

    const filter = argsOf(queriesOf(queries, "badges")[0], "or")[0][0] as string;
    for (const type of ["segment_rank", "segment_percentile", "segment_vs_avg", "improvement"]) {
      expect(filter).toContain(`condition_json->>type.eq.${type}`);
    }
    expect(filter).not.toMatch(/condition_json->type/);
  });

  it("1 位のユーザーに順位バッジを、前の期間より 10% 以上伸びたユーザーに改善バッジを付与する", async () => {
    const db = newDb({
      badges: [rank1Badge, improvedBadge],
      prevMetrics: [{ user_id: uid(1), metric_id: "m-exec", value: 50 }], // u1 のメニュー実行率 50 → 100 (+100%)
    });
    const { queries } = install(db);

    const { res, json } = await call();

    expect(res.status).toBe(200);
    const awards = db.saved.user_badges;
    // 順位バッジは 1 位の u1 だけ (指標ごとに 1 位の行がある)。ignoreDuplicates で、すでに持っていれば何もしない
    const rank1 = awards.filter((a) => a.badge_id === "b-rank1");
    expect(rank1.length).toBeGreaterThan(0);
    expect(new Set(rank1.map((a) => a.user_id))).toEqual(new Set([uid(1)]));
    expect(rank1[0]).toMatchObject({
      message: "🏆 全ユーザーのメニュー実行率で1位！",
      context_json: expect.objectContaining({ segment_id: "s-all", metric_id: "m-exec", rank: 1, period_type: "weekly", period_start: json.periodStart }),
    });
    // 改善バッジは変化率のある u1 のメニュー実行率だけ
    expect(awards.filter((a) => a.badge_id === "b-improved")).toEqual([
      expect.objectContaining({ user_id: uid(1), message: "📈 メニュー実行率が100%改善！" }),
    ]);
    for (const q of queriesOf(queries, "user_badges")) {
      expect(argsOf(q, "upsert")[0][1]).toEqual({ onConflict: "user_id,badge_id", ignoreDuplicates: true });
    }
    // 改善率は、行が無くてもエラーにならない maybeSingle で引く
    const improvementLookups = queriesOf(queries, "user_metrics").filter((q) => eqValue(q, "user_id") !== undefined);
    expect(improvementLookups.length).toBeGreaterThan(0);
    expect(improvementLookups.every((q) => argsOf(q, "maybeSingle").length === 1 && argsOf(q, "single").length === 0)).toBe(true);
  });

  it("badges の取得に失敗したら、バッジ無しとして黙って終わらず 500 で返してログに残す", async () => {
    const db = newDb({
      badges: [rank1Badge],
      fail: (q) => (q.table === "badges" ? { message: "invalid input syntax for type json", code: "22P02" } : undefined),
    });
    install(db);

    const { res, json } = await call();

    expect(res.status).toBe(500);
    expect(json.error).toContain("badges の取得");
    expect(json.error).toContain("22P02");
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].message).toBe("Segment stats calculation error");
  });

  it("改善率の取得・バッジの保存に失敗したときも、無視せず 500 で返す", async () => {
    for (const [label, matches] of [
      ["user_metrics (改善率) の取得", (q: RecordedQuery) => q.table === "user_metrics" && eqValue(q, "user_id") !== undefined],
      ["user_badges の保存", (q: RecordedQuery) => q.table === "user_badges"],
    ] as const) {
      h.errors.length = 0;
      const db = newDb({
        badges: [rank1Badge, improvedBadge],
        prevMetrics: [{ user_id: uid(1), metric_id: "m-exec", value: 50 }],
        fail: (q) => (matches(q) ? { message: "boom", code: "XX000" } : undefined),
      });
      install(db);

      const { res, json } = await call();

      expect(res.status, label).toBe(500);
      expect(json.error, label).toContain(label);
      expect(h.errors, label).toHaveLength(1);
    }
  });

  it("ランキングの取得に失敗したときも、無視せず 500 で返す", async () => {
    const db = newDb({
      badges: [rank1Badge],
      fail: (q) => (q.table === "user_segment_rankings" && firstMethodOf(q) === "select" ? { message: "boom", code: "XX000" } : undefined),
    });
    install(db);

    const { res, json } = await call();

    expect(res.status).toBe(500);
    expect(json.error).toContain("user_segment_rankings の取得");
  });
});

describe("calculate-segment-stats: 認証", () => {
  it("CRON_SECRET が違う・無い呼び出しは 401 で、DB には触れない", async () => {
    const { queries } = install(newDb());

    const wrong = await call({ periodType: "weekly" }, { authorization: "Bearer not-the-secret" });
    const missing = await call({ periodType: "weekly" }, {});

    expect(wrong.res.status).toBe(401);
    expect(missing.res.status).toBe(401);
    expect(queries).toEqual([]);
  });
});
