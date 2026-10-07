-- migration: 20261007111000_guard_user_profiles_privileged_on_insert.sql
-- user_profiles の特権列を、本人が自分の行を作る (INSERT) ときにも入れられないようにする
--
-- 背景:
--   特権列ガード guard_user_profiles_privileged (20260511000136。最新の本文は 20261007065936) は
--   BEFORE UPDATE のトリガーで、本人の UPDATE では roles / org_role / organization_id / family_id /
--   is_active_in_org / joined_org_at / frozen_at / frozen_by / frozen_reason / unban_at / department_id を
--   変えられないようにしている。
--   一方、INSERT のポリシー "Users can insert own profile" は WITH CHECK (auth.uid() = id) だけで、
--   authenticated はテーブルの全列に INSERT 権限を持つ。プロフィールの行はアプリの初期設定の保存で作られる
--   (auth.users から行を作るトリガーは無い) ため、まだ行を持っていない本人は、自分の行を作るときに
--   これらの列へ任意の値を入れられた。
--
-- 変更:
--   BEFORE INSERT のトリガーを追加し、authenticated / anon が作る行では、上の特権列が既定値のまま
--   (roles は NULL か ARRAY['user']、is_active_in_org は false、それ以外は NULL) であることを求める。
--   違反は UPDATE のガードと同じ 'CANNOT_MODIFY_PRIVILEGED_COLUMN' (SQLSTATE 42501)。
--   対象の列は UPDATE のガードと同じ。
--   - PostgREST の upsert (INSERT ... ON CONFLICT DO UPDATE) では、挿入しようとした行にこのトリガーが掛かり、
--     衝突して UPDATE になった場合は従来どおり UPDATE のガードも掛かる。
--   - アプリの保存 (/api/profile・/api/onboarding/progress・/api/onboarding/complete・モバイルの初期設定) は
--     特権列を送らないため影響しない。
--   - service_role (管理 API・バッチ) と SECURITY DEFINER の RPC (所有者 postgres) は、UPDATE のガードと同じく対象外。
--   - トリガー関数は SECURITY DEFINER にしない (current_user で呼び出し元を判定するため)。
--   既存の UPDATE のガード関数・トリガーは変更しない。
--
-- 冪等: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS → CREATE TRIGGER。
-- ロールバック: supabase/rollbacks/20261007111000_guard_user_profiles_privileged_on_insert.down.sql

CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF (NEW.roles IS NOT NULL AND NEW.roles IS DISTINCT FROM ARRAY['user']::text[])
       OR NEW.org_role         IS NOT NULL
       OR NEW.organization_id  IS NOT NULL
       OR NEW.family_id        IS NOT NULL
       OR NEW.is_active_in_org IS DISTINCT FROM false
       OR NEW.joined_org_at    IS NOT NULL
       OR NEW.frozen_at        IS NOT NULL
       OR NEW.frozen_by        IS NOT NULL
       OR NEW.frozen_reason    IS NOT NULL
       OR NEW.unban_at         IS NOT NULL
       OR NEW.department_id    IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.guard_user_profiles_privileged_on_insert() IS
  'user_profiles の特権列 (guard_user_profiles_privileged と同じ列) を、authenticated / anon が自分の行を作るときに既定値以外にさせない。';

DROP TRIGGER IF EXISTS trg_guard_user_profiles_privileged_on_insert ON public.user_profiles;
CREATE TRIGGER trg_guard_user_profiles_privileged_on_insert
  BEFORE INSERT ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_profiles_privileged_on_insert();
