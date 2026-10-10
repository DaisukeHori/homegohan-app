-- rollback: 20261010160000_auth_login_failure_window.sql
-- ⚠️ 先に Web のデプロイ (この 2 つの関数を呼ぶ POST /api/auth/login) を戻してから流すこと。
--    関数が無いと POST /api/auth/login は失敗の回数を読めず、500 を返す (ログインできなくなる)。
--    消えるのは関数だけ。auth_login_failures のテーブルとデータには触れない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP FUNCTION IF EXISTS public.auth_login_count_failure(text, integer);
DROP FUNCTION IF EXISTS public.auth_login_failure_count(text, integer);
