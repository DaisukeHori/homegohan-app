/**
 * Server Component から内部 Admin API を呼び出すためのフェッチユーティリティ。
 * Cookie ヘッダーを転送して認証セッションを維持する。
 */

import { headers, cookies } from 'next/headers';

/**
 * 内部 API のベース URL を返す。
 * NEXTAUTH_URL / VERCEL_URL / localhost の優先順で解決する。
 */
function getBaseUrl(): string {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

type FetchOptions = Omit<RequestInit, 'headers'> & {
  extraHeaders?: Record<string, string>;
};

/**
 * Server Component から内部 API Route を認証付きで呼び出す。
 * Cookie を転送して Supabase auth セッションを維持する。
 */
export async function adminFetch(
  path: string,
  options: FetchOptions = {},
): Promise<Response> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  // Cookie ヘッダーを構築 (Supabase auth セッション用)
  const cookieStore = cookies();
  const allCookies = cookieStore.getAll();
  const cookieHeader = allCookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  // リクエストヘッダーを構築
  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get('x-forwarded-for') ?? undefined;
  const host = requestHeaders.get('host') ?? undefined;

  const fetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    ...(host ? { host } : {}),
    ...options.extraHeaders,
  };

  return fetch(url, {
    ...options,
    headers: fetchHeaders,
    // Server Component から同一プロセス内の API を呼ぶ場合、キャッシュ不要
    cache: 'no-store',
  });
}
