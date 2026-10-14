-- rollback: 20261007112100_child_promotion_consent_rpcs.sql
-- 旧・強制編入版 (promote_child_to_user の本体) には絶対に戻さない (戻すと #1232 の脆弱性が再燃する)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。
--
-- (推奨) 機能を一時停止するだけなら、新規のリクエスト作成だけを止める (承認待ちの承認・拒否は生かす):
--   REVOKE EXECUTE ON FUNCTION public.request_child_promotion(uuid, text) FROM authenticated;
-- 承認・拒否も止める場合:
--   REVOKE EXECUTE ON FUNCTION public.accept_child_promotion(text, boolean, boolean, boolean) FROM authenticated;
--   REVOKE EXECUTE ON FUNCTION public.reject_child_promotion(text) FROM authenticated;
--
-- (最後の手段) RPC 5 本を削除する。続けて 20261007112000 のロールバックを当てるとテーブルも消える。

DROP FUNCTION IF EXISTS public.get_promotion_details(text);
DROP FUNCTION IF EXISTS public.revoke_child_promotion(uuid);
DROP FUNCTION IF EXISTS public.reject_child_promotion(text);
DROP FUNCTION IF EXISTS public.accept_child_promotion(text, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS public.request_child_promotion(uuid, text);
