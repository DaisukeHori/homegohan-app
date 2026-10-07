-- migration: 20261007112200_retire_legacy_promote_child_to_user.sql
-- #1232: 子供メンバー昇格の本人同意フロー (3/3) — 旧・強制編入 RPC の廃止
-- #1243: (uuid,uuid) 旧オーバーロードが台帳上 DROP 済みのはずが本番に anon 実行可で生存
-- していたドリフトへの自己修復 (revoke → 墓標置換 → drop → 消えなければ墓標残置)。
--
-- 設計: Issue #1232 実装設計 v2 §3-3 (v3 で変更なし)。設計からの変更点:
--   - 設計時の version 20260714090200 は本番台帳 (最新 20261007094400) より古いため、新しい version で置く。
--   - (uuid, uuid) 版は 20261006192942_drop_legacy_promote_child_overload.sql で本番から削除済み
--     (#1251)。下の (B) は、再び現れても呼べない状態に戻す自己修復としてそのまま残す (冪等で無害)。

-- (A) (uuid, text): 強制編入ロジックを fail-closed 墓標へ置換
-- (戻り型 family_members は不変 = CREATE OR REPLACE 可)。
-- 正規フローは request_child_promotion → accept_child_promotion。
-- route は request_child_promotion を呼ぶよう更新済み。これは stale デプロイに対する多層防御。
CREATE OR REPLACE FUNCTION public.promote_child_to_user(p_member_id UUID, p_email TEXT)
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'PROMOTION_DIRECT_DISABLED' USING ERRCODE = 'P0001';
END $$;

-- ★#1232 v2 (G5): REVOKE は完全形。authenticated には再 GRANT する
-- (stale デプロイの旧 route が permission denied ではなく
-- PROMOTION_DIRECT_DISABLED(403) の明示エラーを受け取れるようにするため)。
REVOKE EXECUTE ON FUNCTION public.promote_child_to_user(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.promote_child_to_user(uuid, text) TO authenticated;

-- (B) (uuid, uuid) 旧版:
-- 手順1: 存在すれば全ロールの EXECUTE を剥奪 (DROP が再び無言で効かなくても呼び出し不能に)
DO $$
BEGIN
  IF to_regprocedure('public.promote_child_to_user(uuid, uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.promote_child_to_user(uuid, uuid)
      FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END $$;

-- 手順2: 本体を fail-closed 墓標へ置換 (戻り型 family_members 一致 = CREATE OR REPLACE 可)。
-- 存在しない環境では新規作成されるが、直後に REVOKE → DROP されるため無害。
CREATE OR REPLACE FUNCTION public.promote_child_to_user(p_member_id UUID, p_user_id UUID)
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'PROMOTION_DIRECT_DISABLED' USING ERRCODE = 'P0001';
END $$;

REVOKE EXECUTE ON FUNCTION public.promote_child_to_user(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- 手順3: 本命の削除。依存で失敗しても migration 全体を止めない (墓標が残れば安全)。
DO $$
BEGIN
  DROP FUNCTION IF EXISTS public.promote_child_to_user(UUID, UUID);
EXCEPTION
  WHEN dependent_objects_still_exist THEN
    RAISE WARNING '#1232: promote_child_to_user(uuid,uuid) に依存があり DROP 不可。REVOKE 済み fail-closed 墓標として残置';
END $$;
