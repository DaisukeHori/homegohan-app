-- rollback: 20261021100000_billing_paid_plans_iap.sql
-- billing/03 段 A の migration を戻す (設計: docs/design/billing/03-paid-plans-and-iap.md §6.8)。
-- 先に Web と Edge Function のデプロイを戻すこと (新しいコードはこの migration の表・関数を呼ぶ)。
-- ストアの契約の行 (personal_subscriptions.iap_store IS NOT NULL) があれば列ごと消えるので、本番に行が無いことを確かめてから流す。
-- 置き換えた関数は、それぞれの土台の migration の定義に逐語で戻す。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として supabase/migrations に追加し、PR → main マージ → CI で適用する。

SET LOCAL lock_timeout = '10s';

-- (a) 家族の門のトリガーと関数
DROP TRIGGER IF EXISTS family_members_billing_plan_gate ON public.family_members;
DROP FUNCTION IF EXISTS public.family_members_billing_plan_gate();

-- (b) create_family_group を 20261017030000_parental_consent_and_birth_date.sql の定義に戻す (逐語)
CREATE OR REPLACE FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text" DEFAULT 'free'::"text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_group family_groups;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  -- #1173 18 歳未満の本人 (生年月日の分かる人) は、昇格 (accept_child_promotion) 以外で家族に入らず、家族の代表者・組織のオーナーを引き受けない
  -- (保護者の同意とのつながりが切れたときの出口 = 退会を、代表者・オーナーの 409 で塞がない。設計書 cross/14 §6.4 の 12)
  IF public.caller_is_minor_jst() THEN
    RAISE EXCEPTION 'MINOR_ACCOUNT_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_groups (name, representative_id, plan_key)
  VALUES (p_name, auth.uid(), p_plan_key)
  RETURNING * INTO v_group;

  INSERT INTO family_members (family_id, user_id, role, display_name)
  VALUES (v_group.id, auth.uid(), 'representative',
          -- #1678: 仮置きの 'Guest'・空白だけの名前は写さない (NULL)。名前は前後の空白を除いて写す
          (SELECT public.normalize_profile_name(nickname) FROM user_profiles WHERE id = auth.uid()));

  UPDATE user_profiles SET family_id = v_group.id WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_group.id, 'group_created', auth.uid(), auth.uid());

  RETURN v_group;
END $$;

DROP FUNCTION IF EXISTS public.billing_has_live_family_plan(uuid);

-- (c) 手動付与の 2 関数とプロシージャを 20261017230000_billing_manual_plan_grant.sql の定義に戻す (逐語)
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

