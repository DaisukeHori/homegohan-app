-- migration: 20260511000136_rls_guard_privileged_columns.sql
-- #1013/#1014/#1015: 特権列の直接書き換えを BEFORE UPDATE トリガーで防止。
-- DEFINER RPC(current_user=postgres) と service_role は従来どおり許可、
-- authenticated/anon の直接 UPDATE で特権列が変わった場合のみ拒否する。
--
-- 実装前確認 (実列洗い出し結果):
--   - user_profiles: roles/org_role/organization_id/family_id/is_active_in_org/joined_org_at は全て実在 (database.types.ts で確認)。
--   - organizations: owner_id (20260511000100 で ALTER 追加) 実在。
--     status (20260511000126 で ALTER 追加) も実在。status を直接 UPDATE する
--     「admin が直接 dissolve する正規UI/APIフロー」は存在せず、唯一の変更経路は
--     operator_force_dissolve_org (SECURITY DEFINER) のみと確認できたため、
--     status も pin 対象に追加する。
--   - family_groups: representative_id/plan_key/member_limit は全て実在 (20260511000110)。
--   - family_members: role/family_id/user_id は全て実在 (20260511000111)。

-- ===== #1013 user_profiles =====
CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.roles            IS DISTINCT FROM OLD.roles
       OR NEW.org_role         IS DISTINCT FROM OLD.org_role
       OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
       OR NEW.family_id        IS DISTINCT FROM OLD.family_id
       OR NEW.is_active_in_org IS DISTINCT FROM OLD.is_active_in_org
       OR NEW.joined_org_at    IS DISTINCT FROM OLD.joined_org_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_user_profiles_privileged ON public.user_profiles;
CREATE TRIGGER trg_guard_user_profiles_privileged
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_profiles_privileged();

-- ===== #1014 organizations =====
CREATE OR REPLACE FUNCTION public.guard_organizations_privileged()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.status  IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_organizations_privileged ON public.organizations;
CREATE TRIGGER trg_guard_organizations_privileged
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.guard_organizations_privileged();

-- ===== #1015 family_groups =====
CREATE OR REPLACE FUNCTION public.guard_family_groups_privileged()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.representative_id IS DISTINCT FROM OLD.representative_id
       OR NEW.plan_key     IS DISTINCT FROM OLD.plan_key
       OR NEW.member_limit IS DISTINCT FROM OLD.member_limit THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_family_groups_privileged ON public.family_groups;
CREATE TRIGGER trg_guard_family_groups_privileged
  BEFORE UPDATE ON public.family_groups
  FOR EACH ROW EXECUTE FUNCTION public.guard_family_groups_privileged();

-- ===== #1015 family_members =====
CREATE OR REPLACE FUNCTION public.guard_family_members_privileged()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.family_id IS DISTINCT FROM OLD.family_id
       OR NEW.user_id   IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_family_members_privileged ON public.family_members;
CREATE TRIGGER trg_guard_family_members_privileged
  BEFORE UPDATE ON public.family_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_family_members_privileged();

-- #1013 フォローアップ: user_profiles.roles を正規に変更するための DEFINER RPC。
-- admin/moderation の BAN・admin/users の role change ルートが直接 UPDATE していたが
-- 上記トリガーで 42501 になるため、DEFINER 経由に切り替える。
--
-- レビューで検出された権限昇格の穴(content_moderator/admin が PostgREST 直叩きで
-- 任意ユーザーを super_admin に昇格できてしまう)を防ぐため、差分ベースで制限する:
--   - super_admin 保持者のみ roles を自由に変更できる(admin/users/[id]/role の意図と一致、
--     同ルートは requireRole(['super_admin']) で既に絞っているため実質無制限のまま)。
--   - super_admin を持たない呼び出し元(admin/content_moderator)は 'banned' の付与/剥奪
--     以外の差分を一切許可しない(admin/moderation の BAN 用途のみに限定)。
-- 戻り値も user_profiles 全列(健康データ等の機微情報含む)を返さず id/roles のみに絞る。
CREATE OR REPLACE FUNCTION public.admin_set_user_roles(p_user_id UUID, p_roles TEXT[])
RETURNS TABLE(id UUID, roles TEXT[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_roles TEXT[];
  v_current_roles TEXT[];
  v_new_roles TEXT[];
  v_added TEXT[];
  v_removed TEXT[];
BEGIN
  SELECT up.roles INTO v_caller_roles FROM user_profiles up WHERE up.id = auth.uid();
  IF v_caller_roles IS NULL OR NOT (v_caller_roles && ARRAY['admin','super_admin','content_moderator']) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_OWN_ROLES' USING ERRCODE = 'P0001';
  END IF;

  SELECT up.roles INTO v_current_roles FROM user_profiles up WHERE up.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  v_current_roles := COALESCE(v_current_roles, ARRAY[]::TEXT[]);
  v_new_roles := COALESCE(p_roles, ARRAY[]::TEXT[]);

  v_added   := ARRAY(SELECT unnest(v_new_roles) EXCEPT SELECT unnest(v_current_roles));
  v_removed := ARRAY(SELECT unnest(v_current_roles) EXCEPT SELECT unnest(v_new_roles));

  IF NOT (v_caller_roles && ARRAY['super_admin']) THEN
    IF NOT (v_added <@ ARRAY['banned'] AND v_removed <@ ARRAY['banned']) THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE user_profiles up SET roles = v_new_roles WHERE up.id = p_user_id;

  RETURN QUERY SELECT p_user_id, v_new_roles;
END $$;

REVOKE EXECUTE ON FUNCTION public.admin_set_user_roles(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_roles(UUID, TEXT[]) TO authenticated;
