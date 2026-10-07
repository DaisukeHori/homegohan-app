-- migration: 20261007094000_revoke_is_inactive_user_from_authenticated.sql
-- #1239: is_inactive_user RPC を authenticated から閉じる (任意 UUID の実在・休眠を調べられるオラクルの解消)
--
-- 背景:
--   public.is_inactive_user(p_user_id uuid) は SECURITY DEFINER で auth.users.last_sign_in_at を読み、
--   「30 日以上サインインなし / 存在しない」を boolean で返す。呼び出し元の権限は確認しない。
--   本番 (2026-10-06 のスナップショット supabase/baseline/catalog/catalog_functions.csv / prod_function_acl.sql) では
--   EXECUTE が postgres・authenticated・service_role にある (20260511000133 が authenticated へ GRANT し、
--   20260711130000 は PUBLIC と anon しか剥奪しなかった)。
--   ログインユーザーなら、家族メンバー一覧などで得た他人の user_id を渡して
--   supabase.rpc('is_inactive_user', { p_user_id }) を呼ぶだけで、そのアカウントの実在 (存在しない UUID は true)
--   と直近 30 日のログインの有無が分かる。
--   兄弟関数の list_orgs_with_inactive_owner / list_families_with_inactive_representative は
--   関数の先頭で super_admin を確認している (INSUFFICIENT_PERMISSION)。
--
-- 変更:
--   REVOKE EXECUTE ON FUNCTION public.is_inactive_user(uuid) FROM PUBLIC, anon, authenticated;
--   GRANT  EXECUTE ON FUNCTION public.is_inactive_user(uuid) TO service_role;
--   関数本体は変えない (所有者 postgres は暗黙に EXECUTE を持つ)。
--
-- 既存の正当な利用経路への影響: なし。
--   呼び出し元を全て確認した結果、is_inactive_user を呼ぶものは無かった。
--   - RLS ポリシー: baseline の catalog_policies.csv と migrations のどのポリシーの述語にも無い
--   - 他の関数・ビュー: baseline/prod_schema.sql と migrations のどの本体にも無い
--     (list_orgs_with_inactive_owner 等は auth.users を直接参照しており、この関数を呼ばない)
--   - src/ apps/mobile/ supabase/functions/ scripts/ packages/ に呼び出しは無い
--     (src/types/database.types.ts と packages/shared/src/database.types.ts の生成型の定義のみ)
--   将来サーバー側 (service role) から使う場合は、引き続き呼べる。
--
-- 冪等: REVOKE / GRANT は何度でも適用できる。関数が無い環境でも失敗しないよう to_regprocedure で確認する。
-- 確認: tests/integration/rls/is-inactive-user-rpc.test.ts
-- ロールバック: supabase/rollbacks/20261007094000_revoke_is_inactive_user_from_authenticated.down.sql

DO $$
BEGIN
  IF to_regprocedure('public.is_inactive_user(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.is_inactive_user(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.is_inactive_user(uuid) TO service_role;
  END IF;
END $$;
