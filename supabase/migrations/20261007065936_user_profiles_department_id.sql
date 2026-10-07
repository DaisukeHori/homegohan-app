-- migration: 20261007065936_user_profiles_department_id.sql
-- Issue #1235 (第2段): 部署の所属 (user_profiles.department_id) を追加する (設計 v2 §3 / §4、F-5〜F-8)
--
-- 背景:
--   部署 API (/api/org/departments) は存在しないテーブル organization_departments を参照しており、
--   全メソッドが 500 だった (F-5)。画面は部署ごとの所属人数 (memberCount) を表示するが、
--   部署の所属を表す列がどこにも無かった (F-7)。
--   2026-10-07 のオーナー判断で、設計 v2 どおりに直す (API の修正は src/app/api/org/departments/route.ts)。
--
-- 変更:
--   1. user_profiles.department_id (uuid) を追加する。FK は departments(id) ON DELETE SET NULL
--      (部署を消すと所属が外れる。部署の削除は所属者がいても止めない)。部分インデックスを張る。
--   2. 特権列ガード guard_user_profiles_privileged に department_id を足す。部署の所属は組織の管理者側で
--      割り当てる列で、本人の直接 UPDATE では変えられない (部署単位のチャレンジ等に影響するため)。
--      本文は本番の現行定義 (frozen_at / frozen_by / frozen_reason / unban_at の保護を含む) に 1 行足しただけ。
--      ※ 設計 v2 の全文は frozen_* の追加 (20260711100030) より前のもので、そのまま使うと保護が消えるため使わない。
--   3. 所属を外す RPC 4 本 (leave_org / remove_org_member / operator_force_dissolve_org / release_user_membership)
--      で department_id も外す。本文は 20261007064408 (roles の org_admin も外す版) に 1 行足しただけ。
--
--   部署に人を割り当てる手段 (画面・API) はまだ無いため、当面 department_id はすべて NULL (所属人数は 0)。
--
-- 冪等: ADD COLUMN IF NOT EXISTS / 制約は duplicate_object を無視 / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE。
-- ロールバック: supabase/rollbacks/20261007065936_user_profiles_department_id.down.sql

-- ---------------------------------------------------------------
-- 1. user_profiles.department_id
-- ---------------------------------------------------------------
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS department_id uuid;

DO $$ BEGIN
  ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_user_profiles_department
  ON public.user_profiles(department_id) WHERE department_id IS NOT NULL;

COMMENT ON COLUMN public.user_profiles.department_id IS
  '所属組織の部署 (departments.id)。本人は変更できない (guard_user_profiles_privileged)。脱退・除名で NULL に戻る。#1235';

-- ---------------------------------------------------------------
-- 2. 特権列ガードに department_id を足す
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.roles            IS DISTINCT FROM OLD.roles
       OR NEW.org_role         IS DISTINCT FROM OLD.org_role
       OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
       OR NEW.family_id        IS DISTINCT FROM OLD.family_id
       OR NEW.is_active_in_org IS DISTINCT FROM OLD.is_active_in_org
       OR NEW.joined_org_at    IS DISTINCT FROM OLD.joined_org_at
       OR NEW.frozen_at        IS DISTINCT FROM OLD.frozen_at
       OR NEW.frozen_by        IS DISTINCT FROM OLD.frozen_by
       OR NEW.frozen_reason    IS DISTINCT FROM OLD.frozen_reason
       OR NEW.unban_at         IS DISTINCT FROM OLD.unban_at
       OR NEW.department_id    IS DISTINCT FROM OLD.department_id THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------
-- 3. 所属を外す RPC で department_id も外す
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leave_org() RETURNS public.user_profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_user user_profiles; v_org_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_user FROM user_profiles WHERE id = auth.uid();
  IF v_user.organization_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  IF v_user.org_role = 'owner' THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_user.organization_id;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE id = auth.uid()
    RETURNING * INTO v_user;

  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', v_org_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION public.remove_org_member(p_organization_id uuid, p_user_id uuid) RETURNS public.user_profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller_role org_role_enum;
  v_target user_profiles;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target FROM user_profiles WHERE id = p_user_id;
  IF NOT FOUND OR v_target.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'USER_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.org_role = 'owner' THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_OWNER' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.org_role = 'admin' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE id = p_user_id
    RETURNING * INTO v_target;

  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = p_organization_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', p_organization_id, 'member_removed', auth.uid(), p_user_id);

  RETURN v_target;
END $$;

CREATE OR REPLACE FUNCTION public.operator_force_dissolve_org(p_organization_id uuid, p_reason text DEFAULT NULL::text) RETURNS public.organizations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
BEGIN
  SELECT roles INTO v_caller_roles
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_roles IS NULL
     OR NOT (
       'super_admin' = ANY(v_caller_roles)
       OR 'operator' = ANY(v_caller_roles)
     ) THEN
    RAISE EXCEPTION 'OPERATOR_PERMISSION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_org FROM organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL,
        org_role = NULL,
        is_active_in_org = FALSE,
        joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE organization_id = p_organization_id;

  -- Round 3 C-4: org_license_pools の used_licenses をリセット
  UPDATE org_license_pools
    SET used_licenses = 0, updated_at = NOW()
    WHERE organization_id = p_organization_id;

  -- organizations.status を dissolved に更新 (000126 で追加したカラム)
  UPDATE organizations
    SET status = 'dissolved',
        dissolved_at = NOW(),
        updated_at = NOW()
    WHERE id = p_organization_id
    RETURNING * INTO v_org;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES (
    'organization',
    p_organization_id,
    'operator_force_dissolve',
    auth.uid(),
    NULL,
    jsonb_build_object(
      'reason', p_reason,
      'dissolved_at', NOW()
    )
  );

  RETURN v_org;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_user_membership(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_org_id UUID;
BEGIN
  SELECT organization_id INTO v_org_id FROM user_profiles WHERE id = p_user_id FOR UPDATE;

  IF v_org_id IS NOT NULL THEN
    -- 対象を無効化してからカウントを減らす (leave_org と同じ冪等パターン)。
    -- WHERE organization_id = v_org_id が不成立 (=既に無効化済み) なら
    -- 0行 UPDATE となり、以降の decrement/監査ログもスキップされる。
    UPDATE user_profiles
      SET organization_id = NULL, org_role = NULL,
          is_active_in_org = FALSE, joined_org_at = NULL,
          roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
          department_id = NULL  -- #1235: 部署の所属も外す
      WHERE id = p_user_id AND organization_id = v_org_id;

    IF FOUND THEN
      UPDATE org_license_pools
        SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
        WHERE organization_id = v_org_id;

      INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
      VALUES ('organization', v_org_id, 'member_left', p_user_id, p_user_id,
              jsonb_build_object('reason', 'account_delete'));
    END IF;
  END IF;
END $$;
