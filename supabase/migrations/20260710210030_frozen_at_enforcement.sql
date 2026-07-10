-- migration: 20260710210030_frozen_at_enforcement.sql
-- #1030 [Crit] frozen_at/BAN がアクセス制限に繋がっておらず形骸化
--
-- 修正内容:
--  1. user_profiles.unban_at 列を追加する。一時 BAN の解除予定日時は
--     従来 admin_audit_logs.details.unban_at にしか記録されず、判定時比較で
--     自動解除する仕組みが存在しなかった (永続化列が無かったため)。
--  2. guard_user_profiles_privileged() トリガー (#1013/#1014/#1015,
--     20260511000136) の保護対象列に frozen_at/frozen_by/frozen_reason/
--     unban_at を追加する。"Users can update own profile" RLS ポリシー
--     (auth.uid() = id, 列制限なし) は authenticated ロールでの直接 UPDATE を
--     許すため、このガードが無いと凍結された本人が frozen_at を自分で NULL に
--     書き換えて凍結を解除できてしまう(#1030 で新たに発見した抜け穴)。
--     service_role (freeze route / applyUserBan) と SECURITY DEFINER RPC は
--     current_user が authenticated/anon ではないため従来どおり許可される。
--  3. admin_set_user_roles(p_user_id, p_roles) から 'banned' 特例を削除する。
--     BAN は #1041 で admin/moderation ルートが frozen_at ベース
--     (applyUserBan) に統一済みのため、このRPCは
--     「super_admin のみが roles を変更できる」というシンプルな契約に戻す
--     (PR #1066 最終レビュー、Issue #1030 コメント参照)。
--
-- Idempotent: yes (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE FUNCTION)

BEGIN;

-- ─── 1. unban_at 列の追加 (一時 BAN の解除予定日時を永続化) ──────────────────────

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS unban_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN user_profiles.unban_at IS
  '一時 BAN の解除予定日時。NULL = 無期限凍結 or 凍結なし。frozen_at が NOT NULL かつ '
  'unban_at が過去の場合はアクセス判定時 (requireUser/requireRole/middleware) に '
  '自動解除扱いとする (#1030)。';

-- ─── 2. 特権列ガードトリガーに frozen 系列を追加 (#1030) ─────────────────────────
-- トリガー本体 (trg_guard_user_profiles_privileged) は 20260511000136 で
-- 作成済みのため、関数本体の CREATE OR REPLACE のみで反映される。

CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged()
RETURNS trigger LANGUAGE plpgsql AS $$
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
       OR NEW.unban_at         IS DISTINCT FROM OLD.unban_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ─── 3. admin_set_user_roles から 'banned' 特例を削除 (#1030 comment) ────────────
-- 呼び出し元は super_admin のみ(admin/users/[id]/role は既に requireRole(['super_admin'])
-- で絞っている)。'banned' 差分の特別扱いは #1041 で BAN 経路が frozen_at ベースに
-- 移行済みのため不要 (moderation ルートは applyUserBan を使い、このRPCは呼ばない)。

CREATE OR REPLACE FUNCTION public.admin_set_user_roles(p_user_id UUID, p_roles TEXT[])
RETURNS TABLE(id UUID, roles TEXT[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_roles TEXT[];
  v_new_roles TEXT[];
BEGIN
  SELECT up.roles INTO v_caller_roles FROM user_profiles up WHERE up.id = auth.uid();
  IF v_caller_roles IS NULL OR NOT (v_caller_roles && ARRAY['super_admin']) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_OWN_ROLES' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_new_roles := COALESCE(p_roles, ARRAY[]::TEXT[]);

  UPDATE user_profiles up SET roles = v_new_roles WHERE up.id = p_user_id;

  RETURN QUERY SELECT p_user_id, v_new_roles;
END $$;

REVOKE EXECUTE ON FUNCTION public.admin_set_user_roles(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_roles(UUID, TEXT[]) TO authenticated;

COMMIT;
