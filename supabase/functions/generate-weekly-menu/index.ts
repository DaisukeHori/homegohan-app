// NOTE:
// `generate-weekly-menu` は互換入口として残し、実体は v2 のハンドラを同一プロセスで実行する。
// Edge Function 間のHTTP呼び出しは Cloudflare/内部タイムアウトで不安定になり得るため避ける。
//
// 重要:
// - ここでいう v2 は「献立生成ロジックの世代（dataset駆動）」です。
// - `/functions/v1/...` の "v1" は Supabase Edge Functions のHTTPパスのバージョンで、ロジックのv1/v2とは別です。

import { handleGenerateWeeklyMenuV2 } from "../generate-weekly-menu-v2/index.ts";

Deno.serve(handleGenerateWeeklyMenuV2);


