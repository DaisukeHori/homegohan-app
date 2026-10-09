// @vitest-environment node
//
// #1306: calculate-segment-stats は planned_meals を `meal_plan_days!inner(day_date, meal_plans!inner(user_id))` で
// 取得していた。この 2 テーブルは date-based model への移行で削除済み (本番にも無い) ため、クエリは必ず PGRST200 で
// 失敗した。しかも結果の error を見ずに `data ?? []` としていたので、planned_meals 由来の指標
// (朝食実行率・野菜スコア・栄養スコア・メニュー実行率) は、全員 0 が「正しい値」として保存され続けた。
// 所有者と日付は user_daily_meals (planned_meals.daily_meal_id でつながる) にある。
//
// あわせて、直したことで初めて動くようになったバッジの付与 (badges の取得が 22P02 で毎回失敗していた) の判定も確かめる。
// user_badges は (user_id, badge_id) が主キーで、一度付いたバッジは後から置き換わらない。誤って付けると消えないので、
// 全員が同じ値 (特に全員 0) の指標・値が 0 以下の利用者・平均ちょうどの利用者には、順位や平均超えのバッジを付けないこと、
// 同じ値の利用者は同じ順位になること (取得順に依存しないこと) を見る。
//
// Edge Function 本体は Deno.serve を import 時に呼ぶ。Deno・supabase-js・ロガーを差し替えて本物のハンドラを取り出し、
// 実際に呼んで、発行されたクエリ・保存された指標・失敗時の振る舞いを確かめる。
//
// 注意: このテストの supabase-js は偽物なので、PostgREST が実際にクエリを受け付けるかは確かめない。
// 実 DB での確認は tests/integration/rls/stats-edge-functions-user-daily-meals.test.ts が担当する。
// 期間 (週・月・日の境界) の求め方は #1211 の担当で、末尾の「集計期間は JST の暦で決まる」で、固定した時刻を使って確かめる。
// それ以外のテストは具体的な日付を固定せず、「レスポンスの periodStart / periodEnd と、クエリに渡した日付が一致する」ことだけを見る。

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
  /** 有効な指標定義。省略すると METRICS */
  metrics?: Row[];
  /** 前の期間の user_metrics (変化率の計算元) */
  prevMetrics: Row[];
  /** meals の行 (user_id, eaten_at)。省略すると空。eaten_at の絞り込み (gte / gt / lte / lt) は問い合わせのとおりに適用する */
  meals?: Row[];
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

/** meals への問い合わせの eaten_at の絞り込み (gte / gt / lte / lt) を、PostgREST と同じように行へ適用する */
function mealsWithin(rows: Row[], query: RecordedQuery): Row[] {
  const bound = (method: string): number | undefined => {
    const value = argsOf(query, method).find((args) => args[0] === "eaten_at")?.[1];
    return value === undefined ? undefined : Date.parse(String(value));
  };
  const [gte, gt, lte, lt] = [bound("gte"), bound("gt"), bound("lte"), bound("lt")];
  return rows.filter((row) => {
    const at = Date.parse(String(row.eaten_at));
    return (gte === undefined || at >= gte) && (gt === undefined || at > gt) && (lte === undefined || at <= lte) && (lt === undefined || at < lt);
  });
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

    const metrics = db.metrics ?? METRICS;

    switch (query.table) {
      case "metric_definitions":
        return { data: metrics };
      case "segment_definitions":
        return { data: [SEGMENT] };
      case "user_profiles":
        return { data: pageOf(db.profiles, query) };
      case "health_streaks":
        return { data: [] };
      case "meals":
        return { data: pageOf(mealsWithin(db.meals ?? [], query), query) };
      case "planned_meals":
        return { data: pageOf(db.planned, query) };
      case "badges":
        return { data: db.badges };

      case "user_metrics": {
        if (firstMethodOf(query) === "upsert") {
          db.saved.user_metrics.push(...upsertedRows(query));
          return { data: null };
        }
        // 前の期間の一括取得。バッジの改善率は userMetricsMap から引くので、利用者ごとの問い合わせは来ない
        // (来たら下の「利用者ごとの user_metrics 問い合わせが無い」テストで失敗する)
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
            metric_definitions: metrics
              .filter((m) => m.id === r.metric_id)
              .map((m) => ({ code: m.code, name: m.name, higher_is_better: m.higher_is_better }))[0],
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

// ── バッジ・ランキングの判定 ───────────────────────────────────────────────

/** 本番の badges (prod_reference_data.sql) のうち、この関数が扱うもの。条件はそのまま */
const BADGES = {
  rank1: { id: "b-rank1", code: "segment_rank_1", icon: "🏆", metric_code: null, condition_json: { type: "segment_rank", rank: 1 } },
  top3: { id: "b-top3", code: "segment_rank_top3", icon: "🥉", metric_code: null, condition_json: { type: "segment_rank", rank: 3 } },
  top25: { id: "b-top25", code: "segment_top_25", icon: "🎖️", metric_code: null, condition_json: { type: "segment_percentile", threshold: 75 } },
  aboveAvg: { id: "b-above", code: "segment_above_avg", icon: "⭐", metric_code: null, condition_json: { type: "segment_vs_avg", threshold: 0 } },
  aboveAvg20: { id: "b-above20", code: "segment_above_avg_20", icon: "⭐⭐", metric_code: null, condition_json: { type: "segment_vs_avg", threshold: 20 } },
  aboveAvg50: { id: "b-above50", code: "segment_above_avg_50", icon: "🌟", metric_code: null, condition_json: { type: "segment_vs_avg", threshold: 50 } },
  improved10: { id: "b-improved", code: "improved_10", icon: "📈", metric_code: null, condition_json: { type: "improvement", threshold: 10 } },
  breakfastChampion: { id: "b-bf-champion", code: "breakfast_champion", icon: "🌅🏆", metric_code: "breakfast_rate", condition_json: { type: "segment_rank", rank: 1 } },
  veggieChampion: { id: "b-veg-champion", code: "veggie_champion", icon: "🥦🏆", metric_code: "veg_score_avg", condition_json: { type: "segment_rank", rank: 1 } },
  streakChampion: { id: "b-streak-champion", code: "streak_champion", icon: "🔥🏆", metric_code: "record_streak", condition_json: { type: "segment_rank", rank: 1 } },
};
const ALL_BADGES = Object.values(BADGES);

/** 利用者番号 (uid(n) の n) */
const userNo = (id: string) => Number(id.slice(-12));

/**
 * 付与されたバッジを、バッジの code ごとに「付与先の利用者番号 (昇順)」にまとめる。
 * 同じ (user_id, badge_id) が 2 件保存されていたら例外にする (user_badges の主キーに反する)。
 */
function awardedByCode(db: Db): Record<string, number[]> {
  const codeById = new Map<string, string>(db.badges.map((b) => [b.id, b.code]));
  const seen = new Set<string>();
  const result: Record<string, number[]> = {};
  for (const award of db.saved.user_badges) {
    const key = `${award.user_id}:${award.badge_id}`;
    if (seen.has(key)) throw new Error(`同じ (user_id, badge_id) が 2 件保存された: ${key}`);
    seen.add(key);
    const code = codeById.get(award.badge_id);
    if (!code) throw new Error(`知らないバッジ: ${award.badge_id}`);
    (result[code] ??= []).push(userNo(award.user_id));
  }
  for (const users of Object.values(result)) users.sort((a, b) => a - b);
  return result;
}

/** 保存されたランキングから、(指標の id, 利用者番号) の [順位, 百分位, 平均比] を引く */
function rankingOf(db: Db, metricId: string, no: number): [number, number, number | null] {
  const row = db.saved.user_segment_rankings.find((r) => r.metric_id === metricId && r.user_id === uid(no));
  if (!row) throw new Error(`user_segment_rankings が保存されていない: u${no} / ${metricId}`);
  return [row.rank, row.percentile, row.vs_avg_rate];
}

/** 保存された結果を、利用者の取得順・保存順に左右されない形にそろえる */
function summarize(db: Db) {
  const rankings = db.saved.user_segment_rankings
    .map((r) => [r.metric_id, userNo(r.user_id), r.rank, r.percentile, r.vs_avg_rate])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]));
  return { rankings, awards: awardedByCode(db) };
}

