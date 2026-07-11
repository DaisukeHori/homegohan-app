-- migration: 20260711130000_revoke_anon_execute_definer_rpcs.sql
-- #1020 追撃: SECURITY DEFINER RPC の REVOKE FROM PUBLIC 漏れ是正 (anon 個別 GRANT 分)
--
-- 背景:
--   Supabase は下記の default privilege を既定で設定しているため、新規関数は
--   PUBLIC からの EXECUTE を明示的に REVOKE しても、anon/authenticated/service_role
--   への「ロール個別 GRANT」は default privilege 経由で別途自動的に付与されており、
--   REVOKE ... FROM PUBLIC だけでは剥奪されない:
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
--
--   #1020 の実査で、以下 30 個の SECURITY DEFINER 関数が「REVOKE FROM PUBLIC」のみで
--   「REVOKE FROM anon」を欠いており、anon (未認証) からの個別 EXECUTE GRANT が
--   残存している疑いが判明した。本 migration は防御多層化として、各関数本体に
--   既にある auth.uid() ガード(認可)に加え、grant レベルでも anon を締める。
--
-- ⚠️ 除外した 3 関数 (招待プレビュー/詳細取得系。anon から正当に呼ばれるため温存):
--   - get_invite_details    : src/app/invite/[token]/page.tsx が未ログイン状態
--                              (auth.getUser() 判定より前) で直接 supabase.rpc() 呼び出し。
--                              定義元 20260511000133_membership_remaining_rpcs.sql の
--                              コメントに「認証不要: anon + authenticated」と明記され、
--                              GRANT EXECUTE ... TO anon, authenticated 済み。
--   - preview_org_invite    : 定義元 20260511000127_invite_token_rpc_only.sql で
--   - preview_family_invite   「token を持つユーザが招待詳細を確認するために使用」する
--                              専用 RPC として設計され、GRANT EXECUTE ... TO anon,
--                              authenticated 済み。現行フロントエンドからの呼び出しは
--                              確認できなかったが(get_invite_details に統合された可能性)、
--                              anon 前提で設計された RPC を誤って締めて招待プレビュー導線を
--                              壊すリスクを避けるため、fail-safe で温存する。
--
-- 対象 27 関数の判定根拠 (個別精査):
--   - 全関数、本体内で auth.uid() が NULL (＝未認証/anon) の場合に必ず例外を送出する
--     か、権限判定用の SELECT が auth.uid() に一致する行を見つけられず NULL 判定で
--     弾かれる実装になっており(fail-closed)、anon から呼んでも成功しない。
--   - is_inactive_user / can_view_user_meals / organizations_owner_id_unchanged は
--     ヘルパー/RLS 補助関数で、src 側から直接 rpc() 呼び出しされている箇所は無い
--     (grep 実査済み)。organizations_owner_id_unchanged は RLS の WITH CHECK 内で
--     呼ばれるが、関数内部で呼び出し元 (auth.uid()) が対象組織の owner/admin である
--     ことを確認しており、anon (auth.uid() IS NULL) から直接 RPC 経由で呼んでも
--     常に false を返すのみで情報漏洩がない。can_view_user_meals も同様に
--     auth.uid() = p_target_user_id 等の比較のみで anon には常に false。
--   - トリガー専用関数 (AFTER/BEFORE トリガーから暗黙に呼ばれるもの) はこの 27 関数の
--     中には無い(全て RPC として明示的に public に公開されている)ため、除外判断は
--     不要と判断した。
--
-- 冪等性:
--   各関数を to_regprocedure(...) で存在確認してから REVOKE するため、対象環境に
--   当該シグネチャの関数が存在しない場合は安全な no-op となる。REVOKE 自体も
--   対象ロールへの GRANT が既に無い状態で再実行してもエラーにならないため、
--   本 migration は 2 回連続実行してもエラー 0 で完了する。

