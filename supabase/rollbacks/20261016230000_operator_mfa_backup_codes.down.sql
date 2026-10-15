-- rollback: 20261016230000_operator_mfa_backup_codes.sql
-- 表ごと消す (値はハッシュだけで、消えても Supabase の factor は残る。戻したあとは回復の API が 500 になるので、
-- アプリ側 (段 A) も一緒に戻す)。本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。
DROP INDEX IF EXISTS public.operator_mfa_backup_codes_user_unused_idx;
DROP TABLE IF EXISTS public.operator_mfa_backup_codes;