const profilesOf = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: uid(i + 1), age_group: "30s", gender: "female", perf_modes: null }));

describe("calculate-segment-stats: ランキングの順位・平均比 (#1306)", () => {
  it("同じ値の利用者は同じ順位になり (競技方式)、利用者の並び (取得順) に左右されない", async () => {
    // 朝食実行率は 100 が 3 人 (u1〜u3)・0 が 2 人 (u4, u5)。野菜 4.0 と栄養 80 は 2 人 (u1, u2) が同じ値
    const forward = newDb({ badges: ALL_BADGES });
    install(forward);
    await call();

    // 利用者の取得順と食事の並びを逆にしても、順位もバッジも同じ
    const reversed = newDb({ badges: ALL_BADGES, profiles: [...forward.profiles].reverse(), planned: [...forward.planned].reverse() });
    install(reversed);
    await call();

    expect(summarize(reversed)).toEqual(summarize(forward));

    // [順位, 百分位, 平均比] (u1〜u5 の順)。同点は同じ順位で、次の順位はその人数ぶん飛ぶ (1, 1, 1, 4, 4)。
    // 百分位は「自分より厳密に下の利用者の割合」で、同点は最後の順位で数える
    // (例: 朝食実行率の u1〜u3 は 3 人同率なので、3 位ぶんの 40。5 人中 3 人 (60%) がいるのに、百分位 80 = 上位 20% とは言えない)
    const ranking = (metricId: string) => [1, 2, 3, 4, 5].map((n) => rankingOf(forward, metricId, n));
    expect(ranking("m-exec")).toEqual([[1, 80, 100], [2, 60, 50], [3, 40, 0], [4, 20, -50], [5, 0, -100]]);
    expect(ranking("m-bf")).toEqual([[1, 40, 67], [1, 40, 67], [1, 40, 67], [4, 0, -100], [4, 0, -100]]);
    expect(ranking("m-veg")).toEqual([[1, 60, 43], [1, 60, 43], [3, 40, 7], [4, 20, -29], [5, 0, -64]]);
    expect(ranking("m-nut")).toEqual([[1, 60, 43], [1, 60, 43], [3, 40, 7], [4, 20, -29], [5, 0, -64]]);

    // 1 位のバッジは、どれかの指標で 1 位 (同率を含む) の u1〜u3 全員に付く。u4・u5 には何も付かない。
    // 上位 25% (百分位 75 以上) は、同率のない メニュー実行率 の 1 位 (百分位 80) の u1 だけ
    expect(summarize(forward).awards).toEqual({
      segment_rank_1: [1, 2, 3],
      segment_rank_top3: [1, 2, 3],
      segment_top_25: [1],
      segment_above_avg: [1, 2, 3],
      segment_above_avg_20: [1, 2, 3],
      segment_above_avg_50: [1, 2, 3],
      breakfast_champion: [1, 2, 3], // 朝食実行率は u1〜u3 が同率 1 位
      veggie_champion: [1, 2], // 野菜スコアは u1・u2 が同率 1 位
    });
  });

  it("平均が 0 の指標は、平均との差の割合を 0 ではなく null で保存する (平均ちょうどと区別する)", async () => {
    const db = newDb({ planned: [] }); // 食事の予定が無い → 全指標が全員 0 で、平均も 0
    install(db);

    await call();

    expect(db.saved.user_segment_rankings).toHaveLength(20);
    for (const row of db.saved.user_segment_rankings) {
      expect(row.vs_avg_rate).toBeNull();
    }
  });
});

