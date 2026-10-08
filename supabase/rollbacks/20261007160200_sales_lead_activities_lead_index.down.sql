-- rollback: 20261007160200_sales_lead_activities_lead_index.sql
-- 戻すと、リードの活動履歴の取得 (リード詳細と活動履歴一覧の 2 つの API) と、リード削除時の活動の連鎖削除が、
-- また全件読み (Seq Scan + Sort) に戻る。結果や動作は変わらず、活動ログが増えたときに遅くなるだけ。
--
-- 内容: 追加した索引を消す。2026-10-07 の本番スナップショット時点の sales_lead_activities の索引は、
--   主キー (sales_lead_activities_pkey) だけだった。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP INDEX IF EXISTS "public"."idx_sales_lead_activities_lead_created";
