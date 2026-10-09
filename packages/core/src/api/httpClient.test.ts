import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TIMEOUT_MS,
  HttpNetworkError,
  HttpParseError,
  createHttpClient,
  isHttpNetworkError,
  isHttpParseError,
  type HttpClient,
} from "./httpClient";

/**
 * #1168 共通 HTTP クライアントのタイムアウト・リトライ・通信エラーのテスト
 *
 * fetch は差し替え、時間は vi.useFakeTimers() で進める (待ち時間を実際に待たない)。
 */

const BASE_URL = "https://api.example.com";

type FetchMock = ReturnType<typeof vi.fn>;

/** JSON の応答を作る。status が 204 などで本文なしのときは null を渡す */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    statusText: statusTextOf(status),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, statusText: statusTextOf(status), headers });
}

function statusTextOf(status: number): string {
  const names: Record<number, string> = {
    200: "OK",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    408: "Request Timeout",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
    505: "HTTP Version Not Supported",
  };
  return names[status] ?? "";
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** signal が abort されるまで応答しない fetch (本物の fetch と同じく、abort されたら AbortError で失敗する) */
function neverRespondingFetch(): FetchMock {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()));
    });
  });
}

/** 結果を { ok: true, value } / { ok: false, error } にして返す。reject が先に起きても未処理にならないようにする */
function settle<T>(promise: Promise<T>) {
  const state: { done: boolean; ok?: boolean; value?: T; error?: unknown } = { done: false };
  const settled = promise.then(
    (value) => {
      state.done = true;
      state.ok = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.ok = false;
      state.error = error;
    },
  );
  return { state, settled };
}

let fetchMock: FetchMock;

function installFetch(mock: FetchMock) {
  fetchMock = mock;
  vi.stubGlobal("fetch", mock);
}

function client(config: Partial<Parameters<typeof createHttpClient>[0]> = {}): HttpClient {
  return createHttpClient({ baseUrl: BASE_URL, ...config });
}