describe("calculate-segment-stats: 差の無い指標・実績の無い利用者にはバッジを付けない (#1306)", () => {
  it("5 人のセグメントで全員 0 の指標 → ランキングは保存するが、user_badges は 1 件も保存されない", async () => {
    // 食事の予定が 1 件も無い → メニュー実行率・朝食実行率・野菜スコア・栄養スコアが全員 0
    const db = newDb({ planned: [], badges: ALL_BADGES });
    const { queries } = install(db);

    const { res } = await call();

    expect(res.status).toBe(200);
    // 修正前は、全員に『平均超え』、取得順の先頭の 1 人に『1 位』『上位 25%』などが付いた
    // (平均 0 のとき平均比を 0 で保存し、閾値 0 を >= で比べていたため)
    expect(db.saved.user_badges).toEqual([]);
    expect(queriesOf(queries, "user_badges")).toEqual([]);
    // バッジ判定の手前で終わったのではなく、ランキングは作られている (全員 0 = 全員同率 1 位)
    expect(db.saved.user_segment_rankings).toHaveLength(20);
    for (const row of db.saved.user_segment_rankings) {
      expect(row).toMatchObject({ rank: 1, total_users: 5, percentile: 0, value: 0, vs_avg_rate: null });
    }
  });

  it("record_streak / breakfast_streak が全員 0 (アプリが書く streak_type と合わず読めない) でも、平均超え・1 位・継続チャンピオンは付かない", async () => {
    // 本番で起きる見込みの状況: health_streaks に 'meal_record' / 'breakfast' の行が無く、2 つの指標が全員 0
    const db = newDb({
      metrics: [
        { id: "m-rs", code: "record_streak", name: "記録継続日数", higher_is_better: true, is_active: true },
        { id: "m-bs", code: "breakfast_streak", name: "朝食継続日数", higher_is_better: true, is_active: true },
      ],
      badges: ALL_BADGES,
    });
    install(db);

    const { res } = await call();

    expect(res.status).toBe(200);
    expect(db.saved.user_segment_rankings).toHaveLength(10);
    expect(db.saved.user_badges).toEqual([]);
  });

  it("全員が同じ値 (0 でない) の指標も、順位・百分位・平均比のバッジの対象にしない", async () => {
    // 5 人とも朝食 1 件を完了して野菜スコア 3 → メニュー実行率 100・朝食実行率 100・野菜 3.0・栄養 60 が全員同じ
    const db = newDb({ planned: [1, 2, 3, 4, 5].map((n) => pm(n, "breakfast", true, 3)), badges: ALL_BADGES });
    install(db);

    await call();

    // 全員が同率 1 位 (自分より下の人はいないので百分位 0)、平均比は 0%。
    // 「1 位」「3 位以内」の条件は形の上では満たすが、差が無いので付けない
    for (const row of db.saved.user_segment_rankings) {
      expect(row).toMatchObject({ rank: 1, percentile: 0, vs_avg_rate: 0 });
    }
    expect(db.saved.user_badges).toEqual([]);
  });

  it("高い方が良い指標で値が 0 以下の利用者には、順位・百分位のバッジを付けない (実績のある 1 人だけに付く)", async () => {
    // u1 だけ朝食を完了。u2〜u5 は予定が無く、全指標が 0 (4 人は同率 2 位になる)
    const db = newDb({ planned: [pm(1, "breakfast", true, 5)], badges: ALL_BADGES });
    install(db);

    await call();

    expect(rankingOf(db, "m-exec", 1)).toEqual([1, 80, 400]);
    expect(rankingOf(db, "m-exec", 2)).toEqual([2, 0, -100]);
    expect(rankingOf(db, "m-exec", 5)).toEqual([2, 0, -100]);
    // 0 の 4 人は「3 位以内 (同率 2 位)」だが、実績が無いので何も付かない
    expect(awardedByCode(db)).toEqual({
      segment_rank_1: [1],
      segment_rank_top3: [1],
      segment_top_25: [1],
      segment_above_avg: [1],
      segment_above_avg_20: [1],
      segment_above_avg_50: [1],
      breakfast_champion: [1],
      veggie_champion: [1],
    });
  });

  it("平均ちょうど (平均比 0%) の利用者には『平均超え』を付けない。平均を超えた利用者には付く", async () => {
    // 野菜スコアは u1〜u5 が 1〜5 (平均 3)、栄養スコアは 20〜100 (平均 60)。メニュー実行率・朝食実行率は全員 100 で差が無い
    const db = newDb({ planned: [1, 2, 3, 4, 5].map((n) => pm(n, "breakfast", true, n)), badges: ALL_BADGES });
    install(db);

    await call();

    expect(rankingOf(db, "m-veg", 3)).toEqual([3, 40, 0]);
    expect(awardedByCode(db)).toEqual({
      segment_rank_1: [5],
      segment_rank_top3: [3, 4, 5],
      segment_top_25: [5],
      segment_above_avg: [4, 5], // u3 は平均ちょうど (0%) なので入らない
      segment_above_avg_20: [4, 5],
      segment_above_avg_50: [5],
      veggie_champion: [5], // 朝食実行率は全員 100 で差が無いので、breakfast_champion は付かない
    });
  });

  it("最大値が 0 以下の行 (過去の実行で残った行など) は、値に差があっても順位・平均比のバッジの対象にしない", async () => {
    // 今の指標は 0 以上の値しか取らないが、念のための歯止め。値が [-1, -2, -3, -4, -5] (最大 -1) の行が残っているとする。
    // 今回の計算結果は全員 0 で、バッジは付かない
    const db = newDb({ planned: [], badges: ALL_BADGES });
    db.saved.user_segment_rankings.push(
      ...[1, 2, 3, 4, 5].map((n) => ({
        user_id: uid(n),
        segment_id: "s-old",
        metric_id: "m-exec",
        period_type: "weekly",
        rank: n,
        total_users: 5,
        percentile: Math.round(((5 - n) / 5) * 100),
        value: -n,
        vs_avg_rate: 90 - 30 * n, // 60, 30, 0, -30, -60
      })),
    );
    install(db);

    const { res } = await call();

    expect(res.status).toBe(200);
    expect(db.saved.user_badges).toEqual([]);
  });

  it("higher_is_better = false の指標は、低い方が上位。平均比・改善の向きも逆になり、0 が最良でも順位のバッジは付く", async () => {
    // 野菜スコア (低い方が良いと仮定): u1 は評価なし (= 0)、u2〜u5 は 2〜5。平均 2.8
    const db = newDb({
      metrics: [{ id: "m-veg", code: "veg_score_avg", name: "野菜スコア", higher_is_better: false, is_active: true }],
      planned: [pm(1, "breakfast", true, null), pm(2, "breakfast", true, 2), pm(3, "breakfast", true, 3), pm(4, "breakfast", true, 4), pm(5, "breakfast", true, 5)],
      // 前の期間: u2 は 4 → 2 (下がった = 改善)、u4 は 2 → 4 (上がった = 悪化)
      prevMetrics: [{ user_id: uid(2), metric_id: "m-veg", value: 4 }, { user_id: uid(4), metric_id: "m-veg", value: 2 }],
      badges: ALL_BADGES,
    });
    install(db);

    await call();

    // 低い順に 1 位〜5 位。平均比は値そのままの割合 (平均より低いと負)
    expect([1, 2, 3, 4, 5].map((n) => rankingOf(db, "m-veg", n))).toEqual([[1, 80, -100], [2, 60, -29], [3, 40, 7], [4, 20, 43], [5, 0, 79]]);
    expect(db.saved.user_metrics.find((r) => r.user_id === uid(2))).toMatchObject({ value: 2, previous_value: 4, change_rate: -50 });
    expect(awardedByCode(db)).toEqual({
      segment_rank_1: [1],
      segment_rank_top3: [1, 2, 3],
      segment_top_25: [1],
      segment_above_avg: [1, 2], // 平均より低い = 平均を上回っている
      segment_above_avg_20: [1, 2], // u2 は平均より 29% 良い
      segment_above_avg_50: [1],
      veggie_champion: [1],
      improved_10: [2], // 4 → 2 は 50% の改善。u4 の 2 → 4 は悪化なので付かない
    });
    expect(db.saved.user_badges.find((a) => a.badge_id === "b-improved")).toMatchObject({ user_id: uid(2), message: "📈 野菜スコアが50%改善！" });
  });
});

