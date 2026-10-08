-- rollback: 20261007160300_csat_feedbacks_indexes.sql
-- 内容: 足した索引 2 本を消して、csat_feedbacks を主キーの索引だけの状態 (2026-10-07 の本番スナップショット) に戻す。
--   データ・ポリシー・権限・制約には触れない。消しても読み書きの結果は変わらず、遅くなるだけ
--   (集計 API の期間絞り込み・本人の行の検索・退会時の外部キー確認が、再び全表走査になる)。
-- 冪等: DROP INDEX IF EXISTS。2 回続けて流してもエラーにならない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP INDEX IF EXISTS "public"."idx_csat_feedbacks_created_at";
DROP INDEX IF EXISTS "public"."idx_csat_feedbacks_user_id";
