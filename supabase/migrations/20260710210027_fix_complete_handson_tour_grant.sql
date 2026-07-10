-- =====================================================
-- Migration: fix_complete_handson_tour_grant
-- Source: Issue #1027 [Crit] complete_handson_tour の GRANT 欠落でツアー完走不能
--
-- 不具合:
--   旧シグネチャ complete_handson_tour(p_user_id uuid) は
--   `REVOKE ... FROM anon, authenticated` + `GRANT ... TO service_role` のみで、
--   route.ts (src/app/api/handson-tour/complete/route.ts) はユーザーセッションで
--   RPC を呼ぶため permission denied → 500 (ツアー卒業不能)。
--   仮に authenticated に EXECUTE が付与されていた場合は p_user_id を任意に渡せるため、
--   他人のツアーを完了させバッジを付与できる無認証書き込み穴にもなり得ていた。
--
-- 修正方針 (兄弟関数 user_has_non_sandbox_activity / 20260510120000 と同方式):
--   - 引数を廃止し、関数内部で auth.uid() を参照して「自分のツアー」しか完了できないよう強制。
--   - SECURITY DEFINER は維持する: user_badges には自己 INSERT を許可する RLS ポリシーが
--     存在しない (SELECT ポリシーのみ) ため、SECURITY INVOKER に変更すると
--     badge 付与の INSERT が RLS に弾かれて機能が壊れる。DEFINER + auth.uid() 強制の
--     組み合わせで「安全かつ動作する」両立を取る。
--   - REVOKE EXECUTE FROM PUBLIC で暗黙付与を明示的に外し、authenticated にのみ GRANT。
--
-- round-2 修正 (2モデル敵対レビュー指摘):
--   - [Critical] badges テーブルの実列は icon であり icon_url ではない (旧関数から
--     継承していたバグ)。authenticated で RPC 実行すると
--     `ERROR: column "icon_url" does not exist` で UPDATE ごとロールバックし
--     500 症状が残存していた。SELECT 対象列を icon に修正 (JSON レスポンスの
--     キー名 icon_url は zod 契約のため維持)。
--   - [Warning] 本番は `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON FUNCTIONS TO anon` があり、CREATE 時に anon へ EXECUTE が
--     暗黙付与される。REVOKE FROM PUBLIC だけでは剥がれないため、
--     REVOKE EXECUTE ... FROM anon を明示追加。
--
-- Idempotent: yes (DROP FUNCTION IF EXISTS → CREATE OR REPLACE、REVOKE/GRANT は何度実行してもエラー0)
-- =====================================================

BEGIN;

-- 旧シグネチャ (uuid 引数版) を drop。2回目以降の実行では既に存在しないため no-op。
DROP FUNCTION IF EXISTS complete_handson_tour(uuid);

CREATE OR REPLACE FUNCTION complete_handson_tour()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_existing_completed_at timestamptz;
  v_completed_at timestamptz;
  v_was_already boolean;
  v_badge_id uuid;
  v_badge_name text;
  v_badge_icon_url text;
  v_badge_obtained_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- UPDATE 前に既存値を取得 (already_completed 判定のため)
  SELECT handson_tour_completed_at INTO v_existing_completed_at
  FROM user_profiles WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  v_was_already := (v_existing_completed_at IS NOT NULL);

  UPDATE user_profiles
  SET handson_tour_completed_at = COALESCE(handson_tour_completed_at, now())
  WHERE id = v_user_id
  RETURNING handson_tour_completed_at INTO v_completed_at;

  -- badges テーブルの列は icon (icon_url ではない。#1027 round-2 実測で判明:
  -- 旧関数から継承していた誤り。JSON レスポンスキーは icon_url を維持する
  -- (src/lib/handson-tour/schemas.ts の zod 契約に合わせる)。
  SELECT id, name, icon INTO v_badge_id, v_badge_name, v_badge_icon_url
  FROM badges WHERE code = 'tutorial_complete';

  IF v_badge_id IS NULL THEN
    RAISE EXCEPTION 'badge_not_found';
  END IF;

  INSERT INTO user_badges (user_id, badge_id, obtained_at)
  VALUES (v_user_id, v_badge_id, now())
  ON CONFLICT (user_id, badge_id) DO NOTHING;

  SELECT obtained_at INTO v_badge_obtained_at
  FROM user_badges WHERE user_id = v_user_id AND badge_id = v_badge_id;

  RETURN jsonb_build_object(
    'completed_at', v_completed_at,
    'badge_awarded', jsonb_build_object(
      'code', 'tutorial_complete',
      'name', v_badge_name,
      'obtained_at', v_badge_obtained_at,
      'icon_url', v_badge_icon_url
    ),
    'already_completed', v_was_already
  );
END;
$$;

COMMENT ON FUNCTION complete_handson_tour() IS
  'family/09 卒業処理: profile UPDATE + tutorial_complete バッジ INSERT を atomic に実行。#1027 修正: 引数を廃止し auth.uid() を内部参照 (他人のツアーを完了させる書き込み穴を防止)、authenticated に EXECUTE を明示的に GRANT (卒業不能バグを解消)。round-2: badges.icon_url→icon 列名修正、anon への default privilege 由来の暗黙 EXECUTE を明示 REVOKE。';

-- 本番は `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
-- GRANT ALL ON FUNCTIONS TO anon` が設定されているため、CREATE 時に anon へ
-- EXECUTE が暗黙付与される。REVOKE FROM PUBLIC だけではこの明示的な anon
-- 付与は剥がれない (#1027 round-2 実測で確認)。anon を named role として
-- 明示的に REVOKE することで実質的に無効化する。
REVOKE EXECUTE ON FUNCTION complete_handson_tour() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_handson_tour() FROM anon;
GRANT EXECUTE ON FUNCTION complete_handson_tour() TO authenticated;
GRANT EXECUTE ON FUNCTION complete_handson_tour() TO service_role;

COMMIT;
