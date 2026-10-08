// @vitest-environment node
//
// #1306: aggregate-org-stats は planned_meals を `meal_plan_days!inner(day_date, meal_plans!inner(user_id))` で
// 取得していた。この 2 テーブルは date-based model への移行で削除済み (本番にも無い) ため、クエリは必ず
// PGRST200 で失敗し、メンバーのいる組織の集計は一度も作られなかった。しかも失敗はログに残して 200 を返していた。
// 所有者と日付は user_daily_meals (planned_meals.daily_meal_id でつながる) にある。
//
// Edge Function 本体は Deno.serve を import 時に呼ぶ。Deno・supabase-js・ロガーを差し替えて本物のハンドラを取り出し、
// 実際に呼んで、発行されたクエリ・計算結果・失敗時の振る舞いを確かめる。
//
// 注意: このテストの supabase-js は偽物なので、PostgREST が実際にこのクエリを受け付けるかは確かめない。
// 実 DB での確認は tests/integration/rls/stats-edge-functions-user-daily-meals.test.ts が担当する。
// 対象日を省略したときの日付 (JST の今日) は #1210 の担当で、ここでは常に date を明示する。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  argsOf,
  createRecordingSupabase,
  eqValue,
  pageOf,
  queriesOf,
  type QueryOutcome,
  type RecordedQuery,
} from "./helpers/recording-supabase";

