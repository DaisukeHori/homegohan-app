import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// #1227: analyze-fridge Edge Function は imageUrl の型も形式も確かめずに外部の Vision API へ渡していた。
// 文字列でない値 (数値など) が来ると、ログ出力用の imageUrl.slice(0, 80) で TypeError になって 500 を返し、
// 文字列ならどんなスキームでもそのまま上流に渡っていた。ここでは Edge Function の入口 (Deno.serve に渡された関数) に
// 実際の HTTP 要求を流して、入力が不正なら Vision API を呼ぶ前に 400 で返すことを確かめる。
//
// index.ts は Deno 専用の import (esm.sh など) を含み、そのままでは Vitest で読み込めない。
// 外との境目 (認証・ログ・LLM クライアント) だけをモックに差し替え、本体はそのまま動かす。

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  consumeEdgeAiQuota: vi.fn(),
  createCompletion: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../supabase/functions/_shared/auth.ts", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("../supabase/functions/_shared/db-logger.ts", () => ({
  createLogger: () => ({ withUser: () => mocks.logger }),
  generateRequestId: () => "req_test",
}));
// #1177: AI 利用回数の記録。DB を呼ぶ consumeEdgeAiQuota だけを差し替え、429 の応答を作る関数は本物を使う
// (consumeEdgeAiQuota 自体の挙動は tests/ai-quota-edge.test.ts)
vi.mock("../supabase/functions/_shared/quota.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supabase/functions/_shared/quota.ts")>()),
  consumeEdgeAiQuota: mocks.consumeEdgeAiQuota,
}));
vi.mock("../supabase/functions/_shared/fast-llm.ts", () => ({
  createFastLLMClient: () => ({ chat: { completions: { create: mocks.createCompletion } } }),
  getFastLLMModel: () => "test-model",
}));

type Handler = (req: Request) => Promise<Response>;
let handler: Handler;

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    serve: (fn: Handler) => {
      handler = fn;
    },
    env: { get: () => undefined },
  });
  await import("../supabase/functions/analyze-fridge/index.ts");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
  mocks.consumeEdgeAiQuota.mockReset();
  mocks.consumeEdgeAiQuota.mockResolvedValue({ allowed: true, remaining: null });
  mocks.createCompletion.mockReset();
  mocks.createCompletion.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ ingredients: ["卵", "牛乳"], expiringSoon: ["牛乳"] }) } }],
  });
  for (const fn of Object.values(mocks.logger)) fn.mockReset();
});

// 自社の Web アプリ (モバイルの WebView が開くのも同じオリジン)。CORS を許可するオリジンの 1 つ (#1167)
const WEB_ORIGIN = "https://homegohan-app.vercel.app";

function call(body: unknown, rawBody?: string, origin: string | null = WEB_ORIGIN): Promise<Response> {
  return handler(
    new Request("http://localhost/functions/v1/analyze-fridge", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
        ...(origin === null ? {} : { Origin: origin }),
      },
      body: rawBody ?? JSON.stringify(body),
    }),
  );
}

// ブラウザからエラーの内容を読めるよう、400 / 500 にも CORS ヘッダーと JSON の Content-Type を付ける。
// ただし CORS ヘッダーは許可したオリジンにだけ付ける (全オリジン許可の '*' は返さない)
function expectCorsJson(res: Response) {
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(WEB_ORIGIN);
  expect(res.headers.get("Content-Type")).toBe("application/json");
}

const SUPABASE_URL = "https://flmeolcfutuwwbjmzyoz.supabase.co/storage/v1/object/public/fridge-images/u1/fridge.jpg";

