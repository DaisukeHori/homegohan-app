/**
 * 認証ヘルパー - Edge Functions用
 *
 * requireAuth:        ユーザー向け関数 — Supabase JWT を検証し userId を返す
 * requireServiceRole: バッチ向け関数  — CRON_SECRET / SERVICE_ROLE_SECRET / service role key を検証する
 */

import { createClient } from "@supabase/supabase-js";

// -------------------------------------------------------
// ユーザー認証（JWT）
// -------------------------------------------------------

export type AuthOk = { userId: string };

/**
 * Authorization: Bearer <jwt> を検証し、成功時は { userId } を返す。
 * 失敗時は 401 Response を返す（呼び出し元は early return すること）。
 *
 * @example
 * const authResult = await requireAuth(req);
 * if (authResult instanceof Response) return authResult;
 * const { userId } = authResult;
 */
export async function requireAuth(req: Request): Promise<AuthOk | Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Authorization header required" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  return { userId: user.id };
}

// -------------------------------------------------------
// サービスロール認証（CRON_SECRET）
// -------------------------------------------------------

/**
 * Authorization: Bearer <secret> を CRON_SECRET / SERVICE_ROLE_SECRET と比較する。
 * service role key（SERVICE_ROLE_JWT / SUPABASE_SERVICE_ROLE_KEY）の完全一致でも許可する。
 * 一致すれば null を返す（認証成功）。
 * 失敗すれば 401 / 503 Response を返す（呼び出し元は early return すること）。
 *
 * service role key を許可するのは、Next.js の API ルート（権限の確認を済ませたうえで呼ぶ）が持っているのが
 * CRON_SECRET ではなく service role key だから。regenerate-embeddings / stripe-price-sync が関数の中で
 * すでにやっている判定と同じ規約。署名を検証していない JWT のペイロードの role は信用せず、完全一致だけで判定する。
 * service role key はもともとDBを全権で操作できる鍵なので、これを受け付けても呼べる人は増えない。
 * 認証方式 (Bearer) を付けずに鍵だけを送ったものは通さない。
 *
 * @example
 * const authErr = requireServiceRole(req);
 * if (authErr) return authErr;
 */
export function requireServiceRole(req: Request): Response | null {
  const authHeader = req.headers.get("authorization");

  // "Bearer <token>" の <token> だけを取り出す (Bearer の綴りの大文字小文字と、前後の空白は許す)
  const bearerToken = /^Bearer\s+(.+?)\s*$/i.exec(authHeader ?? "")?.[1] ?? "";
  const serviceRoleKeys = [
    Deno.env.get("SERVICE_ROLE_JWT"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  ].filter((key): key is string => !!key);
  if (bearerToken && serviceRoleKeys.includes(bearerToken)) {
    return null;
  }

  const secret =
    Deno.env.get("CRON_SECRET") ?? Deno.env.get("SERVICE_ROLE_SECRET");

  if (!secret) {
    return new Response(
      JSON.stringify({ error: "Service not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  if (authHeader !== `Bearer ${secret}`) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}
