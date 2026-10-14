-- rollback: 20261007052359_support_tickets_staff_insert.sql
-- ⚠️ 機能の後退: 運営 (support / admin / super_admin) が顧客の代わりにサポートチケットを起票できなくなる (#1248)。
--    運営画面の POST /api/admin/support/tickets は再び RLS で拒否され、500 DB_ERROR を返す。
--    顧客本人の起票 (tickets_insert_user) には影響しない。
--
-- 内容: 追加した tickets_insert_staff を削除し、20260508120000_operator_phase_4_5_foundation.sql の状態
--       (= 2026-10-06 時点の本番) へ戻す。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "tickets_insert_staff" ON public.support_tickets;
