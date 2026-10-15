/**
 * 運営が隠したコンテンツの完全削除 (#1538)
 *
 * 運営が隠した (hidden_at が入った) 食事・レシピの行と、その画像のファイルを、隠してから 90 日を過ぎたら消す。
 * 本体は _shared/hidden-content-purge.ts (何を消すか・消さないかは、そのファイルの冒頭)。
 *
 * 呼び出し元: pg_cron のジョブ purge-hidden-content (毎日 03:25 JST) が public.invoke_purge_hidden_content() から
 * net.http_post で呼ぶ (Vault の app_cron_secret を Bearer に付ける。migration 20261016100000_purge_hidden_content.sql)。
 * 画像のファイルは SQL では消せない (storage.objects の protect_objects_delete トリガー) ので、Storage API を使える Edge Function にしている。
 *
 * 本文は読まない (時刻はいつも実行した時刻。保管期間を呼び出しで縮められないようにする)。
 * バッチ専用 (ブラウザからは呼ばれない) なので CORS は付けない (#1167)。
 */
import { createClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { createLogger, generateRequestId } from "../_shared/db-logger.ts";
import { purgeExpiredHiddenContent } from "../_shared/hidden-content-purge.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** 失敗したときの本文。例外の文 (DB・Storage の内部の文) は返さず、ログにだけ残す (#1444) */
const PURGE_FAILED_MESSAGE = "purge failed";

Deno.serve(async (req: Request) => {
  // バッチ専用: CRON_SECRET 認証 (本文を読む前・DB に触る前)
  const authErr = await requireServiceRole(req);
  if (authErr) return authErr;

  const requestId = generateRequestId();
  const logger = createLogger("purge-hidden-content", requestId);

  try {
    const result = await purgeExpiredHiddenContent(supabaseAdmin, { now: new Date() });
    logger.info("hidden content purge finished", { ...result });
    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    logger.error("hidden content purge failed", error);
    return new Response(JSON.stringify({ success: false, error: PURGE_FAILED_MESSAGE }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
