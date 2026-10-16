-- migration: 20261017010000_drop_auth_login_lock_objects.sql
-- #1542: ログインのロック用の関数 4 本と列 auth_login_failures.locked_until を消す (#1165 の後始末)
--
-- 背景:
--   #1165 でログインに続けて失敗してもアカウントをロックしないことにし (docs/operations/auth-protection.md §1)、
--   20261010160000_auth_login_failure_window.sql で回数の数え方を時間で戻る関数に替えた。
--   そのとき、ロックのための関数と列は「削除は別の判断にする」として残した
--   (20261010160000 と 20261011070000_schedule_login_failure_and_grant_claim_cleanup.sql のコメント)。
--   アプリ (src・apps/mobile・packages・scripts・Edge Function) からは呼ばれていない
--   (tests/auth/no-login-lockout.test.ts が、本番のコードと DB の型の生成物にこれらの名前が無いことを確かめる)。
--   使われていない関数が DB に残ると、権限の見直しの対象が増え、どれが今の経路かが分かりにくくなる。
--
-- 変更:
--   1. 関数を消す (どれも 20261010130000_auth_login_failures.sql が作り、それ以降は定義し直していない):
--        auth_login_lock_status(text)
--        auth_login_record_failure(text)
--        auth_login_apply_lock(text, timestamptz)
--        auth_login_account_user_id(text)   (SECURITY DEFINER で auth.users を読んでいた)
--   2. 列 auth_login_failures.locked_until を消す。
--   関数を先に消す (auth_login_lock_status / auth_login_record_failure / auth_login_apply_lock の本文が列を参照しているため)。
--
-- 消す前に確かめた参照 (2026-10-16 の origin/main):
--   - 関数・トリガー・RLS ポリシー・ビュー・pg_cron のジョブ・索引で、これらの関数と列を参照するものは無い
--     (migration の全文で、4 本の関数の名前と locked_until が出てくるのは 20261010130000 の定義・権限・コメントと、
--      20261010160000 / 20261011070000 の「使わない」というコメントだけ)。
--   - 引き続き使うもの (消さない): テーブル auth_login_failures の他の列、auth_login_email_hash・auth_login_clear_failures
--     (20261010130000)、auth_login_failure_count・auth_login_count_failure (20261010160000)、
--     cleanup_stale_auth_login_failures (20261011070000。locked_until を見ない)。
--
-- 失われるもの: locked_until に残っている値。ロックをしないので、アプリは読んでいない (ログインに効かない)。
--
-- 既存の正当な利用経路への影響: なし (呼ばれていない関数と、読まれていない列の削除だけ)。
--
-- 冪等: DROP FUNCTION IF EXISTS / ALTER TABLE ... DROP COLUMN IF EXISTS。何度流しても同じ結果になる。
-- ロールバック: supabase/rollbacks/20261017010000_drop_auth_login_lock_objects.down.sql
-- 確認: tests/integration/security/auth-login-lock.test.ts (L-5)・tests/drop-auth-login-lock-objects-migration-contract.test.ts

DROP FUNCTION IF EXISTS public.auth_login_lock_status(text);
DROP FUNCTION IF EXISTS public.auth_login_record_failure(text);
DROP FUNCTION IF EXISTS public.auth_login_apply_lock(text, timestamptz);
DROP FUNCTION IF EXISTS public.auth_login_account_user_id(text);

ALTER TABLE public.auth_login_failures DROP COLUMN IF EXISTS locked_until;
