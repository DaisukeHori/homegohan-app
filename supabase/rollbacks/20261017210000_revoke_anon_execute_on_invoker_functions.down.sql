-- rollback: 20261017210000_revoke_anon_execute_on_invoker_functions.sql
-- 12 関数の EXECUTE 権限を、この migration の直前の状態へ戻す (2026-10-17 の本番とローカルの ACL と同じ)。
--   anon と PUBLIC の両方に EXECUTE が付いていた 10 本: anon と PUBLIC に戻す。
--     normalize_dish_name(text)・get_7d_checkin_averages(uuid, date)・search_* の 8 本
--   anon にだけ付いていて、PUBLIC には付いていなかった 2 本: anon にだけ戻す。
--     create_org_invite(uuid, text, org_role_enum, text) / user_has_non_sandbox_activity()
--   authenticated・service_role は migration が変えていないので、そのまま。
-- ⚠️ 戻すと #1821 の状態に戻る (未ログインの anon キーだけで、12 関数を /rest/v1/rpc から直接呼べる)。
--    どれも SECURITY INVOKER なので anon の権限と RLS のもとで動くが、要らない権限が残る。緊急時の切り戻し専用。
-- データは戻さない (この migration はデータを更新していない)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。
-- 何度流しても同じ結果になる (冪等)。

-- anon と PUBLIC に付いていた 10 本
GRANT EXECUTE ON FUNCTION public.normalize_dish_name(text) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_7d_checkin_averages(uuid, date) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_dataset_ingredients_by_embedding(extensions.vector, integer) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_ingredients_by_text_similarity(text, numeric, integer) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_ingredients_full_by_embedding(extensions.vector, integer) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_menu_examples(extensions.vector, integer, text, numeric, text[]) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_recipes_hybrid(text, extensions.vector, integer, numeric) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_recipes_with_nutrition(text, numeric, integer) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_similar_dataset_ingredients(text, numeric, integer) TO anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_similar_dataset_recipes(text, numeric, integer) TO anon, PUBLIC;

-- anon にだけ付いていた 2 本 (PUBLIC には付いていなかった)
GRANT EXECUTE ON FUNCTION public.create_org_invite(uuid, text, public.org_role_enum, text) TO anon;
GRANT EXECUTE ON FUNCTION public.user_has_non_sandbox_activity() TO anon;