describe("calculate-segment-stats: バッジの付与 (#1306)", () => {
  it("badges は condition_json->>type (text) で絞る。`->` (jsonb) だと eq.segment_rank が json として解釈されて 22P02 になる", async () => {
    const { queries } = install(newDb());

    await call();

    const filter = argsOf(queriesOf(queries, "badges")[0], "or")[0][0] as string;
    for (const type of ["segment_rank", "segment_percentile", "segment_vs_avg", "improvement"]) {
      expect(filter).toContain(`condition_json->>type.eq.${type}`);
    }
    expect(filter).not.toMatch(/condition_json->type/);
  });

  it("1 位 (同率を含む) の利用者に順位バッジを付与し、付与の記録に期間・セグメント・指標・順位を残す", async () => {
    const db = newDb({ badges: [BADGES.rank1] });
    install(db);

    const { res, json } = await call();

    expect(res.status).toBe(200);
    // 1 位は、メニュー実行率が u1、朝食実行率が u1〜u3、野菜スコア・栄養スコアが u1・u2。取得順に左右されない
    expect(awardedByCode(db)).toEqual({ segment_rank_1: [1, 2, 3] });
    for (const award of db.saved.user_badges) {
      expect(award).toMatchObject({
        badge_id: "b-rank1",
        message: expect.stringMatching(/^🏆 全ユーザーの.+で1位！$/),
        context_json: expect.objectContaining({ segment_id: "s-all", rank: 1, period_type: "weekly", period_start: json.periodStart }),
      });
      expect(METRICS.map((m) => m.id)).toContain(award.context_json.metric_id);
    }
  });

  it("前の期間より 10% 以上伸びた利用者に改善バッジを付与する (改善率は計算済みの値を使う)", async () => {
    const db = newDb({
      badges: [BADGES.improved10],
      prevMetrics: [
        { user_id: uid(1), metric_id: "m-exec", value: 50 }, // 50 → 100 (+100%)
        { user_id: uid(3), metric_id: "m-bf", value: 50 }, // 50 → 100 (+100%)
        { user_id: uid(2), metric_id: "m-exec", value: 70 }, // 70 → 75 (+7%) は 10% に届かない
        { user_id: uid(5), metric_id: "m-exec", value: 10 }, // 10 → 0 (-100%) は悪化
      ],
    });
    install(db);

    await call();

    expect(awardedByCode(db)).toEqual({ improved_10: [1, 3] });
    const message = (no: number) => db.saved.user_badges.find((a) => a.user_id === uid(no))?.message;
    expect(message(1)).toBe("📈 メニュー実行率が100%改善！");
    expect(message(3)).toBe("📈 朝食実行率が100%改善！");
  });

  it("badges の取得に失敗したら、バッジ無しとして黙って終わらず 500 で返してログに残す", async () => {
    const db = newDb({
      badges: [BADGES.rank1],
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

  it("バッジの保存に失敗したときも、無視せず 500 で返す", async () => {
    const db = newDb({
      badges: [BADGES.rank1],
      fail: (q) => (q.table === "user_badges" ? { message: "boom", code: "XX000" } : undefined),
    });
    install(db);

    const { res, json } = await call();

    expect(res.status).toBe(500);
    expect(json.error).toContain("user_badges の保存");
    expect(h.errors).toHaveLength(1);
  });

  it("ランキングの取得に失敗したときも、無視せず 500 で返す", async () => {
    const db = newDb({
      badges: [BADGES.rank1],
      fail: (q) => (q.table === "user_segment_rankings" && firstMethodOf(q) === "select" ? { message: "boom", code: "XX000" } : undefined),
    });
    install(db);

    const { res, json } = await call();

    expect(res.status).toBe(500);
    expect(json.error).toContain("user_segment_rankings の取得");
  });
});

describe("calculate-segment-stats: まとめて保存する (往復を減らす) (#1306)", () => {
  it("ランキングは利用者ごとではなく、セグメント×指標ごとにまとめて upsert する。利用者ごとの user_metrics 問い合わせは無い", async () => {
    const db = newDb({ badges: ALL_BADGES, prevMetrics: [{ user_id: uid(1), metric_id: "m-exec", value: 50 }] });
    const { queries } = install(db);

    await call();

    const rankingUpserts = queriesOf(queries, "user_segment_rankings").filter((q) => firstMethodOf(q) === "upsert");
    expect(rankingUpserts.map((q) => upsertedRows(q).length)).toEqual([5, 5, 5, 5]); // 1 セグメント × 4 指標、各 5 人
    expect(argsOf(rankingUpserts[0], "upsert")[0][1]).toEqual({ onConflict: "user_id,segment_id,metric_id,period_type,period_start" });
    expect(db.saved.user_segment_rankings).toHaveLength(20);

    // バッジは (利用者, バッジ) ごとに 1 行だけを、1 回の upsert にまとめて送る。すでに持っていれば何もしない
    const badgeUpserts = queriesOf(queries, "user_badges");
    expect(badgeUpserts).toHaveLength(1);
    expect(argsOf(badgeUpserts[0], "upsert")[0][1]).toEqual({ onConflict: "user_id,badge_id", ignoreDuplicates: true });
    expect(upsertedRows(badgeUpserts[0])).toHaveLength(db.saved.user_badges.length);

    // user_metrics は、前の期間の一括取得と保存だけ。改善バッジの判定で、利用者・指標ごとに引き直さない
    const userMetricQueries = queriesOf(queries, "user_metrics");
    expect(userMetricQueries.filter((q) => eqValue(q, "user_id") !== undefined)).toEqual([]);
    expect(userMetricQueries.filter((q) => firstMethodOf(q) === "select")).toHaveLength(1);
  });

  it("ランキングは 200 行ずつに分けて保存する", async () => {
    const db = newDb({ profiles: profilesOf(205), planned: [] });
    const { queries } = install(db);

    const { res } = await call();

    expect(res.status).toBe(200);
    const sizes = queriesOf(queries, "user_segment_rankings")
      .filter((q) => firstMethodOf(q) === "upsert")
      .map((q) => upsertedRows(q).length);
    expect(sizes).toEqual([200, 5, 200, 5, 200, 5, 200, 5]); // 4 指標 × (200 + 5)
    expect(db.saved.user_segment_rankings).toHaveLength(205 * 4);
  });

  it("バッジは 200 件ずつに分けて保存し、同じ (利用者, バッジ) は 1 件だけ送る", async () => {
    // 230 人のうち前半の 115 人だけが朝食を完了 (野菜スコアは 1〜5 を順に)。後半の 115 人は何も記録していない
    const db = newDb({
      profiles: profilesOf(230),
      planned: Array.from({ length: 115 }, (_, i) => pm(i + 1, "breakfast", true, (i % 5) + 1)),
      badges: ALL_BADGES,
    });
    const { queries } = install(db);

    const { res } = await call();

    expect(res.status).toBe(200);
    // 前半の 115 人にはそれぞれ 6 種類 (1 位・3 位以内・平均超え 3 種・朝食チャンピオン。メニュー実行率と朝食実行率は
    // 115 人が同率 1 位で、百分位は 50)。上位 25% は、野菜スコア 5 と 4 の 23 人ずつ (百分位 90 と 80)、
    // 野菜チャンピオンは野菜スコア 5 の 23 人。後半の 115 人 (実績なし) には何も付かない。
    // 同じ利用者・同じバッジが複数の指標で条件を満たしても、送る行は 1 件 (awardedByCode が重複を例外にする)
    const awards = awardedByCode(db);
    expect(awards.segment_top_25).toHaveLength(46);
    expect(awards.veggie_champion).toHaveLength(23);
    expect(Object.values(awards).reduce((sum, users) => sum + users.length, 0)).toBe(115 * 6 + 46 + 23);
    expect(Math.max(...Object.values(awards).flat())).toBe(115);

    const sizes = queriesOf(queries, "user_badges").map((q) => upsertedRows(q).length);
    expect(sizes).toEqual([200, 200, 200, 159]);
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

// ── 集計期間は JST の暦で決まる (#1211) ──────────────────────────────────────
//
// Edge Function (Deno) の実行環境のタイムゾーンは UTC。以前は new Date() の getDay() / getDate() / getMonth() で期間を求めていたので、
// JST の 00:00〜08:59 (UTC では前日) の間は、月曜の早朝が日曜日扱いで週の開始日が 1 週間前の月曜に、月初は前月に、毎日は前日になっていた。
// 時刻は Date だけを固定する (setTimeout などには触れない)。期間の求め方そのものは tests/jst-period.test.ts が確かめる。
// ここでは、ハンドラがその期間を、保存・読み出し・前の期間の探索・meals の絞り込みの全部に使うことを見る。

/** 現在時刻 (Date) を固定する */
function setNow(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

describe("calculate-segment-stats: 集計期間は JST の暦で決まる (#1211)", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // [periodType, 現在時刻 (UTC), 期間の開始日, 期間の終了日, 説明]
  const boundaries: Array<[string, string, string, string, string]> = [
    ["weekly", "2026-07-12T14:59:59.999Z", "2026-07-06", "2026-07-12", "JST 日曜 7/12 23:59:59 は、まだ前の週"],
    ["weekly", "2026-07-12T15:00:00.000Z", "2026-07-13", "2026-07-19", "JST 月曜 7/13 0:00 から新しい週 (UTC はまだ日曜。修正前は前の週のままだった)"],
    ["weekly", "2026-07-12T23:59:59.999Z", "2026-07-13", "2026-07-19", "JST 月曜 7/13 8:59:59 も新しい週 (UTC はまだ日曜)"],
    ["monthly", "2026-07-31T14:59:59.999Z", "2026-07-01", "2026-07-31", "JST 7/31 23:59:59 は、まだ 7 月"],
    ["monthly", "2026-07-31T15:00:00.000Z", "2026-08-01", "2026-08-31", "JST 8/1 0:00 から 8 月 (UTC はまだ 7/31。修正前は 7 月のままだった)"],
    ["daily", "2026-07-12T14:59:59.999Z", "2026-07-12", "2026-07-12", "JST 7/12 23:59:59 は、まだ 7/12"],
    ["daily", "2026-07-12T15:00:00.000Z", "2026-07-13", "2026-07-13", "JST 7/13 0:00 から 7/13 (UTC はまだ 7/12。修正前は前日のままだった)"],
    ["all_time", "2026-07-12T15:00:00.000Z", "2024-01-01", "2026-07-13", "全期間は 2024-01-01 から JST の今日まで"],
  ];

  it.each(boundaries)("%s @ %s → %s 〜 %s (%s)", async (periodType, now, start, end) => {
    setNow(now);
    const db = newDb();
    const { queries } = install(db);

    const { res, json } = await call({ periodType });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ periodType, periodStart: start, periodEnd: end });

    // 保存する行は、すべて同じ期間
    expect(db.saved.user_metrics).toHaveLength(20);
    for (const row of db.saved.user_metrics) {
      expect(row).toMatchObject({ period_type: periodType, period_start: start, period_end: end });
    }
    expect(db.saved.segment_stats).toHaveLength(4);
    for (const row of db.saved.segment_stats) {
      expect(row).toMatchObject({ period_type: periodType, period_start: start, period_end: end });
    }
    expect(db.saved.user_segment_rankings).toHaveLength(20);
    for (const row of db.saved.user_segment_rankings) {
      expect(row).toMatchObject({ period_type: periodType, period_start: start });
    }

    // 食事の予定 (day_date は JST の暦日) は、その期間の開始日と終了日で絞る
    const planned = queriesOf(queries, "planned_meals");
    expect(argsOf(planned[0], "gte")).toEqual([["user_daily_meals.day_date", start]]);
    expect(argsOf(planned[0], "lte")).toEqual([["user_daily_meals.day_date", end]]);
  });

  // [periodType, 現在時刻 (UTC), 今の期間の開始日, 前の期間の開始日]
  const previousPeriods: Array<[string, string, string, string]> = [
    ["weekly", "2026-07-12T15:00:00.000Z", "2026-07-13", "2026-07-06"],
    ["weekly", "2026-12-31T15:00:00.000Z", "2026-12-28", "2026-12-21"], // 年またぎ (JST 2027/1/1 金曜の週)
    ["monthly", "2026-07-31T15:00:00.000Z", "2026-08-01", "2026-07-01"],
    ["monthly", "2026-12-31T15:00:00.000Z", "2027-01-01", "2026-12-01"], // 年またぎ
    ["monthly", "2027-02-28T15:00:00.000Z", "2027-03-01", "2027-02-01"],
  ];

  it.each(previousPeriods)("前の期間の探索: %s @ %s は、今の期間 %s の 1 つ前 (%s) の user_metrics を読む", async (periodType, now, start, previousStart) => {
    setNow(now);
    const db = newDb();
    const { queries } = install(db);

    const { json } = await call({ periodType });

    expect(json.periodStart).toBe(start);
    const previous = queriesOf(queries, "user_metrics").filter((q) => firstMethodOf(q) === "select");
    expect(previous).toHaveLength(1);
    expect(eqValue(previous[0], "period_type")).toBe(periodType);
    expect(eqValue(previous[0], "period_start")).toBe(previousStart);
  });

  it("毎日 (daily) と全期間 (all_time) は、前の期間を探さない", async () => {
    for (const periodType of ["daily", "all_time"]) {
      setNow("2026-07-12T15:00:00.000Z");
      const { queries } = install(newDb());

      await call({ periodType });

      expect(queriesOf(queries, "user_metrics").filter((q) => firstMethodOf(q) === "select"), periodType).toEqual([]);
    }
  });

  it("前の期間の開始日は、実行環境のタイムゾーン (サマータイムのある地域も含む) に左右されない", async () => {
    // 米国西海岸は 2026-11-01 にサマータイムが終わる。ローカル時刻の setDate() で 7 日戻すと、日付がずれる地域がある。
    // 2026-11-01T15:00Z は JST 月曜 11/2 0:00 → 今週は 11/2 始まり、前の週は 10/26 始まり
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Europe/London", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      setNow("2026-11-01T15:00:00.000Z");
      const { queries } = install(newDb());

      const { json } = await call({ periodType: "weekly" });

      expect(json.periodStart, tz).toBe("2026-11-02");
      const previous = queriesOf(queries, "user_metrics").filter((q) => firstMethodOf(q) === "select");
      expect(eqValue(previous[0], "period_start"), tz).toBe("2026-10-26");
    }
  });

  it("meals (timestamptz) は、期間の初日の JST 0 時〜終了日の翌日の JST 0 時の手前で絞り、記録した日数は JST の暦日で数える", async () => {
    setNow("2026-07-12T15:00:00.000Z"); // JST 月曜 7/13 0:00 → 今週は 7/13〜7/19
    const meal = (no: number, eatenAt: string) => ({ user_id: uid(no), eaten_at: eatenAt });
    const db = newDb({
      metrics: [{ id: "m-rec", code: "weekly_record_rate", name: "週の記録率", higher_is_better: true, is_active: true }],
      planned: [],
      meals: [
        // u1: JST 月曜 8:30 と 9:30。UTC では 7/12 と 7/13 の別の日だが、JST ではどちらも 7/13 → 1 日
        meal(1, "2026-07-12T23:30:00+00:00"),
        meal(1, "2026-07-13T00:30:00+00:00"),
        // u2: JST 日曜 7/12 23:30 (前の週の最後) → 今週には数えない
        meal(2, "2026-07-12T14:30:00+00:00"),
        // u3: JST 日曜 7/19 23:30 (今週の最後) → 1 日
        meal(3, "2026-07-19T14:30:00+00:00"),
        // u4: JST 月曜 7/20 0:30 (次の週の最初) → 今週には数えない
        meal(4, "2026-07-19T15:30:00+00:00"),
      ],
    });
    const { queries } = install(db);

    const { res, json } = await call({ periodType: "weekly" });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ periodStart: "2026-07-13", periodEnd: "2026-07-19" });

    // 期間内の meals の問い合わせ (全期間の件数を数える問い合わせは eaten_at で絞らない)
    const inPeriod = queriesOf(queries, "meals").filter((q) => argsOf(q, "gte").length > 0);
    expect(inPeriod).toHaveLength(1);
    expect(argsOf(inPeriod[0], "gte")).toEqual([["eaten_at", "2026-07-12T15:00:00.000Z"]]); // JST 7/13 0:00 (含む)
    expect(argsOf(inPeriod[0], "lt")).toEqual([["eaten_at", "2026-07-19T15:00:00.000Z"]]); // JST 7/20 0:00 (含まない)
    expect(argsOf(inPeriod[0], "lte")).toEqual([]);

    // 7 日間のうち記録した日数の割合 (1 日 → 14%)
    const rate = (no: number) => metricRow(db, no, "m-rec").value;
    expect([1, 2, 3, 4, 5].map(rate)).toEqual([14, 0, 14, 0, 0]);
  });
});

// ── 定期実行・手動実行のどちらでも、直近の 1 期間だけを集計する (#1406) ─────────────────
//
// 定期実行: pg_cron のジョブ calculate-segment-stats が毎時 5 分に public.invoke_calculate_segment_stats() を呼び、
//   CRON_SECRET (Vault の app_cron_secret) を付けて、本文 { periodType } で daily / weekly / monthly の 3 回この関数を呼ぶ
//   (supabase/migrations/20261009100000_schedule_calculate_segment_stats.sql)。期間が切り替わった直後の回 (JST 0 時台) は、
//   切り替わった種類について本文 { periodType, previousPeriod: true } でも呼び、直前の期間を 1 回だけ集計し直す
//   (期間の最後の 1 時間の記録を、その期間の最終の値に入れるため)。
// 手動実行: POST /api/comparison/trigger (super_admin だけ) が service role の鍵を付けて、本文 { periodType } で呼ぶ。
// 初回も含めて、過去の期間の埋め戻しはしない (オーナーの選択 2026-10-09)。関数は本文から期間の日付を受け取らず、
// 実行した時刻 (JST) が属する期間 (previousPeriod: true なら、その 1 つ前) の 1 つだけを書く。
// 本文に期間の開始日などを書いても無視されることを、ここで固定する。

describe("calculate-segment-stats: 定期実行・手動実行のどちらでも直近の 1 期間だけを集計する (#1406)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ジョブが動く時刻: UTC 日曜 2026-10-11 19:05 = JST 月曜 2026-10-12 4:05。
  // UTC の暦ではまだ日曜 (前の週・前日) なので、JST で求めていなければ期間がずれる
  const CRON_FIRED_AT = "2026-10-11T19:05:00.000Z";
  // [periodType, 期間の開始日, 期間の終了日] (JST 月曜 10/12 が属する期間)
  const expectedPeriods: Array<[string, string, string]> = [
    ["daily", "2026-10-12", "2026-10-12"],
    ["weekly", "2026-10-12", "2026-10-18"],
    ["monthly", "2026-10-01", "2026-10-31"],
  ];

  /** 保存された行の (period_type, period_start, period_end) の組を重複なしで返す */
  function savedPeriods(db: Db): string[] {
    const rows = [
      ...db.saved.user_metrics,
      ...db.saved.segment_stats,
      ...db.saved.user_segment_rankings.map((r) => ({ ...r, period_end: "(なし)" })),
    ];
    return [...new Set(rows.map((r) => `${r.period_type} ${r.period_start} ${r.period_end}`))].sort();
  }

  // [呼び方, 認証ヘッダー, 本文に periodType 以外を足すか]
  const callers: Array<[string, Record<string, string>, Record<string, unknown>]> = [
    ["定期実行 (pg_cron: CRON_SECRET・本文は periodType だけ)", { authorization: `Bearer ${CRON_SECRET}` }, {}],
    ["手動実行 (trigger API: service role の鍵・本文は periodType だけ)", { authorization: "Bearer test-service-role" }, {}],
    [
      "本文に過去の期間・再計算の指定を書いた呼び出し",
      { authorization: `Bearer ${CRON_SECRET}` },
      { periodStart: "2025-01-06", periodEnd: "2025-01-12", forceRecalc: true, backfill: 12 },
    ],
  ];

  for (const [caller, headers, extraBody] of callers) {
    it.each(expectedPeriods)(`${caller}: %s は JST の実行時刻が属する期間 %s 〜 %s の 1 つだけを書く`, async (periodType, start, end) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(CRON_FIRED_AT));
      const db = newDb();
      const { queries } = install(db);

      const { res, json } = await call({ periodType, ...extraBody }, headers);

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ success: true, periodType, periodStart: start, periodEnd: end });

      // 書いた行の期間は 1 つだけ (user_segment_rankings に period_end の列は無い)
      expect(db.saved.user_metrics.length).toBeGreaterThan(0);
      expect(db.saved.segment_stats.length).toBeGreaterThan(0);
      expect(db.saved.user_segment_rankings.length).toBeGreaterThan(0);
      expect(savedPeriods(db)).toEqual(
        [`${periodType} ${start} ${end}`, `${periodType} ${start} (なし)`].sort(),
      );

      // 読み取りも、その 1 期間だけ (食事の予定はその期間の日付)
      const planned = queriesOf(queries, "planned_meals");
      expect(planned).toHaveLength(1);
      expect(argsOf(planned[0], "gte")).toEqual([["user_daily_meals.day_date", start]]);
      expect(argsOf(planned[0], "lte")).toEqual([["user_daily_meals.day_date", end]]);
      // 集計結果の読み直し (平均との比較に使う segment_stats) も、その期間の開始日だけ。
      // user_metrics の読み取りは、変化率のための「1 つ前の期間」(書き込みはしない) なので、ここでは見ない
      const statsReads = queriesOf(queries, "segment_stats").filter((q) => firstMethodOf(q) === "select");
      expect(statsReads.length, "segment_stats の読み直しが発行されていること").toBeGreaterThan(0);
      for (const q of statsReads) {
        expect(eqValue(q, "period_type")).toBe(periodType);
        expect(eqValue(q, "period_start")).toBe(start);
      }
    });
  }
});

