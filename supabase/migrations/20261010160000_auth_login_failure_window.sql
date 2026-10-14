-- migration: 20261010160000_auth_login_failure_window.sql
-- #1165: ログイン失敗のロックをやめる。連続失敗の回数は、ボットの確認 (Turnstile) を求めるかどうかにだけ使い、時間でも 0 に戻す
--
-- 背景:
--   20261010130000_auth_login_failures.sql で、メールアドレスごとの連続失敗の回数とロックの期限を記録し、
--   5 回で 15 分・10 回で 1 時間・20 回で 24 時間のロックをかけるようにした。
--   ロックは、他人のメールアドレスで失敗を繰り返すだけで本人を締め出せてしまうため、やめる
--   (docs/operations/auth-protection.md §1)。失敗が続いたら、ボットの確認を求めるだけにする。
--   回数は、ログインに成功したときのほか、最後の失敗から一定の時間 (アプリが渡す) が経っても 0 に戻す。
--
-- 変更 (追加だけ。既存のテーブル・列・関数・データには触れない):
--   1. auth_login_failure_count(p_email, p_reset_after_minutes): いまの連続失敗の回数。
--      最後の失敗 (last_failed_at) から p_reset_after_minutes 分が経っていれば 0 (行が無いときも 0)。
--   2. auth_login_count_failure(p_email, p_reset_after_minutes): 失敗を 1 回数え、数えた後の回数を返す。
--      最後の失敗から p_reset_after_minutes 分が経っていれば 1 からやり直す。
--      INSERT ... ON CONFLICT の 1 文なので、同時に失敗しても数え漏れない。
--   どちらも p_reset_after_minutes が NULL・1 未満なら 22023 (invalid_parameter_value) で断る。
--   「経っている」の境目: 1 は「last_failed_at > now() - 間隔」なら数えたまま、2 は「last_failed_at <= now() - 間隔」なら 1 から。
--   2 つの関数で境目が食い違わないように、ちょうど補集合にしてある。
--
-- 使わなくなるもの (残す):
--   auth_login_lock_status / auth_login_record_failure / auth_login_apply_lock / auth_login_account_user_id と、
--   列 auth_login_failures.locked_until は、アプリから呼ばなくなる。削除はこの migration ではしない
--   (関数・列の削除は別の判断にする)。locked_until に値が残っていても、アプリは読まないので、ログインには効かない。
--   auth_login_email_hash (ハッシュの式) と auth_login_clear_failures (成功で行を消す) は、引き続き使う。
--
-- 設計上の判断:
--   - どちらも SECURITY INVOKER・SET search_path = ''・参照は完全修飾 (20261010130000 と同じ)。呼ぶのは service_role だけ。
--   - 新しい関数には Supabase の既定権限で anon / authenticated / service_role と PUBLIC に EXECUTE が付くので、
--     引数の型まで含めた完全形で REVOKE する (20261010130000 と同じ)。
--   - 間隔の既定値 (24 時間) と上限はアプリ (src/lib/auth/login-failures.ts) が持つ。DB は渡された間隔で判定するだけ。
--
-- 既存の正当な利用経路への影響: なし (関数の追加だけ)。
--   アプリが先に出て関数がまだ無いと、POST /api/auth/login は 500 を返す (回数を読めないときは通さない)。
--   migration は main へのマージで CI が本番へ適用するので、通常はアプリと同時に入る。
--
-- 冪等: CREATE OR REPLACE FUNCTION。REVOKE / GRANT は何度流しても同じ結果になる。
-- ロールバック: supabase/rollbacks/20261010160000_auth_login_failure_window.down.sql
-- 確認: tests/integration/security/auth-login-lock.test.ts

CREATE OR REPLACE FUNCTION public.auth_login_failure_count(p_email text, p_reset_after_minutes integer)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_reset_after_minutes IS NULL OR p_reset_after_minutes < 1 THEN
    RAISE EXCEPTION 'p_reset_after_minutes must be 1 or more' USING ERRCODE = '22023';
  END IF;

  SELECT f.failure_count
    INTO v_count
    FROM public.auth_login_failures AS f
   WHERE f.email_hash = public.auth_login_email_hash(p_email)
     AND f.last_failed_at IS NOT NULL
     AND f.last_failed_at > now() - make_interval(mins => p_reset_after_minutes);

  RETURN coalesce(v_count, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_login_count_failure(p_email text, p_reset_after_minutes integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_reset_after_minutes IS NULL OR p_reset_after_minutes < 1 THEN
    RAISE EXCEPTION 'p_reset_after_minutes must be 1 or more' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.auth_login_failures AS f (email_hash, failure_count, last_failed_at, updated_at)
  VALUES (public.auth_login_email_hash(p_email), 1, now(), now())
  ON CONFLICT (email_hash) DO UPDATE
    SET failure_count = CASE
          WHEN f.last_failed_at IS NULL
            OR f.last_failed_at <= now() - make_interval(mins => p_reset_after_minutes)
          THEN 1
          ELSE f.failure_count + 1
        END,
        last_failed_at = now(),
        updated_at = now()
  RETURNING f.failure_count INTO v_count;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.auth_login_failure_count(text, integer) IS
  'ログインの連続失敗の回数 (#1165)。最後の失敗から p_reset_after_minutes 分が経っていれば 0。ボットの確認を求めるかどうかにだけ使う (ロックはしない)';
COMMENT ON FUNCTION public.auth_login_count_failure(text, integer) IS
  'ログインの失敗を 1 回数え、数えた後の回数を返す (#1165)。最後の失敗から p_reset_after_minutes 分が経っていれば 1 からやり直す';

-- 関数の権限: service_role のみ。
REVOKE ALL ON FUNCTION public.auth_login_failure_count(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_failure_count(text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_count_failure(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_count_failure(text, integer) TO service_role;
