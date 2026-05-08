-- =====================================================
-- Migration: handson_tour_phase4_cleanup
-- Source: docs/design/family/09 Phase 4 Q16 リスク低減策 #2 #5
-- 対象:
--   1. badges.tutorial_complete の description を審査対応表記に修正
--   2. pg_cron で sandbox 行 90 日自動削除ジョブを登録
-- Idempotent: yes (OR REPLACE / IF NOT EXISTS / ON CONFLICT DO UPDATE)
-- =====================================================

BEGIN;

-- =====================================================
-- Task 1: tutorial_complete バッジ description 更新
-- 目的: Apple/Google 審査で "sandbox 操作で実バッジ付与" と
--       誤解されないよう、学習目的を明記する
-- =====================================================

UPDATE badges
SET description = 'はじめての使い方ガイド完走 — 学習の進捗を示すゲーミフィケーション(課金・特典には連動しません)'
WHERE code = 'tutorial_complete';

-- =====================================================
-- Task 2: pg_cron 拡張有効化
-- =====================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- =====================================================
-- Task 3: sandbox 自動削除関数
--   - meals (is_sandbox=true, 90 日超) を削除
--     → meal_nutrition_estimates は meals FK ON DELETE CASCADE で連動
--   - user_daily_meals (is_sandbox=true, 90 日超) を削除
--   - 削除件数を admin_audit_logs に記録
-- SECURITY DEFINER: service_role のみ EXECUTE を許可
-- =====================================================

CREATE OR REPLACE FUNCTION cleanup_handson_tour_sandbox_rows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meals_deleted   INT;
  v_daily_deleted   INT;
BEGIN
  -- meals 削除 (meal_nutrition_estimates は CASCADE で自動削除)
  WITH d AS (
    DELETE FROM meals
    WHERE is_sandbox = true
      AND created_at < NOW() - INTERVAL '90 days'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_meals_deleted FROM d;

  -- user_daily_meals 削除
  WITH d AS (
    DELETE FROM user_daily_meals
    WHERE is_sandbox = true
      AND created_at < NOW() - INTERVAL '90 days'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_daily_deleted FROM d;

  -- 監査ログ記録 (actor_id は NULL 許容: PR #830 で NOT NULL 解除済)
  INSERT INTO admin_audit_logs (action_type, target_type, severity, details)
  VALUES (
    'handson_tour_sandbox_cleanup',
    'cron_job',
    'info',
    jsonb_build_object(
      'meals_deleted',       v_meals_deleted,
      'daily_meals_deleted', v_daily_deleted
    )
  );

  RETURN jsonb_build_object(
    'meals_deleted',       v_meals_deleted,
    'daily_meals_deleted', v_daily_deleted
  );
END;
$$;

-- 権限設定: anon / authenticated からは実行不可、service_role のみ
REVOKE EXECUTE ON FUNCTION cleanup_handson_tour_sandbox_rows() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION cleanup_handson_tour_sandbox_rows() TO service_role;

-- =====================================================
-- Task 4: pg_cron ジョブ登録
--   毎日 04:00 UTC (= JST 13:00) に実行
--   idempotent: 既存ジョブ名が衝突する場合は schedule を更新
-- =====================================================

SELECT cron.schedule(
  'handson-tour-sandbox-cleanup',   -- jobname (unique)
  '0 4 * * *',                      -- cron 式: 毎日 04:00 UTC
  'SELECT cleanup_handson_tour_sandbox_rows();'
);

-- =====================================================
-- COMMENT ON
-- =====================================================

COMMENT ON FUNCTION cleanup_handson_tour_sandbox_rows() IS
  'handson tour の sandbox 行 (is_sandbox=true, 90 日超) を meals / user_daily_meals から削除し、削除件数を admin_audit_logs に記録する。pg_cron により毎日 04:00 UTC に実行される。';

COMMIT;

-- =====================================================
-- 実行確認クエリ (migration 適用後に手動で確認)
-- =====================================================
-- pg_cron ジョブ登録確認:
--   SELECT * FROM cron.job WHERE jobname = 'handson-tour-sandbox-cleanup';
--
-- 直近の実行履歴確認:
--   SELECT * FROM cron.job_run_details WHERE jobid = (
--     SELECT jobid FROM cron.job WHERE jobname = 'handson-tour-sandbox-cleanup'
--   ) ORDER BY start_time DESC LIMIT 10;
--
-- 監査ログ確認:
--   SELECT * FROM admin_audit_logs
--   WHERE action_type = 'handson_tour_sandbox_cleanup'
--   ORDER BY created_at DESC LIMIT 10;
