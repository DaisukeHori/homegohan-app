-- =====================================================
-- Rollback: handson_tour_phase4_cleanup
-- Source: docs/design/family/09 Phase 4 Q16 リスク低減策 #2 #5
-- NOTE: Supabase CLI は rollback ファイルを自動 apply しない。
--       本番ロールバック時は手動で実行する。
-- =====================================================

BEGIN;

-- =====================================================
-- pg_cron ジョブ削除
-- =====================================================

SELECT cron.unschedule('handson-tour-sandbox-cleanup');

-- =====================================================
-- cleanup 関数削除
-- =====================================================

DROP FUNCTION IF EXISTS cleanup_handson_tour_sandbox_rows();

-- =====================================================
-- tutorial_complete バッジ description を旧値に戻す
-- 注意: 旧値が不明な場合は NULL に戻すか、適切な文字列を設定すること
-- =====================================================

UPDATE badges
SET description = NULL
WHERE code = 'tutorial_complete'
  AND description = 'はじめての使い方ガイド完走 — 学習の進捗を示すゲーミフィケーション(課金・特典には連動しません)';

-- pg_cron 拡張は他のジョブが使用している可能性があるため DROP しない
-- 必要な場合は手動で: DROP EXTENSION IF EXISTS pg_cron;

COMMIT;
