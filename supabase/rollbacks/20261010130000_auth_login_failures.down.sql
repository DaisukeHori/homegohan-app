-- rollback: 20261010130000_auth_login_failures.sql
-- ⚠️ 先に Web のデプロイ (POST /api/auth/login と、それを呼ぶログイン画面) を戻してから流すこと。
--    関数が無いと POST /api/auth/login はロックを判定できず、500 を返す (ログインできなくなる)。
--    戻すと、記録済みの失敗の回数とロックの期限は失われる (ロック中のアカウントもすぐにログインできるようになる)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP FUNCTION IF EXISTS public.auth_login_account_user_id(text);
DROP FUNCTION IF EXISTS public.auth_login_clear_failures(text);
DROP FUNCTION IF EXISTS public.auth_login_apply_lock(text, timestamptz);
DROP FUNCTION IF EXISTS public.auth_login_record_failure(text);
DROP FUNCTION IF EXISTS public.auth_login_lock_status(text);
DROP FUNCTION IF EXISTS public.auth_login_email_hash(text);
DROP TABLE IF EXISTS public.auth_login_failures;
