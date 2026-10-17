/**
 * 認証ヘルパー - Edge Functions用
 *
 * requireAuth:        ユーザー向け関数 — Supabase JWT を検証し userId を返す
 * requireServiceRole: バッチ向け関数  — CRON_SECRET (または CRON_SECRET_PREVIOUS / 別名 SERVICE_ROLE_SECRET) / service role key を検証する
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

/** requireServiceRole の照合の結果 (Response にする前の形)。cron-secret-probe が応答に載せる */
export type ServiceRoleAuthDescription =
  | {
      ok: true;
      /** どの値と一致したか。service_role_key = service role key の完全一致 / current = CRON_SECRET (無ければ SERVICE_ROLE_SECRET) / previous = CRON_SECRET_PREVIOUS */
      matched: "service_role_key" | "current" | "previous";
      /** CRON_SECRET が未設定で、別名の SERVICE_ROLE_SECRET を現行として使っているか (?? の規則: CRON_SECRET が空文字なら別名には切り替わらない) */
      alias_used: boolean;
      /** CRON_SECRET_PREVIOUS が設定されている (空文字でない) か */
      previous_configured: boolean;
    }
  | { ok: false; reason: "not_configured" | "unauthorized" };

/**
 * requireServiceRole と同じ規則で照合し、結果だけを返す (Response を作らない・ログを出さない)。
 * 値は返さない (戻り値は一致した種類と真偽値だけ)。
 * checkCronSecret を呼ぶのはこの関数だけ (requireServiceRole はこの関数の結果を Response に変える)。
 */
export async function describeServiceRoleAuth(req: Request): Promise<ServiceRoleAuthDescription> {
  const authHeader = req.headers.get("authorization");

  // "Bearer <token>" の <token> だけを取り出す (Bearer の綴りの大文字小文字と、前後の空白は許す)
  const bearerToken = /^Bearer\s+(.+?)\s*$/i.exec(authHeader ?? "")?.[1] ?? "";
  const serviceRoleKeys = [
    Deno.env.get("SERVICE_ROLE_JWT"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  ].filter((key): key is string => !!key);
  const cronSecret = Deno.env.get("CRON_SECRET");
  const aliasSecret = Deno.env.get("SERVICE_ROLE_SECRET");
  const previousSecret = Deno.env.get("CRON_SECRET_PREVIOUS");
  const alias_used = cronSecret === undefined && aliasSecret !== undefined;
  const previous_configured = typeof previousSecret === "string" && previousSecret.length > 0;

  if (bearerToken && serviceRoleKeys.includes(bearerToken)) {
    return { ok: true, matched: "service_role_key", alias_used, previous_configured };
  }

  const result = await checkCronSecret(authHeader, {
    current: cronSecret ?? aliasSecret,
    previous: previousSecret,
  });
  if (result.ok) {
    return { ok: true, matched: result.matched, alias_used, previous_configured };
  }
  return { ok: false, reason: result.reason };
}

/**
 * Authorization: Bearer <secret> を CRON_SECRET と比較する
 * (CRON_SECRET が未設定のときだけ、別名の SERVICE_ROLE_SECRET を代わりに使う)。
 * service role key（SERVICE_ROLE_JWT / SUPABASE_SERVICE_ROLE_KEY）の完全一致でも許可する。
 *
 * シークレットを入れ替えている間は、旧い値の CRON_SECRET_PREVIOUS も受け付ける
 * (手順は ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」)。未設定・空文字の CRON_SECRET_PREVIOUS は無視する。
 * 比較は SHA-256 のダイジェスト同士の定数時間比較 (_shared/cron-secret.ts)。
 *
 * 一致すれば null を返す（認証成功）。
 * 失敗すれば 401 / 503 Response を返す（呼び出し元は early return すること）。
 *
 * service role key を許可するのは、Next.js の API ルート（権限の確認を済ませたうえで呼ぶ）が持っているのが
 * CRON_SECRET ではなく service role key だから。regenerate-embeddings / stripe-price-sync が関数の中で
 * すでにやっている判定と同じ規約。署名を検証していない JWT のペイロードの role は信用せず、完全一致だけで判定する。
 * service role key はもともとDBを全権で操作できる鍵なので、これを受け付けても呼べる人は増えない。
 * 認証方式 (Bearer) を付けずに鍵だけを送ったものは通さない。
 *
 * ダイジェストの計算が非同期なので Promise を返す。必ず await すること
 * (await を忘れると、null でも Response でもない Promise が来て if (authErr) が常に真になる)。
 *
 * @example
 * const authErr = await requireServiceRole(req);
 * if (authErr) return authErr;
 */
export async function requireServiceRole(req: Request): Promise<Response | null> {
  const auth = await describeServiceRoleAuth(req);
  if (auth.ok) {
    if (auth.matched === "previous") {
      // 送信側 (Vault の app_cron_secret など) がまだ旧い値を使っている。
      // このログが出なくなったことを確かめてから CRON_SECRET_PREVIOUS を外す (秘密の値そのものは出さない)
      console.warn(
        `[auth] requireServiceRole: CRON_SECRET_PREVIOUS (旧いシークレット) で認証されました (${requestPath(req)})。送信側を新しい CRON_SECRET に更新してください`,
      );
    }
    return null;
  }

  if (auth.reason === "not_configured") {
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
