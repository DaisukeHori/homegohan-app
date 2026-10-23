-- rollback: 20261016243000_auth_history_sessions.sql
-- 戻す順: 戻し口は新しい順に流す (後の 20261022190000_db_privilege_hardening.sql を先に戻す)。ここで anon / authenticated に
--   付け直す TRUNCATE (GRANT ALL に含まれる) は、190000 が public の全部の表で利用者に持たせないとしたもの。190000 の戻し口はこの表の
--   TRUNCATE を付け直さず、この戻し口が付け直す前提でできている。190000 が残ったままこの戻し口だけを流すと、RLS の効かない
--   TRUNCATE が利用者に戻る (190000 の不変条件を破る)。
-- 設計 docs/design/cross/16-auth-history-sessions.md §11.7 の写し。
-- auth.sessions / auth.users のトリガー 4 本は表の所有者 (supabase_auth_admin) でないと消せない (DROP TRIGGER も DISABLE TRIGGER も)。
-- 代わりにトリガー関数 4 本の本体を「何もしない」に置き換えて残す。写した行・トリガーが書いた行は消さない (残る列は既存のものだけ)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。

-- 1. pg_cron のジョブ (無ければ何もしない。cron.unschedule(name) は無い名前で例外になるので jobid で外す)
DO $$
DECLARE v_job record;
BEGIN
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname = 'cleanup-auth-sessions-and-login-history' ORDER BY jobid LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END $$;

-- 2. 保守の関数 3 本と RPC 4 本
DROP FUNCTION IF EXISTS public.expire_idle_auth_sessions();
DROP FUNCTION IF EXISTS public.reconcile_user_sessions_metadata();
DROP FUNCTION IF EXISTS public.cleanup_ended_user_sessions_metadata();
DROP FUNCTION IF EXISTS public.auth_session_revoke(uuid);
DROP FUNCTION IF EXISTS public.auth_password_check(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.claim_login_alerts(integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.release_login_alert(text, integer);

-- 3. user_profiles のトリガーと関数 (表の所有者は postgres なので消せる)
DROP TRIGGER IF EXISTS trg_user_profiles_fill_login_stats ON public.user_profiles;
DROP FUNCTION IF EXISTS public.user_profiles_fill_login_stats();

-- 4. auth の表のトリガー 4 本は消せない (所有者 supabase_auth_admin §3)。関数の本体を「何もしない」に置き換えて残す
--    (SECURITY DEFINER・search_path・権限 (supabase_auth_admin だけ EXECUTE) は CREATE OR REPLACE で変わらない)
CREATE OR REPLACE FUNCTION public.auth_session_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.auth_session_refreshed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.auth_session_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.password_history_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END;
$$;
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['auth_session_created', 'auth_session_refreshed', 'auth_session_deleted', 'password_history_record'] LOOP
    EXECUTE format(
      'COMMENT ON FUNCTION public.%I() IS %L', fn,
      'cross/16 のロールバックで本体を空にした (何も記録しない)。auth の表のトリガーは表の所有者 (supabase_auth_admin) でないと消せないので残る。migration をもう一度流すと本体が戻る');
  END LOOP;
END $$;

-- 5. user_profiles.last_login_at の COMMENT を baseline (20251126124224) の文に戻す
COMMENT ON COLUMN public.user_profiles.last_login_at IS '最終ログイン日時 (auth.users.last_sign_in_at を Edge Function が同期)';

-- 6. 索引・制約・列 (§11.1 で足したもの)
DROP INDEX IF EXISTS public.idx_sessions_alert_queue;
DROP INDEX IF EXISTS public.idx_sessions_ended;
ALTER TABLE public.user_sessions_metadata
  DROP CONSTRAINT IF EXISTS user_sessions_metadata_context_source_check,
  DROP CONSTRAINT IF EXISTS user_sessions_metadata_alert_status_check,
  DROP CONSTRAINT IF EXISTS user_sessions_metadata_ended_reason_check;
ALTER TABLE public.user_sessions_metadata
  DROP COLUMN IF EXISTS ip_network,
  DROP COLUMN IF EXISTS country_code,
  DROP COLUMN IF EXISTS context_source,
  DROP COLUMN IF EXISTS device_family,
  DROP COLUMN IF EXISTS is_new_device,
  DROP COLUMN IF EXISTS is_new_ip,
  DROP COLUMN IF EXISTS is_new_country,
  DROP COLUMN IF EXISTS alert_status,
  DROP COLUMN IF EXISTS alert_claimed_at,
  DROP COLUMN IF EXISTS alert_attempts,
  DROP COLUMN IF EXISTS alert_sent_at,
  DROP COLUMN IF EXISTS ended_reason;

-- 7. ポリシーと表の権限を baseline (20251126124224:10870・13031〜13032・12815〜12816) の状態に戻す
DROP POLICY IF EXISTS sessions_revoke_self ON public.user_sessions_metadata;
CREATE POLICY sessions_revoke_self ON public.user_sessions_metadata FOR UPDATE USING (user_id = auth.uid());
GRANT ALL ON TABLE public.user_sessions_metadata, public.password_history TO anon, authenticated;
