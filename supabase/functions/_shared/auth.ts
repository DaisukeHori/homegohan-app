/**
 * 認証ヘルパー - Edge Functions用
 *
 * requireAuth:        ユーザー向け関数 — Supabase JWT を検証し userId を返す
 * requireServiceRole: バッチ向け関数  — CRON_SECRET (または CRON_SECRET_PREVIOUS / 別名 SERVICE_ROLE_SECRET) を検証する
 */

import { createClient } from "@supabase/supabase-js";
import { checkCronSecret } from "./cron-secret.ts";

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
 * Authorization: Bearer <secret> を CRON_SECRET と比較する
 * (CRON_SECRET が未設定のときだけ、別名の SERVICE_ROLE_SECRET を代わりに使う)。
 *
 * シークレットを入れ替えている間は、旧い値の CRON_SECRET_PREVIOUS も受け付ける
 * (手順は ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」)。未設定・空文字の CRON_SECRET_PREVIOUS は無視する。
 * 比較は SHA-256 のダイジェスト同士の定数時間比較 (_shared/cron-secret.ts)。
 *
 * 一致すれば null を返す（認証成功）。
 * 失敗すれば 401 / 503 Response を返す（呼び出し元は early return すること）。
 *
 * ダイジェストの計算が非同期なので Promise を返す。必ず await すること
 * (await を忘れると、null でも Response でもない Promise が来て if (authErr) が常に真になる)。
 *
 * @example
 * const authErr = await requireServiceRole(req);
 * if (authErr) return authErr;
 */
export async function requireServiceRole(req: Request): Promise<Response | null> {
  const result = await checkCronSecret(req.headers.get("authorization"), {
    current: Deno.env.get("CRON_SECRET") ?? Deno.env.get("SERVICE_ROLE_SECRET"),
    previous: Deno.env.get("CRON_SECRET_PREVIOUS"),
  });

  if (result.ok) {
    if (result.matched === "previous") {
      // 送信側 (Vault の app_cron_secret など) がまだ旧い値を使っている。
      // このログが出なくなったことを確かめてから CRON_SECRET_PREVIOUS を外す (秘密の値そのものは出さない)
      console.warn(
        `[auth] requireServiceRole: CRON_SECRET_PREVIOUS (旧いシークレット) で認証されました (${requestPath(req)})。送信側を新しい CRON_SECRET に更新してください`,
      );
    }
    return null;
  }

  if (result.reason === "not_configured") {
    return new Response(
      JSON.stringify({ error: "Service not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

/** ログ用。クエリ文字列は秘密を含みうるので載せず、パスだけを返す。 */
function requestPath(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "unknown path";
  }
}