-- (d) consume_ai_usage_at を 20261011030000_ai_usage_unmetered_caps_and_grants.sql、consume_ai_usage_capped_at を 20261014100000_ai_usage_feature_daily_cap.sql の定義に戻す (逐語)
CREATE OR REPLACE FUNCTION public.consume_ai_usage_at(
  p_user_id UUID,
  p_feature TEXT,
  p_at      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 上限に数えない機能 (画面を開く・保存するだけで呼ばれる AI)。supabase/functions/_shared/ai-usage-core.ts の AI_UNMETERED_FEATURES と同じ
  c_unmetered    CONSTANT TEXT[] := ARRAY['nutrition_advice_auto', 'meal_image_auto'];
  -- 行の無いプランが使う既定のプラン
  c_default_plan CONSTANT TEXT   := 'free';
  -- ai_unmetered_daily_caps に行が無い機能の安全弁 (_shared/ai-usage-core.ts の AI_UNMETERED_DAILY_CAP_FALLBACK と同じ。
  -- 既定の値のうち小さいほう。行が消されても無制限にしない)
  c_unmetered_fallback_cap CONSTANT INTEGER := 20;
  v_date  DATE;
  v_plan  TEXT;
  v_limit INTEGER;
  v_used  INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'consume_ai_usage: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NULL OR p_feature !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'consume_ai_usage: p_feature must be snake_case (up to 64 chars)' USING ERRCODE = '22023';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'consume_ai_usage: p_at is required' USING ERRCODE = '22023';
  END IF;

  -- 日付は JST の暦日 (record_ai_usage_at と同じ)
  v_date := (p_at AT TIME ZONE 'Asia/Tokyo')::DATE;

  -- 同じ利用者・同じ日の判定を 1 本ずつにする (トランザクションの終わりで外れる)。上限に数えない機能も同じ鍵で待つ
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ai_usage:' || p_user_id::TEXT || ':' || v_date::TEXT, 0)
  );

  -- 上限に数えない機能: 明示の上限 (ai_daily_limits) には数えず、その機能だけの安全弁 (ai_unmetered_daily_caps) で止める
  IF p_feature = ANY (c_unmetered) THEN
    SELECT cap.daily_cap INTO v_limit FROM public.ai_unmetered_daily_caps AS cap WHERE cap.feature = p_feature;
    IF NOT FOUND THEN
      v_limit := c_unmetered_fallback_cap;
    END IF;

    -- その日の、その機能だけの回数 (ロックを取ったあとなので、前の呼び出しの確定した結果まで読む)
    SELECT COALESCE(SUM(c.count), 0)::INTEGER
      INTO v_used
      FROM public.ai_usage_counters AS c
     WHERE c.user_id = p_user_id
       AND c.usage_date = v_date
       AND c.feature = p_feature;

    IF v_used >= v_limit THEN
      -- 安全弁に達している: 記録せずに止める
      RETURN pg_catalog.jsonb_build_object(
        'allowed', false, 'metered', false, 'plan', NULL, 'limit', v_limit, 'used', v_used, 'usage_date', v_date
      );
    END IF;

    PERFORM public.record_ai_usage_at(p_user_id, p_feature, p_at);
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true, 'metered', false, 'plan', NULL, 'limit', NULL, 'used', NULL, 'usage_date', v_date
    );
  END IF;

  v_plan := public.get_effective_plan(p_user_id);

  -- そのプランの行。無ければ 'free' の行 (それも無ければ NULL = 無制限)
  SELECT l.daily_limit INTO v_limit FROM public.ai_daily_limits AS l WHERE l.plan_key = v_plan;
  IF NOT FOUND THEN
    SELECT l.daily_limit INTO v_limit FROM public.ai_daily_limits AS l WHERE l.plan_key = c_default_plan;
  END IF;

  -- その日の回数 (上限に数える機能の合計)。ロックを取ったあとなので、前の呼び出しの確定した結果まで読む
  SELECT COALESCE(SUM(c.count), 0)::INTEGER
    INTO v_used
    FROM public.ai_usage_counters AS c
   WHERE c.user_id = p_user_id
     AND c.usage_date = v_date
     AND NOT (c.feature = ANY (c_unmetered));

  IF v_limit IS NOT NULL AND v_used >= v_limit THEN
    -- 上限に達している: 記録せずに止める
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'metered', true, 'plan', v_plan, 'limit', v_limit, 'used', v_used, 'usage_date', v_date
    );
  END IF;

  INSERT INTO public.ai_usage_counters AS c (user_id, usage_date, feature, count)
  VALUES (p_user_id, v_date, p_feature, 1)
  ON CONFLICT (user_id, usage_date, feature)
  DO UPDATE SET count = c.count + 1, updated_at = pg_catalog.now();

  RETURN pg_catalog.jsonb_build_object(
    'allowed', true, 'metered', true, 'plan', v_plan, 'limit', v_limit, 'used', v_used + 1, 'usage_date', v_date
  );
END
$$;

REVOKE ALL ON FUNCTION public.consume_ai_usage_at(UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.consume_ai_usage_at(UUID, TEXT, TIMESTAMPTZ) IS
  '#1149: consume_ai_usage の本体。利用した時刻 (p_at) を引数で受け取る (JST の日付の変わり目をテストで確かめるため)。上限に数えない機能は ai_unmetered_daily_caps の安全弁で止める。API (PostgREST) からは呼べない。consume_ai_usage を使うこと。';

CREATE OR REPLACE FUNCTION public.consume_ai_usage_capped_at(
  p_user_id           UUID,
  p_feature           TEXT,
  p_feature_daily_cap INTEGER,
  p_at                TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_date DATE;
  v_used INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'consume_ai_usage_capped: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NULL OR p_feature !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'consume_ai_usage_capped: p_feature must be snake_case (up to 64 chars)' USING ERRCODE = '22023';
  END IF;
  IF p_feature_daily_cap IS NULL OR p_feature_daily_cap < 0 THEN
    RAISE EXCEPTION 'consume_ai_usage_capped: p_feature_daily_cap must be 0 or more' USING ERRCODE = '22023';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'consume_ai_usage_capped: p_at is required' USING ERRCODE = '22023';
  END IF;

  -- 日付は JST の暦日 (consume_ai_usage_at と同じ)
  v_date := (p_at AT TIME ZONE 'Asia/Tokyo')::DATE;

  -- consume_ai_usage_at と同じ鍵で、同じ利用者・同じ日の判定を 1 本ずつにする (トランザクションの終わりで外れる)。
  -- consume_ai_usage_at の中でもう一度取るが、同じセッションは重ねて取れる
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ai_usage:' || p_user_id::TEXT || ':' || v_date::TEXT, 0)
  );

  -- その日の、その機能だけの回数 (ロックを取ったあとなので、前の呼び出しの確定した結果まで読む)
  SELECT COALESCE(SUM(c.count), 0)::INTEGER
    INTO v_used
    FROM public.ai_usage_counters AS c
   WHERE c.user_id = p_user_id
     AND c.usage_date = v_date
     AND c.feature = p_feature;

  IF v_used >= p_feature_daily_cap THEN
    -- 機能ごとの上限に達している: 記録せずに止める (1 日の上限の回数は減らさない)
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'metered', true, 'plan', NULL, 'limit', p_feature_daily_cap, 'used', v_used,
      'usage_date', v_date, 'capped_feature', p_feature
    );
  END IF;

  -- 1 日の上限の判定と記録 (上限に数える機能の合計。達していれば記録せずに止める)
  RETURN public.consume_ai_usage_at(p_user_id, p_feature, p_at);