DO $$
BEGIN
  -- 1. accept_family_invite(text, boolean, boolean, boolean)
  IF to_regprocedure('public.accept_family_invite(text, boolean, boolean, boolean)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.accept_family_invite(text, boolean, boolean, boolean) FROM PUBLIC, anon;
  END IF;

  -- 2. accept_family_representative_transfer(uuid)
  IF to_regprocedure('public.accept_family_representative_transfer(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.accept_family_representative_transfer(uuid) FROM PUBLIC, anon;
  END IF;

  -- 3. accept_org_owner_transfer(uuid)
  IF to_regprocedure('public.accept_org_owner_transfer(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.accept_org_owner_transfer(uuid) FROM PUBLIC, anon;
  END IF;

  -- 4. add_family_child(uuid, text, jsonb)
  IF to_regprocedure('public.add_family_child(uuid, text, jsonb)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.add_family_child(uuid, text, jsonb) FROM PUBLIC, anon;
  END IF;

  -- 5. admin_set_user_roles(uuid, text[])
  IF to_regprocedure('public.admin_set_user_roles(uuid, text[])') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.admin_set_user_roles(uuid, text[]) FROM PUBLIC, anon;
  END IF;

  -- 6. can_view_user_meals(uuid)
  IF to_regprocedure('public.can_view_user_meals(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.can_view_user_meals(uuid) FROM PUBLIC, anon;
  END IF;

  -- 7. create_family_group(text, text)
  IF to_regprocedure('public.create_family_group(text, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.create_family_group(text, text) FROM PUBLIC, anon;
  END IF;

  -- 8. create_family_invite(uuid, text, text)
  IF to_regprocedure('public.create_family_invite(uuid, text, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.create_family_invite(uuid, text, text) FROM PUBLIC, anon;
  END IF;

  -- 9. is_inactive_user(uuid)
  IF to_regprocedure('public.is_inactive_user(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.is_inactive_user(uuid) FROM PUBLIC, anon;
  END IF;

  -- 10. leave_family()
  IF to_regprocedure('public.leave_family()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.leave_family() FROM PUBLIC, anon;
  END IF;

  -- 11. leave_org()
  IF to_regprocedure('public.leave_org()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.leave_org() FROM PUBLIC, anon;
  END IF;

  -- 12. list_families_with_inactive_representative()
  IF to_regprocedure('public.list_families_with_inactive_representative()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.list_families_with_inactive_representative() FROM PUBLIC, anon;
  END IF;

  -- 13. list_orgs_with_inactive_owner()
  IF to_regprocedure('public.list_orgs_with_inactive_owner()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.list_orgs_with_inactive_owner() FROM PUBLIC, anon;
  END IF;

  -- 14. operator_force_dissolve_family(uuid, text)
  IF to_regprocedure('public.operator_force_dissolve_family(uuid, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.operator_force_dissolve_family(uuid, text) FROM PUBLIC, anon;
  END IF;

  -- 15. operator_force_dissolve_org(uuid, text)
  IF to_regprocedure('public.operator_force_dissolve_org(uuid, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.operator_force_dissolve_org(uuid, text) FROM PUBLIC, anon;
  END IF;

  -- 16. operator_force_owner_transfer(uuid, uuid, text)
  IF to_regprocedure('public.operator_force_owner_transfer(uuid, uuid, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.operator_force_owner_transfer(uuid, uuid, text) FROM PUBLIC, anon;
  END IF;

  -- 17. operator_force_representative_transfer(uuid, uuid, text)
  IF to_regprocedure('public.operator_force_representative_transfer(uuid, uuid, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.operator_force_representative_transfer(uuid, uuid, text) FROM PUBLIC, anon;
  END IF;

  -- 18. organizations_owner_id_unchanged(uuid, uuid)
  IF to_regprocedure('public.organizations_owner_id_unchanged(uuid, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.organizations_owner_id_unchanged(uuid, uuid) FROM PUBLIC, anon;
  END IF;

  -- 19. paste_meal_to_family(uuid, uuid[])
  IF to_regprocedure('public.paste_meal_to_family(uuid, uuid[])') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) FROM PUBLIC, anon;
  END IF;

  -- 20. promote_child_to_user(uuid, text)  ※旧シグネチャ (uuid, uuid) は
  --     20260710210062/20260511000135 で DROP FUNCTION 済みのため現行は (uuid, text) のみ
  IF to_regprocedure('public.promote_child_to_user(uuid, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.promote_child_to_user(uuid, text) FROM PUBLIC, anon;
  END IF;

  -- 21. propose_family_representative_transfer(uuid, uuid)
  IF to_regprocedure('public.propose_family_representative_transfer(uuid, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.propose_family_representative_transfer(uuid, uuid) FROM PUBLIC, anon;
  END IF;

  -- 22. propose_org_owner_transfer(uuid, uuid)
  IF to_regprocedure('public.propose_org_owner_transfer(uuid, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.propose_org_owner_transfer(uuid, uuid) FROM PUBLIC, anon;
  END IF;

  -- 23. remove_family_member(uuid, uuid)
  IF to_regprocedure('public.remove_family_member(uuid, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.remove_family_member(uuid, uuid) FROM PUBLIC, anon;
  END IF;

  -- 24. remove_org_member(uuid, uuid)
  IF to_regprocedure('public.remove_org_member(uuid, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.remove_org_member(uuid, uuid) FROM PUBLIC, anon;
  END IF;

  -- 25. revoke_family_invite(uuid)
  IF to_regprocedure('public.revoke_family_invite(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.revoke_family_invite(uuid) FROM PUBLIC, anon;
  END IF;

  -- 26. revoke_org_invite(uuid)
  IF to_regprocedure('public.revoke_org_invite(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.revoke_org_invite(uuid) FROM PUBLIC, anon;
  END IF;

  -- 27. update_my_share_settings(boolean, boolean, boolean)
  IF to_regprocedure('public.update_my_share_settings(boolean, boolean, boolean)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.update_my_share_settings(boolean, boolean, boolean) FROM PUBLIC, anon;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 除外 (温存) 3 関数: anon への意図的な GRANT はそのまま維持する。
-- 下記は「触らない」ことの明示であり、実行される DDL は無い(コメントのみ)。
--   - get_invite_details(text)
--   - preview_org_invite(text)
--   - preview_family_invite(text)
-- ────────────────────────────────────────────────────────────
