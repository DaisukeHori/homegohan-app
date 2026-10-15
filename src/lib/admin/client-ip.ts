/**
 * 運営の操作の監査ログ (admin_audit_logs.ip_address) に残す「利用者の IP アドレス」の取り出し (#1200 / #1571)
 *
 * 利用者の IP は、プロキシ (Vercel) が付ける x-forwarded-for の先頭 (無ければ x-real-ip) を正とする。
 *
 * サーバーコンポーネントから内部 API を呼ぶ経路 (src/lib/admin/fetch.ts の adminFetch) では、それだけでは足りない (#1571):
 *   adminFetch はサーバーから自分のドメインの API へ HTTP で問い合わせる。Vercel は外から来たリクエストの
 *   x-forwarded-for / x-real-ip を自分で付け直す (偽装を防ぐため。転送した値は捨てられる) ので、内部 API が受け取る
 *   x-forwarded-for は「利用者」ではなく「問い合わせたサーバー (Vercel の関数)」の IP になる。
 *   そのまま記録すると、サーバーコンポーネント経由の閲覧の監査行が、すべてサーバーの IP になる。
 *
 * そこで adminFetch は、元のリクエストから取った利用者の IP を専用のヘッダー (FORWARDED_CLIENT_IP_HEADER) に入れ、
 * 時刻とサーバーだけが知る鍵の HMAC で署名して送る。内部 API の側 (extractClientIp) は、署名が正しく新しいときだけ
 * その IP を使い、それ以外は x-forwarded-for の先頭 → x-real-ip に戻る。
 *   - 署名の鍵は service_role キーから導く (サーバーだけが持つ。新しい環境変数を足さずに本番で効く)。
 *     service_role キーそのものはヘッダーに出さない (HMAC から鍵は戻せない)。鍵が無い環境では署名せず、従来どおり。
 *   - 利用者がブラウザから同じ名前のヘッダーを付けても、鍵を知らないので署名を作れず、無視される (偽装できない)。
 *
 * 定期処理 (pg_cron の cleanup_handson_tour_sandbox_rows など) が DB の中で書く行は、操作した利用者がいないので
 * ip_address は NULL のまま (付けるべき IP が無い。NULL は「記録漏れ」ではなく「利用者のいない操作」を表す)。
 *
 * このファイルは Node.js のサーバーだけで使う (crypto・net を読む)。値は認可の判断には使わない (監査の手がかり)。
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { getSupabaseServiceRoleKey, isMissingEnvError } from '@/lib/env-required';

/** adminFetch が内部 API へ送る、元のリクエストの利用者の IP */
export const FORWARDED_CLIENT_IP_HEADER = 'x-homegohan-admin-client-ip';
/** 署名した時刻 (ミリ秒の UNIX 時刻。10 進の整数) */
export const FORWARDED_CLIENT_IP_ISSUED_AT_HEADER = 'x-homegohan-admin-client-ip-issued-at';
/** 署名 (HMAC-SHA256 の 16 進) */
export const FORWARDED_CLIENT_IP_SIGNATURE_HEADER = 'x-homegohan-admin-client-ip-signature';

/**
 * 署名を受け付ける時刻の幅 (前後)。adminFetch はページの描画の途中で内部 API を呼ぶので、署名から受け取りまでは
 * 数秒で済む。同じデプロイの関数どうしの時計のずれを見込んで 5 分にする (運用で調整する値ではない)。
 */
export const FORWARDED_CLIENT_IP_MAX_AGE_MS = 5 * 60 * 1000;

/** service_role キーから署名の鍵を導くときの用途の名前 (ほかの用途の HMAC と鍵を分ける) */
const SIGNING_KEY_CONTEXT = 'homegohan/admin-fetch/forwarded-client-ip/v1';

/** SHA-256 の HMAC の 16 進の長さ (32 バイト) */
const SIGNATURE_HEX_LENGTH = 64;

/** inet 列に入れられる IP アドレスか (IPv6 のゾーン ID 付き fe80::1%eth0 は inet が受け付けないので除外) */
function asStorableIp(value: string | null | undefined): string | null {
  const ip = value?.trim();
  if (ip && !ip.includes('%') && isIP(ip) !== 0) return ip;
  return null;
}

