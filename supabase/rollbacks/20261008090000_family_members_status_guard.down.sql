-- rollback: 20261008090000_family_members_status_guard.sql
-- ガード関数 guard_family_members_privileged() を、この migration の直前の定義 (supabase/baseline/prod_schema.sql の本番の現行) へ戻す。
-- ⚠️ 戻すと #1309 の穴が復活する。ログインユーザーが PostgREST から自分の family_members.status を直接書き換えられるため、
--    退出・除名された人が status を 'active' に戻して、招待の承諾も人数の上限 (member_limit) の確認も通らずに家族へ戻れる。
--    active なメンバーが自分を 'left' にして leave_family の規則 (代表者は退出できない・プロフィールの family_id を外す・監査ログ) を迂回したり、
--    active な大人が他のメンバーを 'removed' にしたりもできる。緊急時の切り戻し専用。
-- 実行権限 (ACL) は CREATE OR REPLACE では変わらず、この migration も変えていないため、ここでは触らない。
-- データは戻さない (この migration はデータを更新していない)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

CREATE OR REPLACE FUNCTION public.guard_family_members_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.family_id IS DISTINCT FROM OLD.family_id
       OR NEW.user_id   IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;

    -- #1015: 共有設定 (share_meals/share_health/share_menu) は本人のみ直接 UPDATE 可。
    -- 子供メンバー等 (OLD.user_id IS NULL) は「本人」が存在しないため常に拒否され、
    -- 変更が必要な場合は DEFINER RPC 経由での対応が必要。
    IF auth.uid() IS DISTINCT FROM OLD.user_id THEN
      IF NEW.share_meals  IS DISTINCT FROM OLD.share_meals
         OR NEW.share_health IS DISTINCT FROM OLD.share_health
         OR NEW.share_menu   IS DISTINCT FROM OLD.share_menu THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
