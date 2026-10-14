-- rollback: 20261008160000_revoke_anon_execute_on_definer_functions.sql
-- 5 関数の EXECUTE 権限と、2 ポリシーの対象ロールを、この migration の直前の状態へ戻す。
--   preview_family_invite(text) / preview_org_invite(text) / can_view_user_meals(uuid) / organizations_owner_id_unchanged(uuid, uuid):
--     anon に EXECUTE を戻す (authenticated / service_role は migration が変えていないので、そのまま)。
--   cleanup_handson_tour_sandbox_rows():
--     PUBLIC に EXECUTE を戻す (service_role は migration が変えていないので、そのまま)。
--   meals_select_owner_or_family / organizations_update_admin: 対象ロールを authenticated から PUBLIC に戻す (式は変えていない)。
-- ⚠️ 戻すと #1103 (7) の穴が復活する。
--    - 未ログインの anon キーだけで、5 関数を /rest/v1/rpc から直接呼べる。
--    - cleanup_handson_tour_sandbox_rows は PUBLIC に戻るので、anon もログインユーザーも誰でも呼べる。
--      呼ぶと 90 日より古い sandbox の食事と日別献立を全ユーザー分消し、admin_audit_logs に行を足す。
--    緊急時の切り戻し専用 (たとえば、夜間のジョブが cleanup_handson_tour_sandbox_rows を実行できなくなったとき。
--    その場合も、PUBLIC ではなく、ジョブを動かすロールだけに GRANT する方が安全)。
-- 順序: 関数の権限を戻してから、ポリシーを PUBLIC に戻す (逆にすると、そのあいだ anon の問い合わせが 42501 になる)。
-- データは戻さない (この migration はデータを更新していない)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。
-- 何度流しても同じ結果になる (冪等)。

SET LOCAL lock_timeout = '10s';

GRANT EXECUTE ON FUNCTION public.preview_family_invite(text) TO anon;
GRANT EXECUTE ON FUNCTION public.preview_org_invite(text) TO anon;
GRANT EXECUTE ON FUNCTION public.can_view_user_meals(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.organizations_owner_id_unchanged(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.cleanup_handson_tour_sandbox_rows() TO PUBLIC;

ALTER POLICY meals_select_owner_or_family ON public.meals TO public;
ALTER POLICY organizations_update_admin ON public.organizations TO public;
