-- migration: 20260710210015_family_members_share_settings_guard.sql
-- #1015 [High]: family_members の共有設定列 (share_meals/share_health/share_menu) が
-- BEFORE UPDATE トリガー guard_family_members_privileged (20260511000136, #1013/#1014/#1015
-- 対応で導入) の保護対象に含まれておらず、adult/representative が他メンバーの
-- family_members 行を直接 UPDATE (PostgREST 直叩き) すると本人の同意なく
-- share_health 等を改変できた。
--
-- 20260511000136 時点の guard_family_members_privileged は role/family_id/user_id
-- のみを pin しており、family_groups.representative_id/plan_key/member_limit の
-- 奪取・family_id 自己付替えは既に閉じられている(#1013/#1014/family_id部分の#1015)。
-- 本 migration は残る #1015 の失敗シナリオ(共有設定の他人書換え)を閉じる。
--
-- 正規フローは update_my_share_settings (SECURITY DEFINER, 20260511000133) のみで
-- あり、これは `WHERE user_id = auth.uid()` に限定して自分の行だけ更新する。
-- adult が他メンバーの共有設定を変える正規経路は存在しないため、直接 UPDATE 経路は
-- 本人 (auth.uid() = OLD.user_id) のみ許可し、それ以外の authenticated/anon による
-- share_* 列の変更は拒否する。SECURITY DEFINER 経由 (current_user = 関数所有者) と
-- service_role は従来どおりバイパスされる。

CREATE OR REPLACE FUNCTION public.guard_family_members_privileged()
RETURNS trigger LANGUAGE plpgsql AS $$
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

-- 関数を CREATE OR REPLACE しただけで既存トリガーの再作成は不要だが、
-- 万一トリガーが欠落していた場合に備え冪等に再作成しておく。
DROP TRIGGER IF EXISTS trg_guard_family_members_privileged ON public.family_members;
CREATE TRIGGER trg_guard_family_members_privileged
  BEFORE UPDATE ON public.family_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_family_members_privileged();
