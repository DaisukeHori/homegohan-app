-- migration: 20261022120000_billing_iap_reconcile.sql
-- billing/04 (Issue #1912 の配線の残りの冊): ストアの購読の定期の取り直しの候補を読む関数と、試した時刻の印の表と、印を書く関数と、索引。
-- 候補 = live (trialing / active / past_due) なストアの行 (iap_store IS NOT NULL) のうち、期限 (current_period_end) を過ぎていて、
--        期限の後の姿をまだ取り直していない (iap_synced_at が NULL か期限より前) か、取り直しても live のまま p_recheck_after より古いもの。
-- 利用者ごとに 1 行 (取り直しは利用者単位。billing/03 §8.4 syncStoreSubscriber)。順番は最後に試した時刻 (無ければ先頭) の古い順 → 期限の早い順、p_limit 件。
-- 候補を読む関数は何も書かない。印 (attempted_at) は、その回に実際に取り直しを試した利用者だけに、回の終わりに印を書く関数で書く
-- (取り直せない利用者が毎回先頭に来て後ろを止めないため。選んだのに試さなかった利用者は印が進まず、次の回で先に選ばれる)。
-- personal_subscriptions には書かない (写しの入口は billing_apply_store_subscription の 1 つだけ。billing/03 §6.4)。
-- 呼ぶのは GET /api/cron/iap-reconcile (service_role) だけ。
SET LOCAL lock_timeout = '10s';

-- (1) 取り直しを試した時刻の印 (利用者ごとに 1 行。候補の順番を回すためだけに使い、権利の判定は読まない)
CREATE TABLE IF NOT EXISTS public.iap_reconcile_attempts (
  user_id      uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL
);
COMMENT ON TABLE public.iap_reconcile_attempts IS
  'billing/04 §6.2: ストアの購読の定期の取り直しで、利用者に最後に取り直しを試した時刻 (候補の順番を回す印)。書くのは billing_iap_reconcile_mark_attempted だけ。service_role は読むだけ';
ALTER TABLE public.iap_reconcile_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iap_reconcile_attempts_no_access ON public.iap_reconcile_attempts;
CREATE POLICY iap_reconcile_attempts_no_access ON public.iap_reconcile_attempts USING (false) WITH CHECK (false);
REVOKE ALL ON public.iap_reconcile_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.iap_reconcile_attempts TO service_role;

-- (2) 候補を選ぶ部分索引 (live なストアの行だけ。期限の順に読む)
CREATE INDEX IF NOT EXISTS idx_personal_subscriptions_iap_reconcile
  ON public.personal_subscriptions (current_period_end)
  WHERE iap_store IS NOT NULL AND status IN ('trialing', 'active', 'past_due');
COMMENT ON INDEX public.idx_personal_subscriptions_iap_reconcile IS
  'billing/04 §6.2: 定期の取り直しの候補 (live なストアの行を current_period_end の順に読む)';

-- (3) 候補を読む関数。何も書かないので STABLE。SECURITY DEFINER で service_role だけが呼ぶ
CREATE OR REPLACE FUNCTION public.billing_iap_reconcile_candidates(
  p_now           timestamptz,
  p_recheck_after interval,
  p_limit         integer
) RETURNS TABLE (user_id uuid, period_end timestamptz, synced_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  -- 1 回の呼び出しで扱う利用者の数の安全の上限 (誤った引数で大量の行を返さない)。TS の IAP_RECONCILE_BATCH_SIZE_MAX (40。billing/04 §8.1) はこれ以下
  -- (tests/billing-iap-reconcile-core.test.ts のテスト 10 が migration の文面を読んで見る。段 B)
  c_max_users CONSTANT integer := 200;
BEGIN
  IF p_now IS NULL OR p_recheck_after IS NULL OR p_limit IS NULL THEN
    RAISE EXCEPTION 'billing_iap_reconcile_candidates: p_now / p_recheck_after / p_limit are required' USING ERRCODE = '22023';
  END IF;
  IF p_recheck_after <= interval '0' THEN
    RAISE EXCEPTION 'billing_iap_reconcile_candidates: p_recheck_after must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > c_max_users THEN
    RAISE EXCEPTION 'billing_iap_reconcile_candidates: p_limit must be between 1 and %', c_max_users USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT DISTINCT ON (s.user_id)
             s.user_id            AS due_user_id,
             s.current_period_end AS due_period_end,
             s.iap_synced_at      AS due_synced_at
        FROM public.personal_subscriptions AS s
       WHERE s.iap_store IS NOT NULL
         AND s.status IN ('trialing', 'active', 'past_due')
         AND s.current_period_end IS NOT NULL
         AND s.current_period_end <= p_now
         AND (s.iap_synced_at IS NULL
              OR s.iap_synced_at < s.current_period_end
              OR s.iap_synced_at <= p_now - p_recheck_after)
       ORDER BY s.user_id, s.current_period_end
    )
    SELECT d.due_user_id, d.due_period_end, d.due_synced_at
      FROM due AS d
      LEFT JOIN public.iap_reconcile_attempts AS a ON a.user_id = d.due_user_id
     ORDER BY a.attempted_at ASC NULLS FIRST, d.due_period_end, d.due_user_id
     LIMIT p_limit;
END
$$;
REVOKE ALL ON FUNCTION public.billing_iap_reconcile_candidates(timestamptz, interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_iap_reconcile_candidates(timestamptz, interval, integer) TO service_role;
COMMENT ON FUNCTION public.billing_iap_reconcile_candidates(timestamptz, interval, integer) IS
  'billing/04 §6.2: 定期の取り直しの候補 (期限を過ぎた live なストアの行の利用者。期限の後の姿をまだ取り直していないか、取り直しても live のまま p_recheck_after より古い)。利用者ごとに 1 行・最後に試した時刻の古い順 (無ければ先頭) → 期限の早い順・p_limit 件。何も書かない。service_role だけ';

-- (4) 印を書く関数。その回に取り直しを試した利用者の ID を、回の終わりに 1 回で渡す。SECURITY DEFINER で service_role だけが呼ぶ
CREATE OR REPLACE FUNCTION public.billing_iap_reconcile_mark_attempted(
  p_user_ids     uuid[],
  p_attempted_at timestamptz
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 1 回の呼び出しで扱う利用者の数の安全の上限 (候補を読む関数の c_max_users と同じ値。TS の IAP_RECONCILE_BATCH_SIZE_MAX はこれ以下。テスト 10)
  c_max_users CONSTANT integer := 200;
BEGIN
  IF p_user_ids IS NULL OR p_attempted_at IS NULL THEN
    RAISE EXCEPTION 'billing_iap_reconcile_mark_attempted: p_user_ids / p_attempted_at are required' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_user_ids) > c_max_users THEN
    RAISE EXCEPTION 'billing_iap_reconcile_mark_attempted: p_user_ids must have at most % ids', c_max_users USING ERRCODE = '22023';
  END IF;
  -- auth.users にある利用者だけを書く (取り直しの最中に退会した利用者は外部キーの違反にせず飛ばす。billing/04 S15)。
  -- 同じ ID が配列に 2 度あっても auth.users の 1 行で 1 回だけ書く。既にある印は新しい方の時刻を残す (2 つの回が重なったとき。S14)
  INSERT INTO public.iap_reconcile_attempts AS t (user_id, attempted_at)
  SELECT u.id, p_attempted_at
    FROM auth.users AS u
   WHERE u.id = ANY (p_user_ids)
  ON CONFLICT ON CONSTRAINT iap_reconcile_attempts_pkey
  DO UPDATE SET attempted_at = GREATEST(t.attempted_at, EXCLUDED.attempted_at);
END
$$;
REVOKE ALL ON FUNCTION public.billing_iap_reconcile_mark_attempted(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_iap_reconcile_mark_attempted(uuid[], timestamptz) TO service_role;
COMMENT ON FUNCTION public.billing_iap_reconcile_mark_attempted(uuid[], timestamptz) IS
  'billing/04 §6.2: 定期の取り直しで、その回に取り直しを試した利用者の iap_reconcile_attempts.attempted_at を p_attempted_at にする (既にある印は新しい方を残す。auth.users に無い利用者は飛ばす)。回の終わりに 1 回だけ呼ぶ。personal_subscriptions には書かない。service_role だけ';
