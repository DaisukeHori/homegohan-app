import { createHttpClient, type HttpClient, type HttpRequestOptions } from "@homegohan/core";

import { NETWORK_ERROR_MESSAGES } from "./api-error";
import { MobileConfigError, resolveApiBaseUrl } from "./env";
import { supabase } from "./supabase";

let _api: HttpClient | null = null;

/**
 * Next.js の API (BFF) の基点。未設定・空・空白だけなら、変数名を書いた MobileConfigError
 * (`[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL`) を投げる。
 * 無いビルドは、app/_layout.tsx のゲートが設定エラーの画面を出すので、ふつうはここまで来ない (#1434)。
 */
export function getApiBaseUrl(): string {
  const value = resolveApiBaseUrl();
  if (value === undefined) throw new MobileConfigError(["EXPO_PUBLIC_API_BASE_URL"]);
  return value;
}

/**
 * 時間のかかる API を待つ上限 (ミリ秒)。共通クライアントの既定 (20 秒) より長い。
 * サーバー側の最長は、画像の解析が約 25 秒、血液検査の保存 (AI レビューを 2 回作る) が約 50 秒、
 * 献立の変更 (POST /api/ai/nutrition-analysis) が数分。先に切ると、サーバーでは成功した (保存された)
 * のに画面は失敗と表示し、利用者がもう一度送って二重に保存・生成される恐れがある。
 */
export const SLOW_API_TIMEOUT_MS = 120_000;

/** サーバーが AI の応答を待つ API。メソッドを問わず (GET でも AI に問い合わせる API がある) 遅い */
const SLOW_API_PATH_PREFIXES = ["/api/ai/"];

/**
 * 保存や集計のあとに、AI や Edge Function の結果を待ってから返す POST (/api/ai/ の外にあるもの)。
 * 新しく /api/ai/ 以外に、サーバーが AI を待ってから返す POST を足したら、ここにも足すこと。
 */
const SLOW_API_POST_PATHS = new Set([
  "/api/health/blood-tests", // 保存のあと、個別レビューと経年レビューを AI で作る
  "/api/health/checkups", // 同上 (健康診断)
  "/api/health/insights", // AI でインサイトを作る
  "/api/comparison/trigger", // 集計の Edge Function を待つ
]);

function isSlowApi(method: string, path: string): boolean {
  // createHttpClient は先頭の / が無いパスも受け付けるので、ここでも同じ扱いにする。クエリと末尾の / は見ない
  const pathname = (path.startsWith("/") ? path : `/${path}`).split("?")[0].replace(/\/+$/, "");
  if (SLOW_API_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return method === "POST" && SLOW_API_POST_PATHS.has(pathname);
}

/**
 * 時間のかかる API には、待ち時間を長くし、自動のやり直しをしない指定を足す (#1168)。
 * やり直しを止めるのは、AI への問い合わせや保存が二重に走らないようにするため
 * (GET でも、栄養分析のアドバイスのように、毎回 AI に問い合わせる API がある)。
 * 呼び出し側が timeoutMs / retry を指定していれば、それを優先する。それ以外の API には何も足さない。
 */
function withRequestPolicy(method: string, path: string, init?: HttpRequestOptions): HttpRequestOptions | undefined {
  if (!isSlowApi(method, path)) return init;
  return { ...init, timeoutMs: init?.timeoutMs ?? SLOW_API_TIMEOUT_MS, retry: init?.retry ?? false };
}

function createApi(): HttpClient {
  const client = createHttpClient({
    baseUrl: getApiBaseUrl(),
    // 圏外や待ち時間切れのとき、各画面が e.message をそのまま出しても「通信できません」と案内できるようにする
    networkErrorMessages: NETWORK_ERROR_MESSAGES,
    getAccessToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
  });
  return {
    get: <T>(path: string, init?: HttpRequestOptions) => client.get<T>(path, withRequestPolicy("GET", path, init)),
    post: <T>(path: string, body?: unknown, init?: HttpRequestOptions) =>
      client.post<T>(path, body, withRequestPolicy("POST", path, init)),
    put: <T>(path: string, body?: unknown, init?: HttpRequestOptions) =>
      client.put<T>(path, body, withRequestPolicy("PUT", path, init)),
    patch: <T>(path: string, body?: unknown, init?: HttpRequestOptions) =>
      client.patch<T>(path, body, withRequestPolicy("PATCH", path, init)),
    del: <T>(path: string, init?: HttpRequestOptions) => client.del<T>(path, withRequestPolicy("DELETE", path, init)),
  };
}

export function getApi(): HttpClient {
  if (_api) return _api;
  _api = createApi();
  return _api;
}
