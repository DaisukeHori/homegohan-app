/**
 * API call helper for integration tests
 * Calls Next.js API routes via HTTP (requires dev server running)
 * or via direct route handler invocation
 */

const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * 認証ヘッダを付けて HTTP リクエストを送る共通処理。
 * `rawBody` は文字列のままボディに載せる (JSON.stringify は呼び出し側の責任)。
 */
async function send<T>(
  method: HttpMethod,
  path: string,
  jwt: string | null,
  rawBody: string | undefined
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
    // Also send as cookie for Next.js SSR auth (Supabase SSR reads cookies)
    headers['Cookie'] = `sb-access-token=${jwt}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: rawBody,
  });

  let responseBody: T;
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    responseBody = (await response.json()) as T;
  } else {
    responseBody = (await response.text()) as unknown as T;
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    body: responseBody,
    headers: responseHeaders,
  };
}

/**
 * Make an authenticated HTTP request to the API
 */
export async function apiCall<T = unknown>(
  method: HttpMethod,
  path: string,
  jwt: string | null,
  body?: unknown
): Promise<ApiResponse<T>> {
  return send<T>(method, path, jwt, body !== undefined ? JSON.stringify(body) : undefined);
}

/**
 * 生のボディ文字列をそのまま送る (JSON.stringify を通さない)。
 * 壊れた JSON など、`apiCall` では作れないリクエストボディの検証用。
 */
export async function apiCallRaw<T = unknown>(
  method: Exclude<HttpMethod, 'GET'>,
  path: string,
  jwt: string | null,
  rawBody: string
): Promise<ApiResponse<T>> {
  return send<T>(method, path, jwt, rawBody);
}

/**
 * Make an unauthenticated request (no JWT)
 */
export async function apiCallNoAuth<T = unknown>(
  method: HttpMethod,
  path: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  return apiCall<T>(method, path, null, body);
}