beforeEach(() => {
  vi.useFakeTimers();
  // 待ち時間の乱数を固定する (個別のテストで変える)
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createHttpClient — 基本の動作 (従来どおり)", () => {
  it("GET は JSON を返し、Authorization と Content-Type を付ける", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(200, { items: [1, 2] })));
    const api = client({ getAccessToken: async () => "token-123" });

    await expect(api.get("/api/pantry")).resolves.toEqual({ items: [1, 2] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/pantry");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("POST は body を JSON にして送り、本文が空の応答は null を返す", async () => {
    installFetch(vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(client().post("/api/x", { a: 1 })).resolves.toBeNull();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
  });

  it("HTTP エラーは `HTTP <status> <statusText>: <本文>` の Error (エラー本文は JSON のまま)", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(403, { error: { code: "FORBIDDEN", message: "権限がありません" } })));

    const { state, settled } = settle(client().get("/api/x"));
    await settled;

    expect(state.ok).toBe(false);
    expect(state.error).toBeInstanceOf(Error);
    expect(isHttpNetworkError(state.error)).toBe(false);
    expect((state.error as Error).message).toBe(
      'HTTP 403 Forbidden: {"error":{"code":"FORBIDDEN","message":"権限がありません"}}',
    );
    // 403 はやり直さない
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("JSON ではない本文のエラー応答 (ゲートウェイの HTML など) も、ステータス付きの Error になる", async () => {
    installFetch(vi.fn().mockResolvedValue(textResponse(404, "<!DOCTYPE html><html><body>404</body></html>")));

    const { state, settled } = settle(client().get("/api/x"));
    await settled;

    expect((state.error as Error).message).toBe("HTTP 404 Not Found: <!DOCTYPE html><html><body>404</body></html>");
  });

  it("JSON ではない長い本文は、200 文字で切る (画面にゲートウェイの HTML 全体を出さない)", async () => {
    installFetch(vi.fn().mockResolvedValue(textResponse(404, `<html>${"a".repeat(1000)}</html>`)));

    const { state, settled } = settle(client().get("/api/x"));
    await settled;

    const message = (state.error as Error).message;
    expect(message.startsWith("HTTP 404 Not Found: <html>aaa")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    expect(message.length).toBeLessThan(260);
  });

  it("成功 (2xx) の本文が JSON として読めないときは、SyntaxError ではなく HttpParseError を投げる (#1049)", async () => {
    installFetch(vi.fn().mockResolvedValue(textResponse(200, "<html>not json</html>")));

    const { state, settled } = settle(client().get("/api/x"));
    await settled;

    expect(state.ok).toBe(false);
    expect(state.error).toBeInstanceOf(HttpParseError);
    expect(isHttpParseError(state.error)).toBe(true);
    // 通信できなかった (HttpNetworkError) わけではない
    expect(isHttpNetworkError(state.error)).toBe(false);
    expect(state.error).not.toBeInstanceOf(SyntaxError);
    const error = state.error as HttpParseError;
    expect(error.name).toBe("HttpParseError");
    expect(error.status).toBe(200);
    expect(error.message).toBe("Response body is not JSON (HTTP 200)");
    // 元の JSON.parse のエラーは cause に持つ
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
  });

  it("HttpParseError は、同じ応答が返るだけなのでやり直さない (GET でも fetch は 1 回)", async () => {
    installFetch(vi.fn().mockResolvedValue(textResponse(200, "<html>Wi-Fi ログイン</html>")));

    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect(isHttpParseError(state.error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("書き込み (POST) の成功応答が JSON でなくても HttpParseError になる (fetch は 1 回)", async () => {
    installFetch(vi.fn().mockResolvedValue(textResponse(201, "created")));

    const { state, settled } = settle(client().post("/api/x", { a: 1 }));
    await settled;

    expect(isHttpParseError(state.error)).toBe(true);
    expect((state.error as HttpParseError).status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidResponseMessage で、HttpParseError の文面を画面に出せる文にできる", async () => {
    installFetch(vi.fn().mockResolvedValue(textResponse(200, "<html></html>")));

    const { state, settled } = settle(client({ invalidResponseMessage: "応答を読み取れませんでした。" }).get("/api/x"));
    await settled;

    expect(isHttpParseError(state.error)).toBe(true);
    expect((state.error as Error).message).toBe("応答を読み取れませんでした。");
  });

  it("JSON として読める本文は、null や 0 のような値でもそのまま返す (空の本文だけが null)", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(textResponse(200, "null"))
        .mockResolvedValueOnce(textResponse(200, "0"))
        .mockResolvedValueOnce(textResponse(200, "false"))
        .mockResolvedValueOnce(textResponse(200, "")),
    );
    const api = client();

    await expect(api.get("/api/a")).resolves.toBeNull();
    await expect(api.get("/api/b")).resolves.toBe(0);
    await expect(api.get("/api/c")).resolves.toBe(false);
    await expect(api.get("/api/d")).resolves.toBeNull();
  });

  it("isHttpParseError は、HttpParseError だけを見分ける", () => {
    expect(isHttpParseError(new HttpParseError("x", { status: 200 }))).toBe(true);
    expect(isHttpParseError(new Error("HTTP 200 OK: x"))).toBe(false);
    expect(isHttpParseError(new SyntaxError("Unexpected token"))).toBe(false);
    expect(isHttpParseError(new HttpNetworkError("offline", "x"))).toBe(false);
    expect(isHttpParseError(null)).toBe(false);
    expect(isHttpParseError(undefined)).toBe(false);
  });

  it("headers を持たない応答 (簡易なモック) でも動く", async () => {
    installFetch(
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "" }),
    );

    // 503 は GET なのでやり直す。待ち時間 (乱数 0 なので 250ms → 500ms) を進めて、最後はエラーになる
    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect((state.error as Error).message).toBe("HTTP 503 Service Unavailable: ");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("タイムアウト", () => {
  it("既定は 20 秒 (DEFAULT_TIMEOUT_MS)", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
  });

  it("20 秒を過ぎると、fetch を中断して kind が timeout の HttpNetworkError を投げる", async () => {
    installFetch(neverRespondingFetch());

    const { state, settled } = settle(client().get("/api/x"));

    await vi.advanceTimersByTimeAsync(19_999);
    expect(state.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect(state.ok).toBe(false);
    const error = state.error as HttpNetworkError;
    expect(error).toBeInstanceOf(HttpNetworkError);
    expect(isHttpNetworkError(error)).toBe(true);
    expect(error.kind).toBe("timeout");
    expect(error.timeoutMs).toBe(20_000);
    expect(error.message).toBe("Request timed out after 20000ms");
    expect((error as { cause?: unknown }).cause).toMatchObject({ name: "AbortError" });
    // fetch に渡した signal は中断されている
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it("タイムアウトはやり直さない (GET でも fetch は 1 回。待ち時間が 3 倍にならない)", async () => {
    installFetch(neverRespondingFetch());

    const { settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("timeoutMs は、クライアントの設定で変えられる", async () => {
    installFetch(neverRespondingFetch());

    const { state, settled } = settle(client({ timeoutMs: 5_000 }).post("/api/x", {}));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect((state.error as HttpNetworkError).kind).toBe("timeout");
    expect((state.error as HttpNetworkError).timeoutMs).toBe(5_000);
  });

  it("timeoutMs は、呼び出しごとに上書きできる (クライアントの設定より優先)", async () => {
    installFetch(neverRespondingFetch());

    const { state, settled } = settle(client({ timeoutMs: 5_000 }).post("/api/x", {}, { timeoutMs: 90_000 }));
    await vi.advanceTimersByTimeAsync(89_999);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect((state.error as HttpNetworkError).timeoutMs).toBe(90_000);
  });

  it("timeoutMs が 0 以下なら、待ち時間の上限を付けない", async () => {
    const hanging = new Promise<Response>(() => {});
    installFetch(vi.fn().mockReturnValue(hanging));

    const { state } = settle(client().get("/api/x", { timeoutMs: 0 }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(state.done).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("応答の本文を読んでいる途中で時間切れになっても timeout になる", async () => {
    installFetch(
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(abortError()));
            }),
        }),
      ),
    );

    const { state, settled } = settle(client({ timeoutMs: 1_000 }).get("/api/x"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect((state.error as HttpNetworkError).kind).toBe("timeout");
  });

  it("応答が間に合えばタイマーは残らない (成功・失敗のどちらでも)", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })));
    await client().get("/api/x");
    expect(vi.getTimerCount()).toBe(0);

    installFetch(vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad" })));
    await settle(client().get("/api/x")).settled;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("通信できないとき (offline)", () => {
  it("fetch が応答を受け取れずに失敗したら、kind が offline の HttpNetworkError (元のエラーは cause)", async () => {
    const original = new TypeError("Network request failed");
    installFetch(vi.fn().mockRejectedValue(original));

    // POST はやり直さないので、1 回で失敗する
    const { state, settled } = settle(client().post("/api/x", {}));
    await settled;

    const error = state.error as HttpNetworkError;
    expect(error).toBeInstanceOf(HttpNetworkError);
    expect(error.kind).toBe("offline");
    expect(error.name).toBe("HttpNetworkError");
    expect(error.message).toBe("Network request failed");
    expect((error as { cause?: unknown }).cause).toBe(original);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("エラーの文面は networkErrorMessages で差し替えられる (画面にそのまま出せる文面を渡す)", async () => {
    installFetch(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const api = client({
      networkErrorMessages: { offline: "通信できません (offline)", timeout: "通信できません (timeout)" },
    });

    const offline = settle(api.post("/api/x", {}));
    await offline.settled;
    expect((offline.state.error as Error).message).toBe("通信できません (offline)");

    installFetch(neverRespondingFetch());
    const timeout = settle(api.post("/api/x", {}));
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await timeout.settled;
    expect((timeout.state.error as Error).message).toBe("通信できません (timeout)");
  });

  it("呼び出し側の signal で中断したときは、timeout や offline にせず AbortError のまま投げる", async () => {
    installFetch(neverRespondingFetch());
    const controller = new AbortController();

    const { state, settled } = settle(client().get("/api/x", { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await settled;

    expect(isHttpNetworkError(state.error)).toBe(false);
    expect((state.error as Error).name).toBe("AbortError");
    // 中断はやり直さない
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("すでに中断済みの signal なら、fetch を呼ばずに AbortError を投げる", async () => {
    installFetch(vi.fn());
    const controller = new AbortController();
    controller.abort();

    const { state, settled } = settle(client().get("/api/x", { signal: controller.signal }));
    await settled;

    expect((state.error as Error).name).toBe("AbortError");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("リトライ — GET / HEAD / PUT / DELETE だけ、一時的な失敗のときだけ", () => {
  it("GET: 503 のあと成功したら、成功の結果を返す (fetch は 2 回)", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { error: "unavailable" }))
        .mockResolvedValueOnce(jsonResponse(200, { items: ["ok"] })),
    );

    const { state, settled } = settle(client().get("/api/pantry"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(state.ok).toBe(true);
    expect(state.value).toEqual({ items: ["ok"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("GET: 通信できなかった (応答を受け取れなかった) あと成功したら、成功の結果を返す", async () => {
    installFetch(
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Network request failed"))
        .mockResolvedValueOnce(jsonResponse(200, { items: [] })),
    );

    const { state, settled } = settle(client().get("/api/pantry"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(state.value).toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["PUT", "DELETE"] as const)("%s も、5xx のあと成功したら成功の結果を返す", async (method) => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(502, { error: "bad gateway" }))
        .mockResolvedValueOnce(jsonResponse(200, { done: true })),
    );
    const api = client();

    const { state, settled } = settle(method === "PUT" ? api.put("/api/x", { a: 1 }) : api.del("/api/x"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(state.value).toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method).toBe(method);
  });

  it("やり直しでも、同じ body・Authorization で送る", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, {}))
        .mockResolvedValueOnce(jsonResponse(200, {})),
    );

    const { settled } = settle(client({ getAccessToken: () => "tok" }).put("/api/x", { name: "a" }));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    for (const call of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(call[1].body).toBe('{"name":"a"}');
      expect((call[1].headers as Headers).get("Authorization")).toBe("Bearer tok");
    }
  });

  it.each([408, 429, 500, 502, 503, 504])("HTTP %i はやり直す", async (status) => {
    installFetch(vi.fn().mockResolvedValueOnce(jsonResponse(status, {})).mockResolvedValueOnce(jsonResponse(200, { ok: 1 })));

    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(state.value).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])("HTTP %i はやり直さない (何度やっても同じ結果になるため)", async (status) => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(status, { error: "x" })));

    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect(state.ok).toBe(false);
    expect((state.error as Error).message).toContain(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([501, 505])("HTTP %i (未実装・未対応) は 5xx でもやり直さない", async (status) => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(status, { error: "not implemented" })));

    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect(state.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("JSON ではない本文の 503 (ゲートウェイの HTML など) もやり直す", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(textResponse(503, "<html>Service Unavailable</html>"))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true })),
    );

    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(state.value).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("POST はやり直さない: 503 でも fetch は 1 回 (AI の生成が二重に走らないように)", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(503, { error: "unavailable" })));

    const { state, settled } = settle(client().post("/api/ai/menu/v4/generate", { targetSlots: [] }));
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(state.ok).toBe(false);
    expect((state.error as Error).message).toContain("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POST はやり直さない: 通信できなかったときも fetch は 1 回", async () => {
    installFetch(vi.fn().mockRejectedValue(new TypeError("Network request failed")));

    const { state, settled } = settle(client().post("/api/x", {}));
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect((state.error as HttpNetworkError).kind).toBe("offline");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("PATCH もやり直さない (同じ変更を二重に適用してはいけない場合があるため)", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(500, { error: "x" })));

    const { settled } = settle(client().patch("/api/x", { a: 1 }));
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POST でも、呼び出しごとに retry: true で明示すれば、やり直す", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, {}))
        .mockResolvedValueOnce(jsonResponse(200, { created: true })),
    );

    const { state, settled } = settle(client().post("/api/x", { a: 1 }, { retry: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(state.value).toEqual({ created: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retry: false なら、GET でもやり直さない", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(503, {})));

    const { state, settled } = settle(client().get("/api/x", { retry: false }));
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect(state.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("クライアントの retry: false で、既定のやり直しを止められる (呼び出しごとの retry: true は効く)", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(503, {})));
    const api = client({ retry: false });

    const stopped = settle(api.get("/api/x"));
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped.settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const forced = settle(api.get("/api/x", { retry: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    await forced.settled;
    expect(fetchMock).toHaveBeenCalledTimes(1 + 3);
  });

  it("最大 2 回までやり直す: 503 が続くなら fetch は 3 回で、最後の応答のエラーを投げる", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { error: "first" }))
        .mockResolvedValueOnce(jsonResponse(503, { error: "second" }))
        .mockResolvedValueOnce(jsonResponse(503, { error: "third" }))
        .mockResolvedValue(jsonResponse(200, { ok: true })),
    );

    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(state.ok).toBe(false);
    expect((state.error as Error).message).toBe('HTTP 503 Service Unavailable: {"error":"third"}');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("通信できない状態が続くなら fetch は 3 回で、offline の HttpNetworkError を投げる", async () => {
    installFetch(vi.fn().mockRejectedValue(new TypeError("Network request failed")));

    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect((state.error as HttpNetworkError).kind).toBe("offline");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("やり直しの回数は、クライアントの設定でも呼び出しごとでも変えられる", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(500, {})));

    const one = settle(client({ retry: { retries: 1 } }).get("/api/x"));
    await vi.advanceTimersByTimeAsync(60_000);
    await one.settled;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    const five = settle(client().get("/api/x", { retry: { retries: 5 } }));
    await vi.advanceTimersByTimeAsync(60_000);
    await five.settled;
    expect(fetchMock).toHaveBeenCalledTimes(6);

    fetchMock.mockClear();
    const zero = settle(client().get("/api/x", { retry: { retries: 0 } }));
    await vi.advanceTimersByTimeAsync(60_000);
    await zero.settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("やり直しの前に待つ: 指数的に増え (500ms → 1000ms が上限)、半分は乱数で散らす", async () => {
    // 乱数 0: 上限の半分 (250ms, 500ms)
    installFetch(vi.fn().mockResolvedValue(jsonResponse(503, {})));
    const low = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await low.settled;

    // 乱数が 1 に近い: 上限いっぱい (500ms, 1000ms)
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    installFetch(vi.fn().mockResolvedValue(jsonResponse(503, {})));
    const high = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(998);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await high.settled;
  });

  it("待ち時間の基準・上限は retry で変えられる (maxDelayMs で頭打ち)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    installFetch(vi.fn().mockResolvedValue(jsonResponse(503, {})));

    // 基準 1000ms → 1 回目の上限 1000ms、2 回目は 2000ms だが maxDelayMs の 1500ms で頭打ち
    const { settled } = settle(client({ retry: { baseDelayMs: 1_000, maxDelayMs: 1_500 } }).get("/api/x"));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_498);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await settled;
  });
});

describe("リトライ — Retry-After を守る", () => {
  it("Retry-After (秒) の間は待ってからやり直す", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, { error: "slow down" }, { "Retry-After": "3" }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true })),
    );

    const { state, settled } = settle(client().get("/api/x"));
    // 待ち時間の基準 (250ms) より Retry-After の 3 秒が長いので、3 秒待つ
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.value).toEqual({ ok: true });
  });

  it("Retry-After が待ち時間の基準より短いときは、基準の待ち時間を守る", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, {}, { "Retry-After": "0" }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true })),
    );

    const { settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Retry-After が HTTP の日時でも守る", async () => {
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(503, {}, { "Retry-After": new Date("2026-10-08T00:00:04Z").toUTCString() }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { ok: true })),
    );

    const { settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Retry-After が長すぎる (10 秒より長い) ときは、待たずにそのままエラーにする", async () => {
    installFetch(
      vi.fn().mockResolvedValue(jsonResponse(429, { error: "リクエストが多すぎます" }, { "Retry-After": "60" })),
    );

    const { state, settled } = settle(client().get("/api/x"));
    // 時間を進めなくても、すぐにエラーになる
    await settled;

    expect(state.ok).toBe(false);
    expect((state.error as Error).message).toContain("HTTP 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("上限は maxRetryAfterMs で変えられる", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "30" }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true })),
    );

    const { state, settled } = settle(client({ retry: { maxRetryAfterMs: 30_000 } }).get("/api/x"));
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;

    expect(state.value).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("読めない Retry-After は無視して、通常の待ち時間でやり直す", async () => {
    installFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, {}, { "Retry-After": "soon" }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true })),
    );

    const { state, settled } = settle(client().get("/api/x"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(state.value).toEqual({ ok: true });
  });

  it("やり直しを待っている間に呼び出し側が中断したら、やり直さずに AbortError を投げる", async () => {
    installFetch(vi.fn().mockResolvedValue(jsonResponse(503, {}, { "Retry-After": "5" })));
    const controller = new AbortController();

    const { state, settled } = settle(client().get("/api/x", { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await settled;

    expect((state.error as Error).name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