describe("analyze-fridge の入口 (#1227)", () => {
  it("AH-1: 認証に失敗したら、入力を見る前に 401 を返す", async () => {
    mocks.requireAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );
    const res = await call({ imageUrl: 12345 });
    expect(res.status).toBe(401);
    expect(mocks.createCompletion).not.toHaveBeenCalled();
  });

  it.each([
    ["数値", 12345],
    ["真偽値", true],
    ["配列", [SUPABASE_URL]],
    ["オブジェクト", { url: SUPABASE_URL }],
  ])("AH-2: imageUrl が文字列でない (%s) なら、Vision API を呼ばずに 400", async (_label, imageUrl) => {
    const res = await call({ imageUrl });
    expect(res.status).toBe(400);
    expectCorsJson(res);
    expect(await res.json()).toEqual({ error: "Image URL must be a string" });
    expect(mocks.createCompletion).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "Invalid analyze-fridge request",
      expect.objectContaining({ reason: "not_string" }),
    );
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ["imageUrl が無い", {}],
    ["null", { imageUrl: null }],
    ["空文字", { imageUrl: "" }],
    ["空白だけ", { imageUrl: "   " }],
  ])("AH-3: imageUrl が必須 (%s) なら 400 (従来どおりのメッセージ)", async (_label, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Image URL is required" });
    expect(mocks.createCompletion).not.toHaveBeenCalled();
  });

  it.each([
    ["http", "http://example.com/fridge.jpg"],
    ["data URI", "data:image/png;base64,iVBORw0KGgo="],
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["URL でない文字列", "not a url"],
    ["相対パス", "/storage/v1/object/public/fridge-images/u1/fridge.jpg"],
    ["IP 直指定", "https://169.254.169.254/latest/meta-data/"],
    ["認証情報つき", "https://user:pass@example.com/fridge.jpg"],
    ["長すぎる", `https://example.com/${"a".repeat(3000)}.jpg`],
  ])("AH-4: imageUrl が https の URL でない (%s) なら、Vision API を呼ばずに 400", async (_label, imageUrl) => {
    const res = await call({ imageUrl });
    expect(res.status).toBe(400);
    expect(mocks.createCompletion).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["JSON として読めない", '{"imageUrl":'],
    ["空の本文", ""],
    ["null", "null"],
    ["配列", "[]"],
    ["文字列", '"https://example.com/a.jpg"'],
  ])("AH-5: 本文が JSON オブジェクトでない (%s) なら 400 (500 にしない)", async (_label, rawBody) => {
    const res = await call(undefined, rawBody);
    expect(res.status).toBe(400);
    expectCorsJson(res);
    expect(mocks.createCompletion).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("AH-6: 正しい https の URL なら、その URL を Vision API に渡して結果を 200 で返す", async () => {
    const res = await call({ imageUrl: SUPABASE_URL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingredients: ["卵", "牛乳"], expiringSoon: ["牛乳"] });
    expect(mocks.createCompletion).toHaveBeenCalledTimes(1);
    const params = mocks.createCompletion.mock.calls[0][0];
    expect(params.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: SUPABASE_URL } });
  });

  it("AH-7: 上流の API が失敗したら 500。内部のエラー文はクライアントに返さず、ログには残す", async () => {
    mocks.createCompletion.mockRejectedValue(new Error("401 Incorrect API key provided: xai-SECRET-KEY"));
    const res = await call({ imageUrl: SUPABASE_URL });
    expect(res.status).toBe(500);
    expectCorsJson(res);
    const text = await res.text();
    expect(text).not.toContain("SECRET-KEY");
    expect(JSON.parse(text)).toEqual({ error: "Internal server error" });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it("AH-8: ログには URL そのもの (署名付き URL の token など) を残さない", async () => {
    // 不正な入力として弾く場合
    await call({ imageUrl: "http://img.example.com/a.jpg?token=SECRET-TOKEN" });
    // 受け付けて処理する場合 (従来は先頭 80 文字をそのまま記録していた)
    await call({ imageUrl: "https://img.example.com/a.jpg?token=SECRET-TOKEN" });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith("Analyzing fridge image", {
      imageHost: "img.example.com",
      imageUrlLength: expect.any(Number),
    });
    const logged = JSON.stringify([...mocks.logger.warn.mock.calls, ...mocks.logger.info.mock.calls]);
    expect(logged).not.toContain("SECRET-TOKEN");
  });
});

