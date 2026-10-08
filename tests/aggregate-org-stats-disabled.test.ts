// @vitest-environment node
//
// #1325: aggregate-org-stats (組織統計の集計) は、オーナー判断で停止している。
//
// 以前は、組織ごとの日次統計を集計して保存する関数だった。ただし読み取り先が、すでに削除された表を指していたため、
// 本番では何も保存できていなかった (#1379 は、直すと止めると決めた集計が動き出すので、あえて直さなかった)。
// いまの関数は、認証 (requireServiceRole) だけを停止前と同じように行い、通ったら何もせず 410 (DISABLED) を返す。
// 認証を通らない呼び出しは、停止前と同じ 401 (CORS ヘッダーなし。バッチ専用の関数なので)。
// 古い呼び出し元 (本番に残った pg_cron のジョブなど) があれば気付けるよう、認証に通った呼び出しは warn で記録する。
//
// 以前にあった「対象日を省略したら JST の今日にする」(#1210) のテストは、集計処理ごと無くなったので、このテストに置き換えた。
//
// Edge Function 本体は Deno.serve を import 時に呼ぶ。Deno とロガーを差し替えて本物のハンドラを取り出し、実際に呼んで確かめる。
// supabase-js の createClient は罠にしてある。関数が DB に接続しようとしたら (集計が復活したら) 検出する。

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const CRON_SECRET = "test-cron-secret";
const SERVICE_ROLE_KEY = "test-service-role-key";
const ORG_ID = "11111111-1111-4111-8111-111111111111";

const FUNCTION_SOURCE = path.resolve(__dirname, "../supabase/functions/aggregate-org-stats/index.ts");

const h = vi.hoisted(() => ({
  serve: null as null | ((req: Request) => Promise<Response>),
  env: {} as Record<string, string | undefined>,
  createClientCalls: [] as unknown[][],
  warns: [] as string[],
  errors: [] as string[],
}));

// supabase-js: DB に接続しようとしたことを記録する罠 (_shared/auth.ts の requireAuth は使わないので呼ばれない)
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    h.createClientCalls.push(args);
    return {};
  },
}));

// ロガーは app_logs へ書き込むので差し替える (https://esm.sh の import も避けられる)
vi.mock("../supabase/functions/_shared/db-logger.ts", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      h.warns.push(message);
    },
    error: (message: string) => {
      h.errors.push(message);
    },
  }),
  generateRequestId: () => "req_test",
}));

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: (key: string) => h.env[key] },
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
  h.env = { CRON_SECRET, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };
  h.warns.length = 0;
  h.errors.length = 0;
});

async function call(init: { method?: string; auth?: string; origin?: string; body?: unknown } = {}): Promise<Response> {
  if (!h.serve) throw new Error("Deno.serve のハンドラを取得できていません");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.auth !== undefined) headers.authorization = init.auth;
  if (init.origin !== undefined) headers.origin = init.origin;
  const method = init.method ?? "POST";
  return h.serve(
    new Request("http://localhost/functions/v1/aggregate-org-stats", {
      method,
      headers,
      body: method === "GET" || method === "OPTIONS" ? undefined : JSON.stringify(init.body ?? {}),
    }),
  );
}

function corsHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((key) => key.toLowerCase().startsWith("access-control-"));
}

const DISABLED_BODY = {
  success: false,
  code: "DISABLED",
  message: "組織の集計はオーナー判断 (#1325) により停止しています",
};