const CRON_SECRET = "test-cron-secret";
const DATE = "2026-10-08";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const h = vi.hoisted(() => ({
  serve: null as null | ((req: Request) => Promise<Response>),
  client: null as null | { from: (table: string) => unknown },
  errors: [] as Array<{ message: string; error: unknown; metadata: unknown }>,
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
    error: (message: string, error?: unknown, metadata?: unknown) => {
      h.errors.push({ message, error, metadata });
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
  h.errors.length = 0;
  h.client = null;
});

// ── 偽の DB ──────────────────────────────────────────────────────────────────

interface MealRow {
  id: string;
  meal_type: string;
  is_completed: boolean;
  completed_at: string | null;
  veg_score: number | null;
  user_daily_meals: { user_id: string; day_date: string };
}

let mealSeq = 0;

function meal(
  userNo: number,
  mealType: string,
  options: { completedAt?: string; completed?: boolean; vegScore?: number } = {},
): MealRow {
  mealSeq += 1;
  return {
    id: `meal-${mealSeq}`,
    meal_type: mealType,
    is_completed: options.completed ?? options.completedAt !== undefined,
    completed_at: options.completedAt ?? null,
    veg_score: options.vegScore ?? null,
    user_daily_meals: { user_id: uid(userNo), day_date: DATE },
  };
}

interface World {
  orgs: string[];
  /** 組織ごとのメンバー */
  members: Record<string, string[]>;
  /** 対象日の planned_meals (全員分)。所有者は user_daily_meals.user_id */
  meals: MealRow[];
  /** 失敗させたいクエリなら error を返す */
  fail?: (query: RecordedQuery) => QueryOutcome["error"] | undefined;
}

function install(world: World) {
  const recording = createRecordingSupabase((query) => {
    const failure = world.fail?.(query);
    if (failure) return { error: failure };
    switch (query.table) {
      case "organizations": {
        const id = eqValue(query, "id");
        return { data: world.orgs.filter((o) => id === undefined || o === id).map((o) => ({ id: o })) };
      }
      case "user_profiles":
        return { data: (world.members[eqValue(query, "organization_id") as string] ?? []).map((id) => ({ id })) };
      case "planned_meals": {
        const userIds = argsOf(query, "in").find((args) => args[0] === "user_daily_meals.user_id")?.[1] as string[];
        return { data: pageOf(world.meals.filter((m) => userIds.includes(m.user_daily_meals.user_id)), query) };
      }
      default:
        return { data: null }; // org_daily_stats の upsert
    }
  });
  h.client = recording.client;
  return recording;
}

async function call(body: Record<string, unknown> = {}, headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  if (!h.serve) throw new Error("Deno.serve のハンドラを取得できていません");
  const res = await h.serve(
    new Request("http://localhost/functions/v1/aggregate-org-stats", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: await res.json() };
}

/** org_daily_stats に保存された行 (upsert の第 1 引数) */
function savedStats(queries: RecordedQuery[]) {
  return queriesOf(queries, "org_daily_stats").map((q) => argsOf(q, "upsert")[0][0] as Record<string, unknown>);
}

// ── テスト ───────────────────────────────────────────────────────────────────

describe("aggregate-org-stats: planned_meals を user_daily_meals 経由で読む (#1306)", () => {
  it("存在しない meal_plan_days / meal_plans は使わず、user_daily_meals!inner で対象日・非ハンズオン・メンバーに絞る", async () => {
    const { queries } = install({ orgs: [ORG_A], members: { [ORG_A]: [uid(1), uid(2)] }, meals: [] });

    const { res } = await call({ date: DATE, organizationId: ORG_A });
    expect(res.status).toBe(200);

    // どのクエリも、削除済みのテーブル名を含まない
    expect(JSON.stringify(queries)).not.toMatch(/meal_plan/);

    const planned = queriesOf(queries, "planned_meals");
    expect(planned).toHaveLength(1);
    const [select] = argsOf(planned[0], "select")[0] as [string];
    expect(select).toContain("user_daily_meals!inner(user_id, day_date)");
    for (const column of ["id", "meal_type", "is_completed", "completed_at", "veg_score"]) {
      expect(select).toContain(column);
    }
    // day_date は date 型 (JST の暦日)。対象日の文字列とそのまま比較する
    expect(argsOf(planned[0], "eq")).toEqual([
      ["user_daily_meals.day_date", DATE],
      // ハンズオン (チュートリアル) 用の仮データは実際の食事ではないので除く
      ["user_daily_meals.is_sandbox", false],
    ]);
    expect(argsOf(planned[0], "in")).toEqual([["user_daily_meals.user_id", [uid(1), uid(2)]]]);
    // 件数が上限未満なら、order / range を足さず 1 回で終わる
    expect(argsOf(planned[0], "range")).toEqual([]);
  });

  it("date を指定したときは、その日付で絞って、その日付で保存する", async () => {
    const { queries } = install({ orgs: [ORG_A], members: { [ORG_A]: [uid(1)] }, meals: [] });

    await call({ date: "2026-01-02", organizationId: ORG_A });

    expect(eqValue(queriesOf(queries, "planned_meals")[0], "user_daily_meals.day_date")).toBe("2026-01-02");
    expect(savedStats(queries)[0]).toMatchObject({ organization_id: ORG_A, date: "2026-01-02" });
  });

  it("organizationId を指定すると、その組織だけを集計する", async () => {
    const { queries } = install({
      orgs: [ORG_A, ORG_B],
      members: { [ORG_A]: [uid(1)], [ORG_B]: [uid(2)] },
      meals: [],
    });

    const { json } = await call({ date: DATE, organizationId: ORG_B });

    expect(eqValue(queriesOf(queries, "organizations")[0], "id")).toBe(ORG_B);
    expect(json.processed.map((p: { orgId: string }) => p.orgId)).toEqual([ORG_B]);
  });
});

describe("aggregate-org-stats: 集計の計算 (#1306)", () => {
  it("アクティブ人数・朝食率・深夜食率 (JST 22:00〜04:00)・平均スコアを、user_daily_meals の所有者ごとに計算して保存する", async () => {
    const meals = [
      meal(1, "breakfast", { completedAt: "2026-10-07T23:30:00Z", vegScore: 4 }), // JST 08:30
      meal(1, "dinner", { completedAt: "2026-10-08T13:00:00Z", vegScore: 2 }), // JST 22:00:00 → 深夜 (22 時ちょうどから)
      meal(1, "lunch", { completed: false }), // 未完了: 完了数には入らず、スコアも無い
      meal(2, "breakfast", { completedAt: "2026-10-07T18:59:59Z", vegScore: 5 }), // JST 03:59:59 → 深夜 (4 時の直前まで)
      meal(2, "lunch", { completedAt: "2026-10-08T03:00:00Z", vegScore: 3 }), // JST 12:00
      meal(2, "snack", { completedAt: "2026-10-07T19:00:00Z" }), // JST 04:00:00 → 深夜ではない
      meal(2, "dinner", { completedAt: "2026-10-08T12:59:59Z", vegScore: 1 }), // JST 21:59:59 → 深夜ではない
      meal(3, "dinner", { completed: false, vegScore: 2 }), // 未完了でもスコアは平均に入る (従来どおり)
    ];
    const { queries } = install({ orgs: [ORG_A], members: { [ORG_A]: [uid(1), uid(2), uid(3)] }, meals });

    const { res, json } = await call({ date: DATE, organizationId: ORG_A });

    expect(res.status).toBe(200);
    // 完了 6 件 (u1: 2, u2: 4)。アクティブは u1, u2 の 2 人 (u3 は未完了のみ)
    // 朝食 2/6 → 33%、深夜 2/6 (u1 の 22:00 と u2 の 03:59:59) → 33%
    // スコア [4, 2, 5, 3, 1, 2] の平均 2.83 × 20 → 57
    expect(savedStats(queries)).toEqual([
      {
        organization_id: ORG_A,
        date: DATE,
        member_count: 3,
        active_member_count: 2,
        breakfast_rate: 33,
        late_night_rate: 33,
        avg_score: 57,
        updated_at: expect.any(String),
      },
    ]);
    expect(argsOf(queriesOf(queries, "org_daily_stats")[0], "upsert")[0][1]).toEqual({ onConflict: "organization_id, date" });
    expect(json).toEqual({
      success: true,
      processed: [{ orgId: ORG_A, memberCount: 3, totalCompletedMeals: 6 }],
      failed: [],
    });
  });

  it("対象日の食事が 1 件も無ければ、メンバー数だけ入れて他は 0", async () => {
    const { queries } = install({ orgs: [ORG_A], members: { [ORG_A]: [uid(1), uid(2)] }, meals: [] });

    await call({ date: DATE, organizationId: ORG_A });

    expect(savedStats(queries)[0]).toMatchObject({
      member_count: 2,
      active_member_count: 0,
      breakfast_rate: 0,
      late_night_rate: 0,
      avg_score: 0,
    });
  });

  it("メンバーが 0 人の組織は planned_meals を問い合わせず、0 埋めの行を保存する", async () => {
    const { queries } = install({ orgs: [ORG_A], members: { [ORG_A]: [] }, meals: [] });

    const { res, json } = await call({ date: DATE, organizationId: ORG_A });

    expect(res.status).toBe(200);
    expect(queriesOf(queries, "planned_meals")).toEqual([]);
    expect(savedStats(queries)).toEqual([
      expect.objectContaining({
        organization_id: ORG_A,
        date: DATE,
        member_count: 0,
        active_member_count: 0,
        breakfast_rate: 0,
        late_night_rate: 0,
        avg_score: 0,
      }),
    ]);
    expect(json.processed).toEqual([{ orgId: ORG_A, memberCount: 0, totalCompletedMeals: 0 }]);
  });

  it("別の組織のメンバーの食事は、その組織の集計に入らない", async () => {
    const meals = [
      meal(1, "breakfast", { completedAt: "2026-10-08T00:00:00Z", vegScore: 5 }),
      meal(2, "breakfast", { completedAt: "2026-10-08T00:00:00Z", vegScore: 1 }),
    ];
    const { queries } = install({
      orgs: [ORG_A, ORG_B],
      members: { [ORG_A]: [uid(1)], [ORG_B]: [uid(2)] },
      meals,
    });

    await call({ date: DATE });

    const stats = Object.fromEntries(savedStats(queries).map((s) => [s.organization_id as string, s]));
    expect(stats[ORG_A]).toMatchObject({ member_count: 1, active_member_count: 1, avg_score: 100 });
    expect(stats[ORG_B]).toMatchObject({ member_count: 1, active_member_count: 1, avg_score: 20 });
  });
});

describe("aggregate-org-stats: 大きな組織 (#1306)", () => {
  it("メンバーが多いときは、.in() の ids を 100 人ずつに分けて問い合わせ、結果を合わせる", async () => {
    const members = Array.from({ length: 250 }, (_, i) => uid(i + 1));
    const meals = [
      meal(1, "breakfast", { completedAt: "2026-10-08T00:00:00Z", vegScore: 4 }),
      meal(250, "dinner", { completedAt: "2026-10-08T10:00:00Z", vegScore: 2 }),
    ];
    const { queries } = install({ orgs: [ORG_A], members: { [ORG_A]: members }, meals });

    const { res, json } = await call({ date: DATE, organizationId: ORG_A });

    expect(res.status).toBe(200);
    const chunks = queriesOf(queries, "planned_meals").map(
      (q) => argsOf(q, "in").find((args) => args[0] === "user_daily_meals.user_id")![1] as string[],
    );
    expect(chunks.map((ids) => ids.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toEqual(members);
    // 1 人目 (1 つ目のチャンク) と 250 人目 (3 つ目のチャンク) の食事の両方が集計に入る
    expect(savedStats(queries)[0]).toMatchObject({ member_count: 250, active_member_count: 2, breakfast_rate: 50, avg_score: 60 });
    expect(json.processed).toEqual([{ orgId: ORG_A, memberCount: 250, totalCompletedMeals: 2 }]);
  });

  it("1 回の応答が API の上限 (1000 行) に達したら、ページ送りで取り直して全件を集計する", async () => {
    // 1 人で 2100 件 (3 件に 1 件が完了した朝食、残りは未完了の昼食)
    const meals = Array.from({ length: 2100 }, (_, i) =>
      i % 3 === 0 ? meal(1, "breakfast", { completedAt: "2026-10-08T00:00:00Z", vegScore: 5 }) : meal(1, "lunch", { completed: false }),
    );
    const { queries } = install({ orgs: [ORG_A], members: { [ORG_A]: [uid(1)] }, meals });

    const { res, json } = await call({ date: DATE, organizationId: ORG_A });

    expect(res.status).toBe(200);
    const planned = queriesOf(queries, "planned_meals");
    // 1 回目はそのまま (1000 行で打ち切られる) → order + range のページ送り 4 回 (1000, 1000, 100, 空)
    expect(planned).toHaveLength(5);
    expect(argsOf(planned[0], "range")).toEqual([]);
    expect(planned.slice(1).map((q) => argsOf(q, "range")[0])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2100, 3099],
    ]);
    expect(planned.slice(1).every((q) => argsOf(q, "order")[0]?.[0] === "id")).toBe(true);
    // 打ち切られた 1000 行だけでなく、2100 行すべてを数えている (完了した朝食は 700 件)
    expect(json.processed).toEqual([{ orgId: ORG_A, memberCount: 1, totalCompletedMeals: 700 }]);
    expect(savedStats(queries)[0]).toMatchObject({ active_member_count: 1, breakfast_rate: 100, avg_score: 100 });
  });
});

describe("aggregate-org-stats: 失敗を成功に見せない (#1306)", () => {
  const notFound = { message: "Could not find a relationship between 'planned_meals' and 'meal_plan_days' in the schema cache", code: "PGRST200" };

  const failsForUser = (userNo: number, table: string, error: QueryOutcome["error"]) => (query: RecordedQuery) => {
    if (query.table !== table) return undefined;
    const ids = argsOf(query, "in")[0]?.[1] as string[] | undefined;
    return ids?.includes(uid(userNo)) ? error : undefined;
  };

  it("planned_meals の取得に失敗した組織は、0 埋めの行を保存せず、ログに残して 500 で返す。ほかの組織は集計する", async () => {
    const meals = [meal(2, "breakfast", { completedAt: "2026-10-08T00:00:00Z", vegScore: 5 })];
    const { queries } = install({
      orgs: [ORG_A, ORG_B],
      members: { [ORG_A]: [uid(1)], [ORG_B]: [uid(2)] },
      meals,
      fail: failsForUser(1, "planned_meals", notFound),
    });

    const { res, json } = await call({ date: DATE });

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.processed).toEqual([{ orgId: ORG_B, memberCount: 1, totalCompletedMeals: 1 }]);
    expect(json.failed).toEqual([{ orgId: ORG_A, error: expect.stringContaining("PGRST200") }]);
    expect(json.failed[0].error).toContain("planned_meals");

    // 失敗した組織 A の行は書かない (取得に失敗したまま 0 の行を保存すると、本当の値に見える)
    expect(savedStats(queries).map((s) => s.organization_id)).toEqual([ORG_B]);

    // db-logger に 1 件、どの組織の何が失敗したか分かる形で残る
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].message).toBe(`Failed to aggregate stats for org ${ORG_A}`);
    expect(h.errors[0].metadata).toEqual({ organizationId: ORG_A, date: DATE });
    expect(h.errors[0].error).toBeInstanceOf(Error);
    expect((h.errors[0].error as Error).message).toContain("PGRST200");
  });

  it("メンバーの取得に失敗した組織も同じ: 行を書かず、planned_meals も問い合わせず、失敗として返す", async () => {
    const { queries } = install({
      orgs: [ORG_A, ORG_B],
      members: { [ORG_A]: [uid(1)], [ORG_B]: [uid(2)] },
      meals: [],
      fail: (q) => (q.table === "user_profiles" && eqValue(q, "organization_id") === ORG_A ? { message: "permission denied", code: "42501" } : undefined),
    });

    const { res, json } = await call({ date: DATE });

    expect(res.status).toBe(500);
    expect(json.failed).toEqual([{ orgId: ORG_A, error: expect.stringContaining("42501") }]);
    expect(json.processed.map((p: { orgId: string }) => p.orgId)).toEqual([ORG_B]);
    expect(savedStats(queries).map((s) => s.organization_id)).toEqual([ORG_B]);
    const askedIds = queriesOf(queries, "planned_meals").flatMap((q) => argsOf(q, "in")[0][1] as string[]);
    expect(askedIds).toEqual([uid(2)]);
    expect(h.errors).toHaveLength(1);
  });

  it("保存 (upsert) に失敗しても、成功として返さない", async () => {
    install({
      orgs: [ORG_A, ORG_B],
      members: { [ORG_A]: [uid(1)], [ORG_B]: [uid(2)] },
      meals: [],
      fail: (q) => {
        if (q.table !== "org_daily_stats") return undefined;
        const row = argsOf(q, "upsert")[0][0] as { organization_id: string };
        return row.organization_id === ORG_B ? { message: "violates foreign key constraint", code: "23503" } : undefined;
      },
    });

    const { res, json } = await call({ date: DATE });

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.processed.map((p: { orgId: string }) => p.orgId)).toEqual([ORG_A]);
    expect(json.failed).toEqual([{ orgId: ORG_B, error: expect.stringContaining("org_daily_stats の保存") }]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].message).toBe(`Failed to aggregate stats for org ${ORG_B}`);
  });

  it("組織の一覧の取得に失敗したら、何も集計せず 500 (error メッセージ付き)。ログにも残す", async () => {
    const { queries } = install({
      orgs: [ORG_A],
      members: { [ORG_A]: [uid(1)] },
      meals: [],
      fail: (q) => (q.table === "organizations" ? { message: "connection reset", code: "08006" } : undefined),
    });

    const { res, json } = await call({ date: DATE });

    expect(res.status).toBe(500);
    expect(json.error).toContain("organizations の取得");
    expect(json.error).toContain("08006");
    expect(queries.map((q) => q.table)).toEqual(["organizations"]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].message).toBe("Aggregation error");
  });
});

describe("aggregate-org-stats: 認証", () => {
  it("CRON_SECRET が違う・無い呼び出しは 401 で、DB には触れない", async () => {
    const { queries } = install({ orgs: [ORG_A], members: { [ORG_A]: [uid(1)] }, meals: [] });

    const wrong = await call({ date: DATE }, { authorization: "Bearer not-the-secret" });
    const missing = await call({ date: DATE }, {});

    expect(wrong.res.status).toBe(401);
    expect(missing.res.status).toBe(401);
    expect(queries).toEqual([]);
  });
});
