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

/**
 * Make an authenticated HTTP request to the API
 */
export async function apiCall<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  jwt: string | null,
  body?: unknown
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
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
 * Make an unauthenticated request (no JWT)
 */
export async function apiCallNoAuth<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  return apiCall<T>(method, path, null, body);
}