describe("aggregate-org-stats: 認証に通った呼び出しには、何もせず 410 (DISABLED) を返す (#1325)", () => {
  it("AG-1: CRON_SECRET で認証した呼び出しは 410。本文は固定で、JSON を返す", async () => {
    const res = await call({ auth: `Bearer ${CRON_SECRET}`, body: { organizationId: ORG_ID } });

    expect(res.status).toBe(410);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual(DISABLED_BODY);
  });

  it("AG-2: service role key で認証した呼び出し (以前、画面の更新ボタンから使われていた方法) も、410 を返す", async () => {
    const res = await call({ auth: `Bearer ${SERVICE_ROLE_KEY}`, body: { organizationId: ORG_ID } });

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(DISABLED_BODY);
  });

  it("AG-3: 組織 ID・日付・HTTP メソッドが何であっても結果は同じ (集計の対象を選ぶ入力は使わない)", async () => {
    const bodies = [{}, { organizationId: ORG_ID }, { date: "2026-01-02" }, { organizationId: ORG_ID, date: "2026-01-02" }];
    for (const body of bodies) {
      const res = await call({ auth: `Bearer ${CRON_SECRET}`, body });
      expect(res.status, JSON.stringify(body)).toBe(410);
      expect(await res.json()).toEqual(DISABLED_BODY);
    }

    const get = await call({ method: "GET", auth: `Bearer ${CRON_SECRET}` });
    expect(get.status).toBe(410);
    expect(await get.json()).toEqual(DISABLED_BODY);
  });

  it("AG-4: バッチ専用なので、許可したオリジンからの呼び出しでも CORS ヘッダーを返さない", async () => {
    const res = await call({ auth: `Bearer ${CRON_SECRET}`, origin: "https://homegohan-app.vercel.app" });

    expect(res.status).toBe(410);
    expect(corsHeaders(res)).toEqual([]);
  });

  it("AG-5: DB に接続しない。集計も保存もしない (supabase-js のクライアントを作らない)", async () => {
    await call({ auth: `Bearer ${CRON_SECRET}`, body: { organizationId: ORG_ID, date: "2026-01-02" } });
    await call({ auth: `Bearer ${SERVICE_ROLE_KEY}` });

    expect(h.createClientCalls).toEqual([]);
  });

  it("AG-6: 認証に通った呼び出しは、停止中であることを warn で記録する (呼び出し元が残っていないか確かめる手がかり)", async () => {
    await call({ auth: `Bearer ${CRON_SECRET}` });

    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain("停止中");
    expect(h.warns[0]).toContain("#1325");
    expect(h.errors).toEqual([]);
  });
});

describe("aggregate-org-stats: 認証は停止前と同じ (バッチ専用。CORS なし)", () => {
  it("AG-7: 認証なしの呼び出しは 401。CORS ヘッダーは無く、記録もしない", async () => {
    for (const origin of ["https://homegohan-app.vercel.app", "https://evil.example.com", undefined]) {
      const res = await call({ origin });

      expect(res.status).toBe(401);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      expect(corsHeaders(res)).toEqual([]);
    }
    expect(h.warns).toEqual([]);
  });

  it("AG-8: 違うシークレット・Bearer 以外・ブラウザの事前確認 (OPTIONS) も 401 で、410 にはならない", async () => {
    for (const auth of ["Bearer wrong-secret", CRON_SECRET, `Basic ${CRON_SECRET}`, "Bearer "]) {
      const res = await call({ auth });
      expect(res.status, `Authorization: ${auth}`).toBe(401);
    }

    const preflight = await call({ method: "OPTIONS", origin: "https://homegohan-app.vercel.app" });
    expect(preflight.status).toBe(401);
    expect(corsHeaders(preflight)).toEqual([]);
    expect(h.warns).toEqual([]);
  });

  it("AG-9: 認証用のシークレットが何も設定されていなければ 503 (設定漏れを成功にしない。410 にもしない)", async () => {
    h.env = {};

    const res = await call({ auth: "Bearer anything" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Service not configured" });
    expect(h.warns).toEqual([]);
  });
});

describe("aggregate-org-stats: 集計処理が残っていない (#1325)", () => {
  const source = fs.readFileSync(FUNCTION_SOURCE, "utf8");

  it.each([
    // すでに削除された表。読むと本番では PGRST200 になっていた
    "meal_plan_days",
    "meal_plans",
    // 集計結果の保存先。この関数は書き込まない
    "org_daily_stats",
    "planned_meals",
    "upsert",
    "supabaseAdmin",
    // 対象日 (JST の今日) を求める処理 (#1210) も集計と一緒に無くなった
    "todayJst",
  ])("AG-10: ソースに「%s」が無い", (banned) => {
    expect(source).not.toContain(banned);
  });

  it("AG-11: 関数のディレクトリは残っている (デプロイは関数を削除しないので、410 を返し続ける)", () => {
    expect(fs.existsSync(FUNCTION_SOURCE)).toBe(true);
    expect(source).toContain("requireServiceRole(req)");
    expect(source).toContain("status: 410");
  });
});
