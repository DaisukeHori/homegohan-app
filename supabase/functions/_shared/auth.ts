/**
 * 認証ヘルパー - Edge Functions用
 *
 * requireAuth:        ユーザー向け関数 — Supabase JWT を検証し userId を返す
 * requireServiceRole: バッチ向け関数  — CRON_SECRET / SERVICE_ROLE_SECRET を検証する
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
 * 一致すれば null を返す（認証成功）。
 * 失敗すれば 401 / 503 Response を返す（呼び出し元は early return すること）。
 *
 * @example
 * const authErr = requireServiceRole(req);
 * if (authErr) return authErr;
 */
export function requireServiceRole(req: Request): Response | null {
  const secret =
    Deno.env.get("CRON_SECRET") ?? Deno.env.get("SERVICE_ROLE_SECRET");

  if (!secret) {
    return new Response(
      JSON.stringify({ error: "Service not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}
