-- =====================================================
-- Migration: handson_tour
-- Source: docs/design/operator/01-data-model.md §3.26
-- Phase: family/09 Phase 1-A
-- Idempotent: yes (IF NOT EXISTS / ON CONFLICT)
--
-- Schema correction (2026-05-08):
--   - user_profiles の PK は `id` (auth.users(id) 参照) で `user_id` 列は存在しない
--   - 設計書 §3.26 が `meal_logs` / `weekly_menus` と記述していたが、実テーブル名は
--     `meals` / `user_daily_meals`。実体に揃える
-- =====================================================

BEGIN;

-- =========================================
-- §3.26.1 user_profiles 拡張 (handson_tour 状態)
-- =========================================

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS handson_tour_completed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS handson_tour_skipped_at   TIMESTAMPTZ NULL;

COMMENT ON COLUMN user_profiles.handson_tour_completed_at IS
  '初回ハンズオンチュートリアル完了日時 (family/09)。NULL = 未完走';
COMMENT ON COLUMN user_profiles.handson_tour_skipped_at IS
  '初回ハンズオンチュートリアル明示スキップ or auto-skip 日時 (family/09)';

-- 部分インデックス: 表示判定 (should_show) 高速化、pending な user だけ index に乗る
CREATE INDEX IF NOT EXISTS idx_user_profiles_handson_tour_pending
  ON user_profiles (id)
  WHERE handson_tour_completed_at IS NULL AND handson_tour_skipped_at IS NULL;


-- =========================================
-- §3.26.2 meals 拡張 (sandbox 識別子)
-- =========================================

ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN meals.is_sandbox IS
  'true = ハンズオンチュートリアル中の sandbox 投入 (family/09)';

-- 通常 UI のクエリ高速化(WHERE is_sandbox=false で index pruning)
CREATE INDEX IF NOT EXISTS idx_meals_user_non_sandbox
  ON meals (user_id, eaten_at DESC)
  WHERE is_sandbox = false;

-- 部分 UNIQUE: ハンズオン中の二重 INSERT 防止 (user_id, is_sandbox=true) は 1 行のみ
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_sandbox_meal
  ON meals (user_id)
  WHERE is_sandbox = true;


-- =========================================
-- §3.26.3 user_daily_meals 拡張 (sandbox 識別子)
-- =========================================

ALTER TABLE user_daily_meals
  ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN user_daily_meals.is_sandbox IS
  'true = ハンズオンチュートリアル中の sandbox 投入 (family/09)';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_sandbox_daily_meal
  ON user_daily_meals (user_id)
  WHERE is_sandbox = true;


-- =========================================
-- §3.26.4 badges seed (tutorial_complete)
-- =========================================

INSERT INTO badges (code, name, description, condition_json)
VALUES (
  'tutorial_complete',
  '使い方マスター',
  'はじめての使い方ガイドを最後まで完走',
  '{"type":"event","event":"handson_tour_completed"}'::jsonb
)
ON CONFLICT (code) DO NOTHING;


-- =========================================
-- §3.26.5 RPC: user_has_non_sandbox_activity
-- =========================================

CREATE OR REPLACE FUNCTION user_has_non_sandbox_activity(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM meals WHERE user_id = p_user_id AND is_sandbox = false LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM user_daily_meals WHERE user_id = p_user_id AND is_sandbox = false LIMIT 1
  );
END;
$$;

COMMENT ON FUNCTION user_has_non_sandbox_activity IS
  'family/09 condition C 判定: ユーザーが既に non-sandbox の食事記録 or 献立を持つか';

REVOKE EXECUTE ON FUNCTION user_has_non_sandbox_activity(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION user_has_non_sandbox_activity(uuid) TO service_role;


-- =========================================
-- §3.26.6 RPC: complete_handson_tour (atomic 卒業処理)
-- =========================================

CREATE OR REPLACE FUNCTION complete_handson_tour(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_completed_at timestamptz;
  v_completed_at timestamptz;
  v_was_already boolean;
  v_badge_id uuid;
  v_badge_name text;
  v_badge_icon_url text;
  v_badge_obtained_at timestamptz;
BEGIN
  -- UPDATE 前に既存値を取得 (already_completed 判定のため)
  -- now() はトランザクション開始時刻で固定なので、COALESCE 後の RETURNING と完全一致して
  -- 判定が壊れる。先に SELECT NULL チェックすることで防ぐ。
  SELECT handson_tour_completed_at INTO v_existing_completed_at
  FROM user_profiles WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  v_was_already := (v_existing_completed_at IS NOT NULL);

  UPDATE user_profiles
  SET handson_tour_completed_at = COALESCE(handson_tour_completed_at, now())
  WHERE id = p_user_id
  RETURNING handson_tour_completed_at INTO v_completed_at;

  SELECT id, name, icon_url INTO v_badge_id, v_badge_name, v_badge_icon_url
  FROM badges WHERE code = 'tutorial_complete';

  IF v_badge_id IS NULL THEN
    RAISE EXCEPTION 'badge_not_found';
  END IF;

  INSERT INTO user_badges (user_id, badge_id, obtained_at)
  VALUES (p_user_id, v_badge_id, now())
  ON CONFLICT (user_id, badge_id) DO NOTHING;

  SELECT obtained_at INTO v_badge_obtained_at
  FROM user_badges WHERE user_id = p_user_id AND badge_id = v_badge_id;

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

COMMENT ON FUNCTION complete_handson_tour IS
  'family/09 卒業処理: profile UPDATE + tutorial_complete バッジ INSERT を atomic に実行';

REVOKE EXECUTE ON FUNCTION complete_handson_tour(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_handson_tour(uuid) TO service_role;

COMMIT;