// ── 期間が切り替わった直後の回は、直前の期間を集計し直す (previousPeriod: true) (#1406) ─────────────────
describe("calculate-segment-stats: previousPeriod: true は、今の期間の 1 つ前の期間だけを集計し直す (#1406)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // JST 月曜 2027-02-01 0:05 (UTC 日曜 2027-01-31 15:05)。日・週・月が同時に切り替わった直後の回
  const FIRST_RUN_OF_PERIOD_AT = "2027-01-31T15:05:00.000Z";
  // [periodType, 直前の期間の開始日, 終了日]
  const previousPeriods: Array<[string, string, string]> = [
    ["daily", "2027-01-31", "2027-01-31"],
    ["weekly", "2027-01-25", "2027-01-31"],
    ["monthly", "2027-01-01", "2027-01-31"],
  ];

  it.each(previousPeriods)("%s: 直前の期間 %s 〜 %s の 1 つだけを読み、書く", async (periodType, start, end) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIRST_RUN_OF_PERIOD_AT));
    const db = newDb();
    const { queries } = install(db);

    const { res, json } = await call({ periodType, previousPeriod: true });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, periodType, previousPeriod: true, periodStart: start, periodEnd: end });

    const written = [
      ...db.saved.user_metrics.map((r) => `${r.period_type} ${r.period_start} ${r.period_end}`),
      ...db.saved.segment_stats.map((r) => `${r.period_type} ${r.period_start} ${r.period_end}`),
      ...db.saved.user_segment_rankings.map((r) => `${r.period_type} ${r.period_start}`),
    ];
    expect(written.length).toBeGreaterThan(0);
    expect([...new Set(written)].sort()).toEqual([`${periodType} ${start}`, `${periodType} ${start} ${end}`].sort());

    const planned = queriesOf(queries, "planned_meals");
    expect(planned).toHaveLength(1);
    expect(argsOf(planned[0], "gte")).toEqual([["user_daily_meals.day_date", start]]);
    expect(argsOf(planned[0], "lte")).toEqual([["user_daily_meals.day_date", end]]);
  });

  it.each(previousPeriods)("%s: previousPeriod が false・省略なら、今の期間 (直前の期間ではない) を集計する", async (periodType, previousStart) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIRST_RUN_OF_PERIOD_AT));
    for (const body of [{ periodType }, { periodType, previousPeriod: false }]) {
      install(newDb());
      const { res, json } = await call(body);
      expect(res.status).toBe(200);
      expect(json).toMatchObject({ success: true, periodType, previousPeriod: false });
      expect((json as { periodStart: string }).periodStart).not.toBe(previousStart);
    }
  });

  it.each([
    ["all_time は直前の期間が無い", { periodType: "all_time", previousPeriod: true }],
    ["不明な種類", { periodType: "yearly", previousPeriod: true }],
    ["previousPeriod が文字列", { periodType: "daily", previousPeriod: "true" }],
    ["previousPeriod が数値", { periodType: "daily", previousPeriod: 1 }],
  ])("%s → 400 で、何も読まず何も書かない", async (_label, body) => {
    const db = newDb();
    const { queries } = install(db);

    const { res, json } = await call(body);

    expect(res.status).toBe(400);
    expect(json).toEqual({ error: expect.any(String) });
    expect(queries).toHaveLength(0);
    expect(db.saved.user_metrics).toHaveLength(0);
    expect(db.saved.segment_stats).toHaveLength(0);
    expect(db.saved.user_segment_rankings).toHaveLength(0);
  });
});