END
$$;

REVOKE ALL ON FUNCTION public.consume_ai_usage_capped_at(UUID, TEXT, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.consume_ai_usage_capped_at(UUID, TEXT, INTEGER, TIMESTAMPTZ) IS
  '#1142: consume_ai_usage_capped の本体。利用した時刻 (p_at) を引数で受け取る (JST の日付の変わり目をテストで確かめるため)。API (PostgREST) からは呼べない。consume_ai_usage_capped を使うこと。';

-- (e) AI のプラン × 機能の上限と 1 日の上限の行
DROP FUNCTION IF EXISTS public.ai_plan_feature_daily_cap(uuid, text);
DROP TABLE IF EXISTS public.ai_plan_feature_caps;
UPDATE public.ai_daily_limits SET daily_limit = 10, updated_at = now() WHERE plan_key = 'free';
DELETE FROM public.ai_daily_limits WHERE plan_key IN ('pro', 'family_basic', 'family_pro');
-- (5a) が足した組織の plan の行 (同じ選び方。運営が画面で変えていない = updated_by IS NULL の行だけ)。消えると free の 10 で判定される
DELETE FROM public.ai_daily_limits AS l
 WHERE l.updated_by IS NULL
   AND l.plan_key NOT IN ('free', 'pro', 'family_basic', 'family_pro')
   AND l.plan_key IN (
    SELECT o.plan AS plan_key FROM public.organizations AS o WHERE o.plan IS NOT NULL AND btrim(o.plan) <> ''
    UNION
    SELECT 'standard' AS plan_key
    UNION
    SELECT p.plan_key FROM public.subscription_plans AS p WHERE p.plan_type = 'org'
   );

-- (f) ストアの契約の写像と RevenueCat のイベントの claim / finish
DROP FUNCTION IF EXISTS public.billing_apply_store_subscription(jsonb, timestamptz, text);
DROP FUNCTION IF EXISTS public.billing_claim_revenuecat_event(text, text, jsonb, interval);
DROP FUNCTION IF EXISTS public.billing_finish_revenuecat_event(text, boolean, text);

-- (g) personal_subscriptions のストアの列・制約・索引
DROP INDEX IF EXISTS public.idx_personal_subscriptions_iap_product;
ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_iap_pair_check;
ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_iap_store_check;
ALTER TABLE public.personal_subscriptions
  DROP COLUMN IF EXISTS iap_store,
  DROP COLUMN IF EXISTS iap_product_id,
  DROP COLUMN IF EXISTS iap_synced_at,
  DROP COLUMN IF EXISTS iap_is_sandbox;

-- (h) 新設の表
DROP TABLE IF EXISTS public.revenuecat_webhook_events;
DROP TABLE IF EXISTS public.plan_store_products;

-- (i) subscription_plans の 3 行を旧い値に戻す (trial_days は旧い値も 7)
UPDATE public.subscription_plans
   SET monthly_price_jpy = 980,  yearly_price_jpy = 9800,  display_name = 'Pro',          updated_at = now()
 WHERE plan_key = 'pro';
UPDATE public.subscription_plans
   SET monthly_price_jpy = 1480, yearly_price_jpy = 14800, display_name = 'Family Basic', updated_at = now()
 WHERE plan_key = 'family_basic';
UPDATE public.subscription_plans
   SET monthly_price_jpy = 2480, yearly_price_jpy = 24800, display_name = 'Family Pro',   updated_at = now()
 WHERE plan_key = 'family_pro';
