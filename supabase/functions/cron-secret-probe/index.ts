/**
 * cron の共有シークレットの確認 (#1560。設計 docs/design/operator/12-cron-secret-drift-monitor.md §6)。
 * GET /api/cron/app-log-alerts が DB の public.send_cron_secret_probe() から、pg_cron と同じく Vault の app_cron_secret を Bearer に付けて
 * pg_net で呼ぶ。応答は net._http_response に残り、次の回が読んで判定する。
 * 行うのは照合だけ: 先頭で requireServiceRole (ほかのバッチ関数と同じ 401 / 503)、通ったら describeServiceRoleAuth の結果をキー 4 つの JSON で返す。
 * 本文は読まない・DB に触らない・環境変数を直接読まない (CC-1)・秘密の値もダイジェストも返さない・CORS は付けない (バッチ専用。#1167)。
 * 照合を 2 回計算するのは、先頭の認証の形 (await requireServiceRole(req)) を番兵 (tests/edge-function-verify-jwt.test.ts) がそのまま見られるようにするため。
 */
import { describeServiceRoleAuth, requireServiceRole } from "../_shared/auth.ts";

/** 受け付けるメソッド (pg_net は POST。手で確かめるときの GET も許す。どちらも本文は読まない) */
const ALLOWED_METHODS = ["GET", "POST"];

const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  // バッチ専用: CRON_SECRET 認証 (本文を読む前・DB に触る前)
  const authErr = await requireServiceRole(req);
  if (authErr) return authErr;

  if (!ALLOWED_METHODS.includes(req.method)) {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
  }

  const auth = await describeServiceRoleAuth(req);
  if (!auth.ok) {
    // requireServiceRole が通った直後に secrets が変わった (まれ)。requireServiceRole と同じ 401 にそろえる
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }
  return new Response(
    JSON.stringify({
      ok: true,
      matched: auth.matched,
      previous_configured: auth.previous_configured,
      alias_used: auth.alias_used,
    }),
    { status: 200, headers: JSON_HEADERS },
  );
});