/**
 * プロキシが付けたヘッダーから、利用者の IP を 1 つ取り出す (x-forwarded-for の先頭 → x-real-ip)。
 *
 * ip_address 列は inet 型。x-forwarded-for は "client, proxy1, proxy2" のように複数 IP が入ることがあり、
 * そのまま渡すと INSERT が失敗して監査行ごと失われる。そのため先頭の 1 つだけを取り、IP として正しいときだけ返す。
 * 正しくなければ x-real-ip を試し、それも正しくなければ null。
 */
export function extractProxyClientIp(headers: Pick<Headers, 'get'> | null | undefined): string | null {
  if (!headers) return null;
  return asStorableIp(headers.get('x-forwarded-for')?.split(',')[0]) ?? asStorableIp(headers.get('x-real-ip'));
}

/** 署名の鍵。service_role キーが無い環境 (鍵を持たないビルドなど) では null (署名しない・受け付けない) */
function signingKey(): Buffer | null {
  let secret: string;
  try {
    secret = getSupabaseServiceRoleKey();
  } catch (err) {
    if (isMissingEnvError(err)) return null;
    throw err;
  }
  return createHmac('sha256', secret).update(SIGNING_KEY_CONTEXT).digest();
}

function signatureOf(key: Buffer, ip: string, issuedAt: string): string {
  return createHmac('sha256', key).update(`${issuedAt}\n${ip}`).digest('hex');
}

/**
 * adminFetch が内部 API へ付けるヘッダー (利用者の IP・時刻・署名) を作る。
 * IP が正しくない・鍵が無いときは null (何も付けない。内部 API は従来どおり x-forwarded-for を読む)。
 */
export function signForwardedClientIp(ip: string | null, nowMs: number = Date.now()): Record<string, string> | null {
  const storable = asStorableIp(ip);
  if (!storable) return null;
  const key = signingKey();
  if (!key) return null;
  const issuedAt = String(Math.trunc(nowMs));
  return {
    [FORWARDED_CLIENT_IP_HEADER]: storable,
    [FORWARDED_CLIENT_IP_ISSUED_AT_HEADER]: issuedAt,
    [FORWARDED_CLIENT_IP_SIGNATURE_HEADER]: signatureOf(key, storable, issuedAt),
  };
}

/**
 * adminFetch が付けた利用者の IP を、署名を確かめてから返す。
 * ヘッダーが無い・IP が正しくない・時刻が古い (または先すぎる)・署名が合わない・鍵が無いときは null。
 */
export function readForwardedClientIp(
  headers: Pick<Headers, 'get'> | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!headers) return null;
  const ip = asStorableIp(headers.get(FORWARDED_CLIENT_IP_HEADER));
  const issuedAt = headers.get(FORWARDED_CLIENT_IP_ISSUED_AT_HEADER)?.trim() ?? '';
  const signature = headers.get(FORWARDED_CLIENT_IP_SIGNATURE_HEADER)?.trim().toLowerCase() ?? '';
  if (!ip || !/^\d+$/.test(issuedAt) || !/^[0-9a-f]+$/.test(signature) || signature.length !== SIGNATURE_HEX_LENGTH) {
    return null;
  }
  if (Math.abs(nowMs - Number(issuedAt)) > FORWARDED_CLIENT_IP_MAX_AGE_MS) return null;
  const key = signingKey();
  if (!key) return null;
  const expected = Buffer.from(signatureOf(key, ip, issuedAt), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? ip : null;
}

/**
 * 監査ログに残す利用者の IP。
 *   1. adminFetch が署名して転送した利用者の IP (サーバーコンポーネント経由の呼び出し)
 *   2. x-forwarded-for の先頭 (ブラウザから直接の呼び出し。Vercel が付けた利用者の IP)
 *   3. x-real-ip
 *   4. どれも無ければ null (監査行は ip_address = null で残す)
 * 値はプロキシ (Vercel) が付けたものを信頼する前提の最善努力で、認可の判断には使わない。
 */
export function extractClientIp(headers: Pick<Headers, 'get'> | null | undefined): string | null {
  return readForwardedClientIp(headers) ?? extractProxyClientIp(headers);
}
