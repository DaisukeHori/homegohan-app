-- rollback: 20261017080000_operator_mfa_end_sessions.sql
-- 関数を消す。戻したあとは reset の route (段 C) がセッションの終了 (§14.7 の手順 7) で 500 になり、factor もコードも消さない
-- ので、アプリ側 (段 C) も一緒に戻す。本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。
DROP FUNCTION IF EXISTS public.operator_mfa_end_sessions(uuid);
