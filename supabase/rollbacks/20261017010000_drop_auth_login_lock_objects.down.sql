-- rollback: 20261017010000_drop_auth_login_lock_objects.sql
-- 内容: 消した列 auth_login_failures.locked_until と関数 4 本を、最後の定義 (20261010130000_auth_login_failures.sql) のとおりに作り直す。
--   - 列は NULL (ロックなし) で戻る。消す前の値は戻らない。列の並びは表の最後になる (定義の中身は同じ)。
--   - 関数の権限も 20261010130000 と同じ (service_role だけが実行できる。anon / authenticated / PUBLIC からは外す)。
--   アプリはこれらを呼ばないので、戻してもログインの動きは変わらない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

ALTER TABLE public.auth_login_failures ADD COLUMN IF NOT EXISTS locked_until timestamptz;

COMMENT ON COLUMN public.auth_login_failures.locked_until IS
  'この時刻まではログインを断る (正しいパスワードでも)。NULL はロックなし';

CREATE OR REPLACE FUNCTION public.auth_login_lock_status(p_email text)
RETURNS TABLE (failure_count integer, locked_until timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT f.failure_count, f.locked_until
    FROM public.auth_login_failures AS f
   WHERE f.email_hash = public.auth_login_email_hash(p_email)
$$;

CREATE OR REPLACE FUNCTION public.auth_login_record_failure(p_email text)
RETURNS TABLE (failure_count integer, locked_until timestamptz)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  INSERT INTO public.auth_login_failures AS f (email_hash, failure_count, last_failed_at, updated_at)
  VALUES (public.auth_login_email_hash(p_email), 1, now(), now())
  ON CONFLICT (email_hash) DO UPDATE
    SET failure_count = f.failure_count + 1,
        last_failed_at = now(),
        updated_at = now()
  RETURNING f.failure_count, f.locked_until
$$;

CREATE OR REPLACE FUNCTION public.auth_login_apply_lock(p_email text, p_locked_until timestamptz)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.auth_login_failures AS f
     SET locked_until = GREATEST(coalesce(f.locked_until, p_locked_until), p_locked_until),
         updated_at = now()
   WHERE f.email_hash = public.auth_login_email_hash(p_email)
$$;

CREATE OR REPLACE FUNCTION public.auth_login_account_user_id(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id
    FROM auth.users AS u
   WHERE u.email = lower(btrim(coalesce(p_email, '')))
   ORDER BY u.created_at, u.id
   LIMIT 1
$$;

-- 関数の権限: service_role のみ。
REVOKE ALL ON FUNCTION public.auth_login_lock_status(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_lock_status(text) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_record_failure(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_record_failure(text) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_apply_lock(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_apply_lock(text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_account_user_id(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_account_user_id(text) TO service_role;
