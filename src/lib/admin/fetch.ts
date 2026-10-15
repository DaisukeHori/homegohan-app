/**
 * Server Component から内部 Admin API を呼び出すためのフェッチユーティリティ。
 * Cookie ヘッダーを転送して認証セッションを維持する。
 */

import { headers, cookies } from 'next/headers';
import { extractProxyClientIp, signForwardedClientIp } from '@/lib/admin/client-ip';

/**
 * PORT が無いときの、このサーバーのポート。Next.js (next dev / next start) が -p も PORT も無いときに待ち受ける既定のポート
 */
export const DEFAULT_SERVER_PORT = 3000;

/**
 * 内部 API のベース URL を返す。
 * NEXTAUTH_URL / VERCEL_URL / localhost:PORT (このサーバー自身が待ち受けているポート) / localhost:3000 の優先順で解決する。
 * #1584: 以前は最後が固定の localhost:3000 で、Next を 3000 以外のポートで動かすと (local-ci の枠 1 以上など)、
 * 別のサーバーに問い合わせるか、繋がらずに一覧が空になっていた。
 */
function getBaseUrl(): string {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const port = process.env.PORT?.trim();
  return `http://localhost:${port || DEFAULT_SERVER_PORT}`;
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
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();
  const cookieHeader = allCookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  // リクエストヘッダーを構築
  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get('x-forwarded-for') ?? undefined;
  const host = requestHeaders.get('host') ?? undefined;
  // #1200: 閲覧の監査ログ (admin_audit_logs.user_agent) に、サーバーの fetch ではなく
  // 管理者のブラウザの User-Agent が残るように転送する。
  const userAgent = requestHeaders.get('user-agent') ?? undefined;
  // #1571: 監査ログ (admin_audit_logs.ip_address) に管理者の IP が残るよう、元のリクエストの利用者の IP を署名して転送する。
  // Vercel は内部 API へのこの問い合わせの x-forwarded-for / x-real-ip を、問い合わせたサーバーの IP に付け直す
  // (上の x-forwarded-for の転送は Vercel の外 (next start など) でしか効かない)。署名の仕組みは src/lib/admin/client-ip.ts。
  const signedClientIp = signForwardedClientIp(extractProxyClientIp(requestHeaders));

  const fetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    ...(userAgent ? { 'user-agent': userAgent } : {}),
    ...(host ? { host } : {}),
    ...options.extraHeaders,
    // 呼び出し側の extraHeaders で上書きさせない (利用者の IP は元のリクエストからだけ取る)
    ...(signedClientIp ?? {}),
  };

  return fetch(url, {
    ...options,
    headers: fetchHeaders,
    // Server Component から同一プロセス内の API を呼ぶ場合、キャッシュ不要
    cache: 'no-store',
  });
}
