-- migration: 20261017200000_billing_manual_plan_grant.sql
-- billing/02 (手動のプラン付与): 運営者が利用者に有料プランを手で付与・取り消す DB 関数と、期限を過ぎた付与を expired にする日次のジョブ。
-- 本番の personal_subscriptions は 0 行 (billing/01 §2.2 F9)。既存の行の書き換え (UPDATE / DELETE) は関数の本体の外に無い。
-- 戻し方: supabase/rollbacks/20261017200000_billing_manual_plan_grant.down.sql

SET LOCAL lock_timeout = '10s';

-- (1) 手動付与 (M 行 = stripe_subscription_id IS NULL の行を 1 行 INSERT する)。
--     p_user_id: 対象の利用者 (auth.users と user_profiles の両方にあること)。
--     p_plan_key: subscription_plans の plan_key。free でなく、plan_type が personal / family で、status が public のものだけ
--                 (private は family_addon = アドオンで、billing/01 §1 が対象外。基本のプランとして付与すると家族グループのプランがアドオンの名前に置き換わる)。
--     p_expires_at: 有効期限 (その時刻を過ぎたら日次のプロシージャ billing_expire_manual_subscriptions が expired にする)。NULL = 期限なし。now() より後であること。
--     戻り値 (jsonb): { subscription_id, user_id, plan_key, status: 'active', expires_at }。
--     ロックの順 (billing/01 §6.4 (9) の 2.・3.・10. と同じ): advisory billing-user:<uuid> → 契約の行 (FOR NO KEY UPDATE) → family_groups の行 → user_profiles の行。
--     写像 billing_apply_stripe_subscription・家族のトリガー billing_family_plan_follow_representative・apply_coupon と直列になる。
--     業務エラー (RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001', DETAIL = <補足>): BILL_UNKNOWN_USER / BILL_PLAN_NOT_GRANTABLE /
--     BILL_MANUAL_EXPIRES_AT_PAST / BILL_LIVE_ROW_CONFLICT。引数の不足は 22023。監査は呼び出し側 (route) が admin.billing.manual_grant を書く。
CREATE OR REPLACE FUNCTION public.billing_grant_manual_subscription(
  p_user_id    uuid,
  p_plan_key   text,
  p_expires_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- family_groups.member_limit の DDL の既定値 (写像 (9) の 10. と同じ値)
  c_default_member_limit CONSTANT integer := 4;
  -- family_groups_member_limit_check の上限 (1〜20)
  c_max_member_limit     CONSTANT integer := 20;
  v_plan         public.subscription_plans%ROWTYPE;
  v_other_live   uuid;
  v_row_id       uuid;
  v_member_limit integer;
BEGIN
  IF p_user_id IS NULL OR p_plan_key IS NULL OR p_plan_key = '' THEN
    RAISE EXCEPTION 'billing_grant_manual_subscription: p_user_id / p_plan_key are required' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'BILL_MANUAL_EXPIRES_AT_PAST' USING ERRCODE = 'P0001', DETAIL = p_expires_at::text;
  END IF;

  -- 1. 利用者 (退会済み・プロフィール未作成は付与できない)
  IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = p_user_id)
     OR NOT EXISTS (SELECT 1 FROM public.user_profiles AS p WHERE p.id = p_user_id) THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_USER' USING ERRCODE = 'P0001', DETAIL = p_user_id::text;
  END IF;

  -- 2. プラン (free・org・private (family_addon)・draft・deprecated は付与できない。billing/02 §8.1 isGrantablePlan と同じ条件)
  SELECT p.* INTO v_plan FROM public.subscription_plans AS p WHERE p.plan_key = p_plan_key;
  IF v_plan.id IS NULL
     OR v_plan.plan_key = 'free'
     OR v_plan.plan_type NOT IN ('personal', 'family')
     OR v_plan.status <> 'public' THEN
    RAISE EXCEPTION 'BILL_PLAN_NOT_GRANTABLE' USING ERRCODE = 'P0001', DETAIL = p_plan_key;
  END IF;

  -- 3. ロック (写像・トリガーと同じ鍵。cross/02 §6.2 の命名)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || p_user_id::text));

  -- 4. 同じ利用者の live な行 (S でも M でも) があれば衝突 (部分 UNIQUE idx_personal_subscriptions_active_per_user の違反を先に名指しする)。
  --    FOR NO KEY UPDATE で読む (写像の 3.・apply_coupon と行ロックで直列)
  SELECT s.id INTO v_other_live
    FROM public.personal_subscriptions AS s
   WHERE s.user_id = p_user_id
     AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
   ORDER BY s.created_at DESC, s.id
   LIMIT 1
   FOR NO KEY UPDATE;
  IF v_other_live IS NOT NULL THEN
    RAISE EXCEPTION 'BILL_LIVE_ROW_CONFLICT' USING ERRCODE = 'P0001', DETAIL = v_other_live::text;
  END IF;

  -- 5. INSERT (M 行)。stripe_* / billing_interval / trial_* / cancel_* / notes は既定のまま (billing/02 §4.1 の列の規則)
  INSERT INTO public.personal_subscriptions (user_id, plan_key, status, starts_at, current_period_start, current_period_end)
  VALUES (p_user_id, p_plan_key, 'active', now(), now(), p_expires_at)
  RETURNING id INTO v_row_id;

  -- 6. 家族プランなら、いまの代表者 = p_user_id の active なグループを合わせる (写像 (9) の 10. の live の側と同じ式。
  --    family_groups の UPDATE を user_profiles の UPDATE より先に流す = 家族の関数の LOCK-ORDER #1310 と同じ向き)
  IF v_plan.plan_type = 'family' THEN
    v_member_limit := LEAST(COALESCE(v_plan.max_members, c_default_member_limit), c_max_member_limit);
    UPDATE public.family_groups AS g
       SET plan_key = p_plan_key, member_limit = v_member_limit
     WHERE g.representative_id = p_user_id AND g.status = 'active'
       AND (g.plan_key IS DISTINCT FROM p_plan_key OR g.member_limit IS DISTINCT FROM v_member_limit);
  END IF;

  -- 7. 個人契約のキャッシュ (写像 (9) の 10. と同じ式。live な行は今 INSERT した 1 行だけ)
  UPDATE public.user_profiles AS p
     SET plan_key_cached = (
       SELECT s.plan_key FROM public.personal_subscriptions AS s
        WHERE s.user_id = p_user_id AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
        ORDER BY s.created_at DESC, s.id LIMIT 1)
   WHERE p.id = p_user_id;

  RETURN jsonb_build_object('subscription_id', v_row_id, 'user_id', p_user_id, 'plan_key', p_plan_key,
                            'status', 'active', 'expires_at', p_expires_at);
END
$$;
REVOKE ALL ON FUNCTION public.billing_grant_manual_subscription(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_grant_manual_subscription(uuid, text, timestamptz) TO service_role;
COMMENT ON FUNCTION public.billing_grant_manual_subscription(uuid, text, timestamptz) IS
  'billing/02 §6.2: 運営者の手動付与。stripe_subscription_id IS NULL の行を active で 1 行 INSERT し、family_groups と plan_key_cached を写像と同じ式で合わせる。service_role だけ (route は requireRole([''super_admin'']) の後に呼ぶ)';


-- (2) M 行が終わった (cancelled / expired になった) あとの写しの同期。取り消し (3) と 1 人分の期限切れ (4) が呼ぶ内部の関数。
--     家族: この行のプランを持つ、いまの代表者 = p_user_id の active なグループを、同じ利用者に同じプランの live な行が無いときだけ free / 4 に戻す
--     (写像 (9) の 10. の else と同じ式。ほかの経路 = service_role の直接の UPDATE で入ったプランは触らない)。
--     plan_key_cached: live な行から再計算 (無ければ NULL = free)。
--     呼ぶ側が advisory billing-user:<uuid> を取り、契約の行をロックしたあとで呼ぶこと (この関数は鍵を取らない)。
--     EXECUTE は誰にも付けない (所有者 postgres = SECURITY DEFINER の (3)・(4) の中からだけ呼ばれる)。
CREATE OR REPLACE FUNCTION public.billing_manual_subscription_sync_after_end(
  p_user_id  uuid,
  p_plan_key text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- family_groups.member_limit の DDL の既定値 (写像 (9) の 10. の戻しと同じ値)
  c_default_member_limit CONSTANT integer := 4;
BEGIN
  IF EXISTS (SELECT 1 FROM public.subscription_plans AS p WHERE p.plan_key = p_plan_key AND p.plan_type = 'family') THEN
    UPDATE public.family_groups AS g
       SET plan_key = 'free', member_limit = c_default_member_limit
     WHERE g.representative_id = p_user_id AND g.status = 'active' AND g.plan_key = p_plan_key
       AND NOT EXISTS (
         SELECT 1 FROM public.personal_subscriptions AS s
          WHERE s.user_id = p_user_id AND s.plan_key = p_plan_key
            AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'));
  END IF;
  UPDATE public.user_profiles AS p
     SET plan_key_cached = (
       SELECT s.plan_key FROM public.personal_subscriptions AS s
        WHERE s.user_id = p_user_id AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
        ORDER BY s.created_at DESC, s.id LIMIT 1)
   WHERE p.id = p_user_id;
END
$$;
REVOKE ALL ON FUNCTION public.billing_manual_subscription_sync_after_end(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.billing_manual_subscription_sync_after_end(uuid, text) IS
  'billing/02 §6.3: 手動付与の行が終わった (cancelled / expired) あとに family_groups (free / 4 に戻す) と plan_key_cached を写像と同じ式で合わせる内部の関数。呼び出し側が billing-user の鍵と行ロックを持つ。所有者 (postgres) だけが呼ぶ';

-- (3) 取り消し。利用者の live な M 行 (stripe_subscription_id IS NULL) を cancelled にする。S 行 (Stripe の契約) には触れない。
--     戻り値 (jsonb): { subscription_id, user_id, plan_key, status_from, status_to: 'cancelled' }。
--     業務エラー: BILL_MANUAL_ROW_NOT_FOUND (live な M 行が無い)。監査は呼び出し側 (route) が admin.billing.manual_revoke を書く。
CREATE OR REPLACE FUNCTION public.billing_revoke_manual_subscription(
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.personal_subscriptions%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'billing_revoke_manual_subscription: p_user_id is required' USING ERRCODE = '22023';
  END IF;

  -- 1. ロック (付与・写像・トリガーと同じ鍵)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || p_user_id::text));

  -- 2. live な M 行 (利用者ごとに最大 1 行。FOR NO KEY UPDATE で apply_coupon・写像と直列)
  SELECT s.* INTO v_row
    FROM public.personal_subscriptions AS s
   WHERE s.user_id = p_user_id
     AND s.stripe_subscription_id IS NULL
     AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
   ORDER BY s.created_at DESC, s.id
   LIMIT 1
   FOR NO KEY UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'BILL_MANUAL_ROW_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = p_user_id::text;
  END IF;

  -- 3. cancelled に (active_coupon_redemption_id・notes・current_period_end は触らない)
  UPDATE public.personal_subscriptions
     SET status = 'cancelled', cancelled_at = now(), cancel_at = NULL
   WHERE id = v_row.id;

  -- 4. 写しの同期 (family_groups → user_profiles の順)
  PERFORM public.billing_manual_subscription_sync_after_end(p_user_id, v_row.plan_key);

  RETURN jsonb_build_object('subscription_id', v_row.id, 'user_id', p_user_id, 'plan_key', v_row.plan_key,
                            'status_from', v_row.status, 'status_to', 'cancelled');
END
$$;
REVOKE ALL ON FUNCTION public.billing_revoke_manual_subscription(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_revoke_manual_subscription(uuid) TO service_role;
COMMENT ON FUNCTION public.billing_revoke_manual_subscription(uuid) IS
  'billing/02 §6.3: 運営者の手動付与の取り消し。利用者の live な手動付与の行 (stripe_subscription_id IS NULL) を cancelled にし、family_groups と plan_key_cached を合わせる。service_role だけ';


-- (4) 利用者 1 人分の期限切れ。期限 (current_period_end) を過ぎた live な M 行を expired にする。
--     プロシージャ (5) が利用者ごとに呼ぶ (1 回の呼び出し = 1 つのトランザクションの中で 1 人分)。service_role からも手で呼べる。
--     戻り値: expired にした行の数 (0 か 1。live な行は利用者ごとに最大 1 行 = 部分 UNIQUE idx_personal_subscriptions_active_per_user)。
--     ロックの順 (付与・取り消し・写像と同じ): advisory billing-user:<uuid> → 契約の行 (FOR NO KEY UPDATE) → family_groups の行 → user_profiles の行。
--     ほかの利用者の鍵・行は取らない (1 トランザクション 1 人。billing/02 §6.4)。
--     鍵を取ってから行を読むので、一覧を読んだあとに取り消された・写像が動いた行は読まれない (0 を返す)。
--     監査 system.billing.manual_grant_expired (actor_id NULL・target は利用者・info) を 1 行書く。S 行 (Stripe の契約) には触れない (期限は Stripe が持つ)。
CREATE OR REPLACE FUNCTION public.billing_expire_manual_subscription_for_user(
  p_user_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.personal_subscriptions%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'billing_expire_manual_subscription_for_user: p_user_id is required' USING ERRCODE = '22023';
  END IF;

  -- 1. ロック (付与・取り消し・写像・トリガーと同じ鍵)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || p_user_id::text));

  -- 2. 期限を過ぎた live な M 行 (FOR NO KEY UPDATE で apply_coupon・写像と直列)
  SELECT s.* INTO v_row
    FROM public.personal_subscriptions AS s
   WHERE s.user_id = p_user_id
     AND s.stripe_subscription_id IS NULL
     AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
     AND s.current_period_end IS NOT NULL
     AND s.current_period_end <= now()
   ORDER BY s.created_at DESC, s.id
   LIMIT 1
   FOR NO KEY UPDATE;
  IF v_row.id IS NULL THEN
    RETURN 0;
  END IF;

  -- 3. expired に (cancelled_at・active_coupon_redemption_id・notes・current_period_end は触らない)
  UPDATE public.personal_subscriptions
     SET status = 'expired'
   WHERE id = v_row.id;

  -- 4. 写しの同期 (family_groups → user_profiles の順)
  PERFORM public.billing_manual_subscription_sync_after_end(p_user_id, v_row.plan_key);

  -- 5. 監査 (system.* と actor_id NULL は SECURITY DEFINER だけが書ける。#1736)
  INSERT INTO public.admin_audit_logs (actor_id, action_type, target_id, target_type, severity, details)
  VALUES (NULL, 'system.billing.manual_grant_expired', p_user_id, 'user', 'info',
          jsonb_build_object('subscription_id', v_row.id, 'plan_key', v_row.plan_key, 'expires_at', v_row.current_period_end));
  RETURN 1;
END
$$;
REVOKE ALL ON FUNCTION public.billing_expire_manual_subscription_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_expire_manual_subscription_for_user(uuid) TO service_role;
COMMENT ON FUNCTION public.billing_expire_manual_subscription_for_user(uuid) IS
  'billing/02 §6.4: 利用者 1 人分の期限切れ。期限 (current_period_end) を過ぎた手動付与の行を expired にし、family_groups と plan_key_cached を合わせ、監査 system.billing.manual_grant_expired を書く。プロシージャ billing_expire_manual_subscriptions が利用者ごとに呼ぶ。service_role からも手で呼べる';

-- (5) 期限切れの日次の処理。期限を過ぎた live な M 行を持つ利用者を user_id の順に並べ、1 人ずつ (4) を呼んで COMMIT する。
--     1 トランザクションで扱う利用者は 1 人だけ (全員を 1 つのトランザクションにすると、前の利用者の user_profiles の行を持ったまま
--     次の利用者の family_groups の行を待ち、家族の関数・代表者の交代とデッドロックする。billing/02 §6.4)。
--     COMMIT を使うので SECURITY INVOKER (既定) で SET 句を付けない (SECURITY DEFINER / SET 句の付いたプロシージャは COMMIT できない)。
--     本体の名前は public. で修飾する。最上位の CALL だけで呼ぶ (pg_cron のジョブ expire-manual-plan-grants・結合テスト)。
--     途中の利用者で例外が出たら、そこで止まる (それまでの利用者は COMMIT 済み。残りは翌日の実行で処理する。失敗は cron.job_run_details に残る)。
--     一覧は開始時に読む (処理中に期限が来た行は翌日)。EXECUTE は誰にも付けない (所有者 postgres = pg_cron だけが呼ぶ)。
CREATE OR REPLACE PROCEDURE public.billing_expire_manual_subscriptions()
LANGUAGE plpgsql
AS $$
DECLARE
  v_target record;
BEGIN
  FOR v_target IN
    SELECT DISTINCT s.user_id
      FROM public.personal_subscriptions AS s
     WHERE s.stripe_subscription_id IS NULL
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
       AND s.current_period_end IS NOT NULL
       AND s.current_period_end <= now()
     ORDER BY s.user_id
  LOOP
    PERFORM public.billing_expire_manual_subscription_for_user(v_target.user_id);
    COMMIT;
  END LOOP;
END
$$;
REVOKE ALL ON PROCEDURE public.billing_expire_manual_subscriptions() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON PROCEDURE public.billing_expire_manual_subscriptions() IS
  'billing/02 §6.4: 期限を過ぎた手動付与の行を持つ利用者ごとに billing_expire_manual_subscription_for_user を呼んで COMMIT する (1 トランザクション 1 人)。pg_cron のジョブ expire-manual-plan-grants (毎日 00:11 JST) が CALL で呼ぶ。所有者 (postgres) だけ';

-- (6) pg_cron のジョブ。毎日 00:11 JST (15:11 UTC。pg_cron は UTC で解釈する。日本に夏時間は無い)。
--     期限は JST の暦日の終わり (翌日の 0 時) なので、日付が変わった直後に流す。00:05 の毎時のジョブ (calculate-segment-stats)・
--     00:10 / 00:12 の 5 分ごとのジョブ (requeue-stale-meal-image-jobs / process-pending-meal-image-jobs)・00:20 / 00:35 の
--     calculate-segment-stats-finalize-retry と重ならない分にする。
--     command は CALL の 1 文だけにする (ほかの文と並べると 1 つのトランザクションのブロックになり、プロシージャの COMMIT が 2D000 になる)。
--     本番の pg_cron は cron.use_background_workers = off (billing/02 F26) で、ジョブの command を接続から 1 つの問い合わせとして送る = 最上位の CALL。
--     pg_cron が無い DB (cron.job が無い) では登録を飛ばす (20261010150000 と同じ)。同じ名前のジョブがあれば外してから登録する (何度流しても 1 つ)。
DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron が無いため、ジョブ expire-manual-plan-grants の登録を飛ばします';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'expire-manual-plan-grants';
  PERFORM cron.schedule(
    'expire-manual-plan-grants',
    '11 15 * * *',
    'CALL public.billing_expire_manual_subscriptions();'
  );
END
$$;