// #1167: 以前は全オリジン許可 ('*') を返していた。許可したオリジン (自社の Web アプリ) にだけ返す。
describe("analyze-fridge の CORS (#1167)", () => {
  const OTHER_SITE = "https://evil.example.com";

  it("AH-9: 許可したオリジンには、そのオリジンを返す。成功 (200) の応答にも付く", async () => {
    const res = await call({ imageUrl: SUPABASE_URL });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(WEB_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("AH-10: 許可していないオリジンには Access-Control-Allow-* を返さない。関数の結果そのものは変わらない", async () => {
    const res = await call({ imageUrl: SUPABASE_URL }, undefined, OTHER_SITE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingredients: ["卵", "牛乳"], expiringSoon: ["牛乳"] });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("AH-11: Origin が無い呼び出し (Next.js の API ルートなどサーバーから) でも、従来どおり動く。'*' は返さない", async () => {
    const res = await call({ imageUrl: SUPABASE_URL }, undefined, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingredients: ["卵", "牛乳"], expiringSoon: ["牛乳"] });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("AH-12: 入力不正の 400 でも、許可していないオリジンには CORS ヘッダーを付けない", async () => {
    const res = await call({ imageUrl: 12345 }, undefined, OTHER_SITE);
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("AH-13: ブラウザの事前確認 (OPTIONS) は、許可したオリジンにだけ CORS ヘッダーを返す", async () => {
    const preflight = (origin: string) =>
      handler(
        new Request("http://localhost/functions/v1/analyze-fridge", {
          method: "OPTIONS",
          headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
        }),
      );

    const allowed = await preflight(WEB_ORIGIN);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(WEB_ORIGIN);
    expect(allowed.headers.get("Access-Control-Allow-Headers")).toContain("authorization");

    const denied = await preflight(OTHER_SITE);
    expect(denied.status).toBe(200);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(denied.headers.get("Access-Control-Allow-Headers")).toBeNull();

    // 事前確認は認証を必要とせず、Vision API も呼ばない
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.createCompletion).not.toHaveBeenCalled();
  });

  it("AH-14: 認証失敗 (401) の応答も、ブラウザが中身を読めるよう許可したオリジンには CORS ヘッダーを付ける", async () => {
    mocks.requireAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const allowed = await call({ imageUrl: SUPABASE_URL });
    expect(allowed.status).toBe(401);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(WEB_ORIGIN);

    const denied = await call({ imageUrl: SUPABASE_URL }, undefined, OTHER_SITE);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// #1177: AI 利用回数の記録。ユーザーの JWT で直接呼ばれたときに数える (Next.js が数え済みの呼び出しは、印があれば数えない)
describe("analyze-fridge の AI 利用回数の記録 (#1177)", () => {
  it("AH-15: JWT の認証に成功したら、受け取った req とユーザー ID で数える。Vision API を呼ぶ前に数える", async () => {
    const res = await call({ imageUrl: SUPABASE_URL });

    expect(res.status).toBe(200);
    expect(mocks.consumeEdgeAiQuota).toHaveBeenCalledTimes(1);
    const [req, userId, feature] = mocks.consumeEdgeAiQuota.mock.calls[0];
    expect(req).toBeInstanceOf(Request);
    expect(userId).toBe("user-1");
    expect(feature).toBe("photo_analysis");
    expect(mocks.consumeEdgeAiQuota.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createCompletion.mock.invocationCallOrder[0],
    );
  });

  it("AH-16: 認証に失敗したら数えない", async () => {
    mocks.requireAuth.mockResolvedValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));

    const res = await call({ imageUrl: SUPABASE_URL });

    expect(res.status).toBe(401);
    expect(mocks.consumeEdgeAiQuota).not.toHaveBeenCalled();
  });

  it("AH-17: 上限を超えていたら (いまは通らない)、Vision API を呼ばずに 429。許可したオリジンには CORS ヘッダーも付く", async () => {
    mocks.consumeEdgeAiQuota.mockResolvedValue({
      allowed: false,
      remaining: 0,
      limitKind: "daily",
      limit: 5,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await call({ imageUrl: SUPABASE_URL });

    expect(res.status).toBe(429);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(WEB_ORIGIN);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ code: "AI_DAILY_LIMIT", limit: 5 });
    expect(mocks.createCompletion).not.toHaveBeenCalled();
  });
});
