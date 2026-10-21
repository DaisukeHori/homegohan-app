-- migration: 20261021100000_billing_paid_plans_iap.sql
-- billing/03 (有料プランの販売) 段 A: 価格・ストアの商品の対応表・RevenueCat の Webhook のイベント・ストアの契約の写像・
-- AI のプラン × 機能の上限・家族プランの門・手動付与の述語 (設計: docs/design/billing/03-paid-plans-and-iap.md §6)。
-- 本番の既存の行の書き換えは (1) の subscription_plans の価格の UPDATE (3 行) と (5b) の ai_daily_limits の free の UPDATE (1 行) だけ。
-- 利用者の行 (personal_subscriptions・family_*) は書き換えない。行を消さない。
-- 冪等: ADD COLUMN IF NOT EXISTS・CREATE TABLE IF NOT EXISTS・CREATE OR REPLACE FUNCTION・DROP … IF EXISTS + CREATE・INSERT … ON CONFLICT。
-- 既存の関数の置き換えの土台 (本文を丸ごと写して差分だけを入れる):
--   consume_ai_usage_at         = 20261011030000_ai_usage_unmetered_caps_and_grants.sql
--   consume_ai_usage_capped_at  = 20261014100000_ai_usage_feature_daily_cap.sql
--   create_family_group         = 20261017030000_parental_consent_and_birth_date.sql
--   billing_revoke_manual_subscription・billing_expire_manual_subscription_for_user・PROCEDURE billing_expire_manual_subscriptions
--                               = 20261017230000_billing_manual_plan_grant.sql
-- 確認: tests/billing-paid-plans-migration-contract.test.ts・tests/integration/rls/billing-apply-store-subscription-rpc.test.ts ほか (設計 §14.2)
-- 戻し方: supabase/rollbacks/20261021100000_billing_paid_plans_iap.down.sql

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- (1) subscription_plans の価格・無料体験・表示名 (§6.2)
-- ----------------------------------------------------------------
-- (1) 価格 (billing/03 §0.4 の決定)。価格の正本は DB のこの行。公開の文の正本 PLAN_CATALOG (packages/shared/src/billing-plans.ts) と
--     tests/billing-plan-catalog.test.ts が突き合わせる。stripe_* の列は触らない (Price の登録は販売開始の合図。§17)
UPDATE public.subscription_plans
   SET monthly_price_jpy = 580,  yearly_price_jpy = 5800,  trial_days = 7, display_name = '個人 Pro',   updated_at = now()
 WHERE plan_key = 'pro';
UPDATE public.subscription_plans
   SET monthly_price_jpy = 980,  yearly_price_jpy = 9800,  trial_days = 7, display_name = '家族 Basic', max_members = 4, updated_at = now()
 WHERE plan_key = 'family_basic';
UPDATE public.subscription_plans
   SET monthly_price_jpy = 1480, yearly_price_jpy = 14800, trial_days = 7, display_name = '家族 Pro',   max_members = 8, updated_at = now()
 WHERE plan_key = 'family_pro';

-- ----------------------------------------------------------------
-- (2) plan_store_products・(3) revenuecat_webhook_events と claim / finish (§6.3)
-- ----------------------------------------------------------------
-- (2) ストアの商品と plan_key・間隔の対応 (billing/03 §4.1 の 4)。
--     product_id は RevenueCat に登録する識別子と同じ文字列 (App Store = 商品 ID、Google Play = '<subscription_id>:<base_plan_id>'。P6)。
--     主キーは (store, product_id): 同じストアの同じ商品 ID は 1 つのプランと間隔にだけ結び付く (取り直した契約の product_id → plan_key が一意)。
--     同じプランと間隔に、古い商品 ID の行 (offered = false) を残せる (購入の履歴の商品を認識し続ける。S28)。
--     offered = true の行が「そのストアで買えるか」の合図 (Web の stripe_price_id と同じ考え。R18)。売る行は (plan_key, store, billing_interval) ごとに 1 つ。
--     書くのは運営 (service_role / super_admin)。
CREATE TABLE IF NOT EXISTS public.plan_store_products (
  store             varchar(20)  NOT NULL,
  product_id        varchar(255) NOT NULL,
  plan_key          varchar(100) NOT NULL REFERENCES public.subscription_plans(plan_key) ON UPDATE CASCADE ON DELETE RESTRICT,
  billing_interval  varchar(10)  NOT NULL,
  offered           boolean      NOT NULL DEFAULT true,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT plan_store_products_pkey PRIMARY KEY (store, product_id),
  CONSTRAINT plan_store_products_store_check CHECK (store IN ('app_store', 'play_store')),
  CONSTRAINT plan_store_products_interval_check CHECK (billing_interval IN ('month', 'year')),
  CONSTRAINT plan_store_products_product_id_not_blank CHECK (btrim(product_id) <> '')
);
-- 売る商品 (offered = true) は、プラン・ストア・間隔ごとに 1 つ (アプリの購入の画面に同じプランと間隔の商品を 2 つ出さない)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_store_products_offered
  ON public.plan_store_products (plan_key, store, billing_interval) WHERE offered;
COMMENT ON TABLE public.plan_store_products IS
  'billing/03 §6.3: App Store / Google Play の商品 ID と plan_key・間隔の対応。offered = true の行のストア・間隔だけアプリの購入の画面に出る (Web の stripe_price_id と同じ合図)。offered = false の行は購入の履歴の商品を認識するために残す';
COMMENT ON COLUMN public.plan_store_products.offered IS
  'true = いま売る商品 (カタログの API が返す)。false = 売らないが、購入の履歴の商品として plan_key・間隔を引くために残す行';
DROP TRIGGER IF EXISTS plan_store_products_set_updated_at ON public.plan_store_products;
CREATE TRIGGER plan_store_products_set_updated_at
  BEFORE UPDATE ON public.plan_store_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.plan_store_products ENABLE ROW LEVEL SECURITY;
-- 読むのは公開 (未ログインのカタログの API も、公開のプランの商品 ID だけを返す。商品 ID は秘密ではない。subscription_plans_select_public と同じ条件)
DROP POLICY IF EXISTS plan_store_products_select_public ON public.plan_store_products;
CREATE POLICY plan_store_products_select_public ON public.plan_store_products
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.subscription_plans AS p
     WHERE p.plan_key = plan_store_products.plan_key AND p.status IN ('public', 'private')));
-- 書くのは super_admin だけ。subscription_plans_mutate_super_admin の最新の定義 (20261017130000_operator_mfa_db_gate.sql:420) と同じ形:
-- TO authenticated・運営ロールの条件の項に (SELECT public.operator_mfa_satisfied()) を AND で付ける (cross/12 §11.4。
-- tests/integration/security/operator-mfa-db-gate.test.ts の DB-1 が、運営ロールの条件を持つ全ポリシーにこの 2 点を求める)
DROP POLICY IF EXISTS plan_store_products_mutate_super_admin ON public.plan_store_products;
CREATE POLICY plan_store_products_mutate_super_admin ON public.plan_store_products
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE user_profiles.id = auth.uid() AND ('super_admin' = ANY (user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE user_profiles.id = auth.uid() AND ('super_admin' = ANY (user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))));
REVOKE ALL ON public.plan_store_products FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.plan_store_products TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_store_products TO service_role;
GRANT INSERT, UPDATE, DELETE ON public.plan_store_products TO authenticated;  -- RLS の mutate ポリシー (super_admin) が絞る

-- (3) RevenueCat の Webhook のイベント (冪等キー = event.id。stripe_webhook_events と同じ形・同じ状態機械)。
--     payload は最小化した写し (TS の minimizeRevenueCatEventPayload。§8.1)。subscriber_attributes・aliases などは残さない
CREATE TABLE IF NOT EXISTS public.revenuecat_webhook_events (
  id                     varchar(255) PRIMARY KEY,
  event_type             varchar(64)  NOT NULL,
  payload                jsonb        NOT NULL,
  processing_status      varchar(20)  NOT NULL DEFAULT 'processing',
  processing_started_at  timestamptz,
  attempt_count          integer      NOT NULL DEFAULT 0,
  processed_at           timestamptz,
  error_message          text,
  received_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT revenuecat_webhook_events_status_check CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed'))
);
COMMENT ON TABLE public.revenuecat_webhook_events IS
  'billing/03 §6.3: RevenueCat の Webhook のイベント (id で冪等)。payload は最小化した写し (app_user_id / product_id / store / type / event_timestamp_ms / transferred_from / transferred_to)。service_role だけが読み書きする';
ALTER TABLE public.revenuecat_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS revenuecat_webhook_events_no_access ON public.revenuecat_webhook_events;
CREATE POLICY revenuecat_webhook_events_no_access ON public.revenuecat_webhook_events USING (false) WITH CHECK (false);
REVOKE ALL ON public.revenuecat_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.revenuecat_webhook_events TO service_role;

-- (3') claim / finish (billing_claim_stripe_event / billing_finish_stripe_event と同じ本体で、表だけ違う。戻り値 'claimed' / 'completed' / 'in_progress')
CREATE OR REPLACE FUNCTION public.billing_claim_revenuecat_event(
  p_event_id    text,
  p_event_type  text,
  p_payload     jsonb,
  p_stuck_after interval DEFAULT interval '15 minutes'
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id     text;
  v_status text;
BEGIN
  IF p_event_id IS NULL OR p_event_id = '' OR p_event_type IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'billing_claim_revenuecat_event: p_event_id / p_event_type / p_payload are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.revenuecat_webhook_events (id, event_type, payload, processing_status, processing_started_at, attempt_count)
  VALUES (p_event_id, p_event_type, p_payload, 'processing', now(), 1)
  ON CONFLICT (id) DO UPDATE
     SET processing_status      = 'processing',
         processing_started_at  = now(),
         error_message          = NULL,
         attempt_count          = public.revenuecat_webhook_events.attempt_count + 1
   WHERE public.revenuecat_webhook_events.processing_status IN ('pending', 'failed')
      OR (public.revenuecat_webhook_events.processing_status = 'processing'
          AND COALESCE(public.revenuecat_webhook_events.processing_started_at, public.revenuecat_webhook_events.received_at)
              < now() - p_stuck_after)
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN 'claimed';
  END IF;
  SELECT e.processing_status INTO v_status FROM public.revenuecat_webhook_events AS e WHERE e.id = p_event_id;
  RETURN CASE WHEN v_status = 'completed' THEN 'completed' ELSE 'in_progress' END;
END
$$;
REVOKE ALL ON FUNCTION public.billing_claim_revenuecat_event(text, text, jsonb, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_revenuecat_event(text, text, jsonb, interval) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_finish_revenuecat_event(
  p_event_id text,
  p_ok       boolean,
  p_error    text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.revenuecat_webhook_events
     SET processing_status = CASE WHEN p_ok THEN 'completed' ELSE 'failed' END,
         processed_at      = CASE WHEN p_ok THEN now() ELSE processed_at END,
         error_message     = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
   WHERE id = p_event_id;
END
$$;
REVOKE ALL ON FUNCTION public.billing_finish_revenuecat_event(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_finish_revenuecat_event(text, boolean, text) TO service_role;

-- ----------------------------------------------------------------
-- (4) personal_subscriptions のストアの列と、写像 billing_apply_store_subscription (§6.4)
-- ----------------------------------------------------------------
-- (4) ストアの契約の列 (NULL 可。既存の行は書き換えない)
ALTER TABLE public.personal_subscriptions
  ADD COLUMN IF NOT EXISTS iap_store       varchar(20),
  ADD COLUMN IF NOT EXISTS iap_product_id  varchar(255),
  ADD COLUMN IF NOT EXISTS iap_synced_at   timestamptz,
  ADD COLUMN IF NOT EXISTS iap_is_sandbox  boolean NOT NULL DEFAULT false;
ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_iap_store_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_iap_store_check
  CHECK (iap_store IS NULL OR iap_store IN ('app_store', 'play_store'));
-- ストアの行は store と product_id の両方を持つ。Stripe の行とは排他
ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_iap_pair_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_iap_pair_check
  CHECK ((iap_store IS NULL AND iap_product_id IS NULL) OR (iap_store IS NOT NULL AND iap_product_id IS NOT NULL AND stripe_subscription_id IS NULL));
-- 同じ利用者・同じストア・同じ商品は 1 行 (RevenueCat の subscriptions は product_id が鍵。写像の UPDATE の鍵)
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_subscriptions_iap_product
  ON public.personal_subscriptions (user_id, iap_store, iap_product_id) WHERE iap_store IS NOT NULL;
COMMENT ON COLUMN public.personal_subscriptions.iap_store IS
  'アプリ内課金のストア (app_store / play_store)。NULL = Stripe か手動付与の行。billing/03';
COMMENT ON COLUMN public.personal_subscriptions.iap_product_id IS
  'ストアの商品 ID (RevenueCat の subscriptions の鍵。plan_store_products.product_id)。billing/03';
COMMENT ON COLUMN public.personal_subscriptions.iap_synced_at IS
  'RevenueCat から取り直した時刻 (billing_apply_store_subscription の p_fetched_at)。これより古い取り直しは適用しない (単調)。billing/03';
COMMENT ON COLUMN public.personal_subscriptions.iap_is_sandbox IS
  'ストアのテストの購入 (sandbox。App Store の審査・TestFlight・ライセンステスター) の行なら true。権利は本物の購入と同じに扱う (billing/03 Q-13)。Stripe と手動付与の行は false';
-- trial_source の値にストアを足す (CHECK があればここで置き換える。本番の DDL に trial_source の CHECK は無い (F4) ので、COMMENT だけ)
COMMENT ON COLUMN public.personal_subscriptions.trial_source IS
  '試用の出どころ: checkout (Stripe Checkout) / app_store / play_store (ストアの無料体験。billing/03) / NULL';

-- (4') ストアの契約の写像 (本冊の中心。billing_apply_stripe_subscription と同じ骨格)。
--      p_snapshot は billing/03 §8.1 の StoreSubscriptionSnapshot (TS が RevenueCat の customer info から作る)。
--      p_fetched_at は RevenueCat から取り直した時刻。既存の行の iap_synced_at がこれ以上なら何もしない (stale)。
--      p_source は 'revenuecat:<event.id>' / 'iap_sync' / 'iap_lazy_resync'。
--      戻り値 (jsonb): { applied: true, subscription_id, user_id, status_from, status_to, plan_key } /
--                      { applied: false, skipped: 'stale', subscription_id, user_id } /
--                      { applied: false, skipped: 'user_deleted' }
--      業務エラー (P0001): BILL_UNKNOWN_PLAN / BILL_UNKNOWN_IAP_STATUS / BILL_LIVE_ROW_CONFLICT。
--      (auth.users に無い利用者は BILL_UNKNOWN_USER にせず skipped: 'user_deleted' を返す。§13.3)
--      ロックの順は核と同じ: advisory billing-user:<uuid> → iap-subscription:<store>:<product> → 契約の行 → family_groups → user_profiles
CREATE OR REPLACE FUNCTION public.billing_apply_store_subscription(
  p_snapshot   jsonb,
  p_fetched_at timestamptz,
  p_source     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id        uuid := NULLIF(p_snapshot->>'user_id', '')::uuid;
  v_store          text := p_snapshot->>'iap_store';
  v_product_id     text := p_snapshot->>'iap_product_id';
  v_plan_key       text := NULLIF(p_snapshot->>'plan_key', '');
  v_status         text := p_snapshot->>'iap_status';
  v_cancel_at_end  boolean := COALESCE((p_snapshot->>'cancel_at_period_end')::boolean, false);
  v_expires_at     timestamptz := (p_snapshot->>'expires_date')::timestamptz;
  v_purchased_at   timestamptz := (p_snapshot->>'purchase_date')::timestamptz;
  v_original_at    timestamptz := (p_snapshot->>'original_purchase_date')::timestamptz;
  v_refunded_at    timestamptz := (p_snapshot->>'refunded_at')::timestamptz;
  v_is_sandbox     boolean := COALESCE((p_snapshot->>'is_sandbox')::boolean, false);
  v_existing       public.personal_subscriptions%ROWTYPE;
  v_plan           public.subscription_plans%ROWTYPE;
  v_live           boolean;
  v_row_id         uuid;
  v_status_from    text;
  v_other_live     uuid;
  v_member_limit   integer;
  -- family_groups.member_limit の DDL の既定値と CHECK の上限 (billing/01 §6.4 (9) の 10. と同じ値)
  c_default_member_limit CONSTANT integer := 4;
  c_max_member_limit     CONSTANT integer := 20;
BEGIN
  IF v_user_id IS NULL OR v_store IS NULL OR v_product_id IS NULL OR v_status IS NULL OR v_purchased_at IS NULL
     OR p_fetched_at IS NULL OR p_source IS NULL THEN
    RAISE EXCEPTION 'billing_apply_store_subscription: snapshot / p_fetched_at / p_source are required' USING ERRCODE = '22023';
  END IF;
  IF v_store NOT IN ('app_store', 'play_store') THEN
    RAISE EXCEPTION 'billing_apply_store_subscription: iap_store must be app_store or play_store' USING ERRCODE = '22023';
  END IF;
  IF v_status NOT IN ('trialing', 'active', 'past_due', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_IAP_STATUS' USING ERRCODE = 'P0001', DETAIL = v_status;
  END IF;

  -- 1. 利用者 (app_user_id = auth.users.id)。退会済みなら何も書かない (行は CASCADE で消えている)
  IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = v_user_id) THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'user_deleted');
  END IF;

  -- 2. ロック (利用者 → ストアの契約。核と同じ鍵 billing-user:<uuid> で Stripe の写像・家族のトリガーと直列)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || v_user_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('iap-subscription:' || v_store || ':' || v_product_id));

  -- 3. 既存の行と鮮度 (FOR NO KEY UPDATE で読む。核の 3. と同じ理由)
  SELECT s.* INTO v_existing FROM public.personal_subscriptions AS s
   WHERE s.user_id = v_user_id AND s.iap_store = v_store AND s.iap_product_id = v_product_id
     FOR NO KEY UPDATE;
  IF v_existing.id IS NOT NULL AND v_existing.iap_synced_at IS NOT NULL AND v_existing.iap_synced_at >= p_fetched_at THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'stale', 'subscription_id', v_existing.id, 'user_id', v_user_id);
  END IF;

  -- 4. プラン (既存の行の plan_key → snapshot の plan_key)。行の plan_key は作ったときに決まり、以後変わらない (核の 4. と同じ)
  IF v_existing.id IS NOT NULL THEN
    v_plan_key := v_existing.plan_key;
  END IF;
  IF v_plan_key IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_PLAN' USING ERRCODE = 'P0001', DETAIL = v_store || ':' || v_product_id;
  END IF;
  SELECT p.* INTO v_plan FROM public.subscription_plans AS p WHERE p.plan_key = v_plan_key;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_PLAN' USING ERRCODE = 'P0001', DETAIL = v_plan_key;
  END IF;

  v_live := v_status IN ('trialing', 'active', 'past_due');

  -- 5. 同じ利用者の別の live 行 (Stripe の契約・手動付与・別のストアの契約) があれば失敗させる (二重購読の防止。S13)。
  --    同じ App Store のグループの 2 つの live (上位への変更・体験中の変更) は、TS (billing/03 §8.1 selectStoreSubscriptions の
  --    supersededAt) が古い方を先に expired の snapshot で写してから新しい方を写すので、ここでは衝突しない (§7.3・S36)
  IF v_live THEN
    SELECT s.id INTO v_other_live
      FROM public.personal_subscriptions AS s
     WHERE s.user_id = v_user_id
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
       AND (s.iap_store IS DISTINCT FROM v_store OR s.iap_product_id IS DISTINCT FROM v_product_id)
     LIMIT 1;
    IF v_other_live IS NOT NULL THEN
      RAISE EXCEPTION 'BILL_LIVE_ROW_CONFLICT' USING ERRCODE = 'P0001', DETAIL = v_other_live::text;
    END IF;
  END IF;

  -- 6. upsert ((user_id, iap_store, iap_product_id) で 1 行。無ければ status に関わらず INSERT = 履歴の行も作る)
  IF v_existing.id IS NULL THEN
    INSERT INTO public.personal_subscriptions (
      user_id, plan_key, status, iap_store, iap_product_id, billing_interval,
      starts_at, current_period_start, current_period_end,
      trial_started_at, trial_ends_at, trial_source,
      cancel_at, cancel_at_period_end, cancelled_at, past_due_since, iap_synced_at, iap_is_sandbox
    ) VALUES (
      v_user_id, v_plan_key, v_status, v_store, v_product_id, NULLIF(p_snapshot->>'billing_interval', ''),
      COALESCE(v_original_at, v_purchased_at), v_purchased_at, v_expires_at,
      CASE WHEN v_status = 'trialing' THEN v_purchased_at ELSE NULL END,
      CASE WHEN v_status = 'trialing' THEN v_expires_at ELSE NULL END,
      CASE WHEN v_status = 'trialing' THEN v_store ELSE NULL END,
      CASE WHEN v_cancel_at_end THEN v_expires_at ELSE NULL END, v_cancel_at_end,
      CASE WHEN v_status = 'cancelled' THEN COALESCE(v_refunded_at, now()) ELSE NULL END,
      CASE WHEN v_status = 'past_due' THEN now() ELSE NULL END,
      p_fetched_at, v_is_sandbox
    ) RETURNING id INTO v_row_id;
    v_status_from := NULL;
  ELSE
    -- billing_interval: snapshot に値が無い (対応の行が無い商品・取り直しに無くなった行を終わらせる snapshot) ときは既存の値を保つ。
    -- iap_is_sandbox: snapshot の値 (TS が、取り直しに無くなった行には既存の行の値を渡す。§8.1 projectMissingSubscription)
    UPDATE public.personal_subscriptions
       SET status               = v_status,
           billing_interval     = COALESCE(NULLIF(p_snapshot->>'billing_interval', ''), billing_interval),
           current_period_start = v_purchased_at,
           current_period_end   = v_expires_at,
           trial_started_at     = COALESCE(trial_started_at, CASE WHEN v_status = 'trialing' THEN v_purchased_at ELSE NULL END),
           trial_ends_at        = COALESCE(CASE WHEN v_status = 'trialing' THEN v_expires_at ELSE NULL END, trial_ends_at),
           trial_source         = COALESCE(trial_source, CASE WHEN v_status = 'trialing' THEN v_store ELSE NULL END),
           cancel_at            = CASE WHEN v_cancel_at_end THEN v_expires_at ELSE NULL END,
           cancel_at_period_end = v_cancel_at_end,
           cancelled_at         = CASE WHEN v_status = 'cancelled' THEN COALESCE(v_refunded_at, cancelled_at, now()) ELSE NULL END,
           past_due_since       = CASE WHEN v_status = 'past_due' THEN COALESCE(past_due_since, now()) ELSE NULL END,
           iap_synced_at        = p_fetched_at,
           iap_is_sandbox       = v_is_sandbox
     WHERE id = v_existing.id;
    v_row_id := v_existing.id;
    v_status_from := v_existing.status;
  END IF;

  -- 7. 家族プランのグループへの反映と plan_key_cached (核の 10. と同じ式・同じ順: family_groups → user_profiles)
  IF v_plan.plan_type = 'family' THEN
    v_member_limit := LEAST(COALESCE(v_plan.max_members, c_default_member_limit), c_max_member_limit);
    IF v_live THEN
      UPDATE public.family_groups AS g
         SET plan_key = v_plan_key, member_limit = v_member_limit
       WHERE g.representative_id = v_user_id AND g.status = 'active'
         AND (g.plan_key IS DISTINCT FROM v_plan_key OR g.member_limit IS DISTINCT FROM v_member_limit);
    ELSE
      UPDATE public.family_groups AS g
         SET plan_key = 'free', member_limit = c_default_member_limit
       WHERE g.representative_id = v_user_id AND g.status = 'active' AND g.plan_key = v_plan_key
         AND NOT EXISTS (
           SELECT 1 FROM public.personal_subscriptions AS s
            WHERE s.user_id = v_user_id AND s.plan_key = v_plan_key
              AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'));
    END IF;
  END IF;
  UPDATE public.user_profiles AS p
     SET plan_key_cached = (
       SELECT s.plan_key FROM public.personal_subscriptions AS s
        WHERE s.user_id = v_user_id AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
        ORDER BY s.created_at DESC, s.id LIMIT 1)
   WHERE p.id = v_user_id;

  -- 8. 監査 (状態が変わったときだけ。核と同じ action_type。details に store と product_id)
  IF v_status_from IS DISTINCT FROM v_status THEN
    INSERT INTO public.admin_audit_logs (actor_id, action_type, target_id, target_type, severity, details)
    VALUES (
      NULL,
      CASE WHEN v_status_from IS NULL THEN 'system.billing.subscription_created' ELSE 'system.billing.subscription_status_changed' END,
      v_user_id, 'user',
      CASE WHEN v_status = 'past_due' THEN 'warn' ELSE 'info' END,
      jsonb_build_object('iap_store', v_store, 'iap_product_id', v_product_id, 'plan_key', v_plan_key,
                         'from', v_status_from, 'to', v_status, 'source', p_source, 'is_sandbox', v_is_sandbox)
    );
  END IF;

  RETURN jsonb_build_object('applied', true, 'subscription_id', v_row_id, 'user_id', v_user_id,
                            'status_from', v_status_from, 'status_to', v_status, 'plan_key', v_plan_key);
END
$$;
REVOKE ALL ON FUNCTION public.billing_apply_store_subscription(jsonb, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_apply_store_subscription(jsonb, timestamptz, text) TO service_role;
COMMENT ON FUNCTION public.billing_apply_store_subscription(jsonb, timestamptz, text) IS
  'billing/03 §6.4: RevenueCat から取り直したストアの契約の姿 (snapshot) を personal_subscriptions に写す唯一の入口。p_fetched_at で単調。plan_key_cached と family_groups.plan_key も同期する';

-- ----------------------------------------------------------------
-- (5) AI の線引き: ai_daily_limits の行・ai_plan_feature_caps・ai_plan_feature_daily_cap (§6.5)
-- ----------------------------------------------------------------
-- (5) 1 日の上限 (Q-2 の確定値。§0.4 の追記 3)。free は本番の行 (10) を書き換える (§0.4 の「いまの無料の範囲を絞る」)。ほかは行が無ければ足す
-- (5a) 組織の利用者の 1 日の上限は本冊では変えない (組織の課金は対象外。§0.2)。get_effective_plan は、個人の契約も家族も無い
--      組織の利用者に organizations.plan (自由な文字列。列の既定は 'standard'。本番の 2 組織も 'standard') を返し、
--      consume_ai_usage_at は行の無いプランを free の行で判定する。free を書き換える前に、組織の plan の値
--      (organizations.plan の値・列の既定・subscription_plans の plan_type = 'org' の行) に、いまの free の値を行として写す。
--      個人と家族の plan_key (free と下の 3 つ) は除く (組織が同じ値を持っていても、その行は (5b) と (5c) が決める)。既に行があれば上書きしない
INSERT INTO public.ai_daily_limits (plan_key, daily_limit)
SELECT k.plan_key, f.daily_limit
  FROM (
    SELECT o.plan AS plan_key FROM public.organizations AS o WHERE o.plan IS NOT NULL AND btrim(o.plan) <> ''
    UNION
    SELECT 'standard' AS plan_key  -- organizations.plan の列の既定 (これから作る組織も同じ上限)
    UNION
    SELECT p.plan_key FROM public.subscription_plans AS p WHERE p.plan_type = 'org'
  ) AS k
  CROSS JOIN (SELECT l.daily_limit FROM public.ai_daily_limits AS l WHERE l.plan_key = 'free') AS f
 WHERE k.plan_key NOT IN ('free', 'pro', 'family_basic', 'family_pro')
ON CONFLICT (plan_key) DO NOTHING;
-- (5b) free
UPDATE public.ai_daily_limits SET daily_limit = 3, updated_at = now() WHERE plan_key = 'free';
-- (5c) 有料の 3 プラン
INSERT INTO public.ai_daily_limits (plan_key, daily_limit) VALUES ('pro', 30), ('family_basic', 30), ('family_pro', 50)
ON CONFLICT (plan_key) DO NOTHING;

-- (5') 機能ごとの 1 日の上限 (プラン × 機能。daily_cap 0 = そのプランでは使えない・NULL = 機能ごとの上限なし)。
--      行の無い (plan, feature) は従来どおり (究極モードは呼び出し側の環境変数の既定、ほかは 1 日の上限の合計だけ)
CREATE TABLE IF NOT EXISTS public.ai_plan_feature_caps (
  plan_key   text        NOT NULL REFERENCES public.subscription_plans(plan_key) ON UPDATE CASCADE ON DELETE CASCADE,
  feature    text        NOT NULL,
  daily_cap  integer     NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT ai_plan_feature_caps_pkey PRIMARY KEY (plan_key, feature),
  -- 行を持てる機能は 4 つだけ (TS の AI_PLAN_CAPPED_FEATURES と同じ。tests/billing-paid-plans-migration-contract.test.ts が突き合わせる)。
  -- 止めたときの文 (AI_PLAN_CAPPED_FEATURE_LABELS) が無い機能に行を足させない
  CONSTRAINT ai_plan_feature_caps_feature_check CHECK (feature IN ('menu_generation_ultimate', 'menu_generation', 'image_generation', 'meal_image_auto')),
  CONSTRAINT ai_plan_feature_caps_daily_cap_nonneg CHECK (daily_cap IS NULL OR daily_cap >= 0)
);
COMMENT ON TABLE public.ai_plan_feature_caps IS
  'billing/03 §6.5: プラン × AI の機能 (ai_usage_counters.feature) の 1 日の上限。0 = そのプランでは使えない (AI の API は 403 AI_FEATURE_NOT_IN_PLAN、料理の保存の自動の料理画像は作らない)、NULL = 機能ごとの上限なし。行の無い組は従来の判定。service_role だけが読み書きする';
ALTER TABLE public.ai_plan_feature_caps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_plan_feature_caps FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_plan_feature_caps TO service_role;
-- 既定 (Q-3 の確定値。§0.4 の追記 3)。運営が変えた値は上書きしない
INSERT INTO public.ai_plan_feature_caps (plan_key, feature, daily_cap) VALUES
  ('free',         'menu_generation_ultimate', 0),
  ('free',         'image_generation',         0),
  ('free',         'meal_image_auto',          0),
  ('free',         'menu_generation',          3),
  ('pro',          'menu_generation_ultimate', 2),
  ('pro',          'menu_generation',          10),
  ('family_basic', 'menu_generation_ultimate', 2),
  ('family_basic', 'menu_generation',          10),
  ('family_pro',   'menu_generation_ultimate', 3),
  ('family_pro',   'menu_generation',          15)
ON CONFLICT (plan_key, feature) DO NOTHING;

-- (5'') 利用者のいまのプランの、機能ごとの上限の値 (数えない読み取り)。料理画像のジョブを処理する Edge Function
--       process-meal-image-jobs が、献立の作成が積んだジョブ (数えていない。F22) を AI へ送る前に、meal_image_auto の値が 0 か (そのプランでは
--       自動の料理画像を作らない) を見る (§8.8)。戻り値: 行の daily_cap (0 / 正の数 / NULL)。行が無ければ NULL (= 機能ごとの上限なし)
CREATE OR REPLACE FUNCTION public.ai_plan_feature_daily_cap(p_user_id uuid, p_feature text) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.daily_cap
    FROM public.ai_plan_feature_caps AS c
   WHERE c.plan_key = public.get_effective_plan(p_user_id) AND c.feature = p_feature
$$;
REVOKE ALL ON FUNCTION public.ai_plan_feature_daily_cap(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_plan_feature_daily_cap(uuid, text) TO service_role;
COMMENT ON FUNCTION public.ai_plan_feature_daily_cap(uuid, text) IS
  'billing/03 §6.5: 利用者のいまのプラン (get_effective_plan) の ai_plan_feature_caps の値 (行が無ければ NULL)。数えない。process-meal-image-jobs が自動の料理画像の門に使う。service_role だけ';

-- ----------------------------------------------------------------
-- (5''') consume_ai_usage_at・consume_ai_usage_capped_at の置き換え (§6.5。REVOKE / GRANT / COMMENT は既存のまま)
-- ----------------------------------------------------------------
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
  v_feature_cap  INTEGER;
  v_feature_used INTEGER;
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

  -- billing/03 §6.5: プラン × 機能の上限 (行があれば先に見る。0 = そのプランでは使えない)。
  -- 上限に数えない機能 (meal_image_auto) もここで止めるので、上限に数えない機能の枝より前に置く
  v_plan := public.get_effective_plan(p_user_id);
  SELECT c.daily_cap INTO v_feature_cap FROM public.ai_plan_feature_caps AS c WHERE c.plan_key = v_plan AND c.feature = p_feature;
  IF FOUND AND v_feature_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(c.count), 0)::INTEGER INTO v_feature_used
      FROM public.ai_usage_counters AS c
     WHERE c.user_id = p_user_id AND c.usage_date = v_date AND c.feature = p_feature;
    IF v_feature_used >= v_feature_cap THEN
      RETURN pg_catalog.jsonb_build_object(
        'allowed', false, 'metered', true, 'plan', v_plan, 'limit', v_feature_cap, 'used', v_feature_used,
        'usage_date', v_date, 'capped_feature', p_feature, 'plan_locked', (v_feature_cap = 0)
      );
    END IF;
  END IF;

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
  v_plan text;
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

  -- billing/03 §6.5: プラン × 機能の行があるプランでは、呼び出し側の環境変数の上限 (p_feature_daily_cap) を使わず、行の値で判定する (consume_ai_usage_at に任せる)
  v_plan := public.get_effective_plan(p_user_id);
  IF EXISTS (SELECT 1 FROM public.ai_plan_feature_caps AS c WHERE c.plan_key = v_plan AND c.feature = p_feature) THEN
    RETURN public.consume_ai_usage_at(p_user_id, p_feature, p_at);
  END IF;

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

-- ----------------------------------------------------------------
-- (6) 家族の門 (§6.6)
-- ----------------------------------------------------------------
-- (6) 代表者に live な家族プランの契約があるか (create_family_group と family_members のトリガーが使う。所有者 (postgres) と service_role だけ)
CREATE OR REPLACE FUNCTION public.billing_has_live_family_plan(p_user_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.personal_subscriptions AS s
      JOIN public.subscription_plans AS p ON p.plan_key = s.plan_key
     WHERE s.user_id = p_user_id
       AND p.plan_type = 'family'
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'))
$$;
REVOKE ALL ON FUNCTION public.billing_has_live_family_plan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_has_live_family_plan(uuid) TO service_role;
COMMENT ON FUNCTION public.billing_has_live_family_plan(uuid) IS
  'billing/03 §6.6: 利用者に live な家族プラン (plan_type = family) の契約 (Stripe / ストア / 手動付与) があるか。家族の門が使う';

-- (6') メンバーの追加の門: 代表者以外の行を、plan_key = free の active なグループに足せない (FAMILY_PLAN_REQUIRED)。
--      family_members に INSERT する経路 (accept_family_invite / add_family_child / service_role の直接の INSERT) をすべて受ける。
--      子供の昇格 (accept_child_promotion) は、いる子供の行の UPDATE (人数は変わらない) なので受けない (BEFORE INSERT だけ。Q-4)。
--      SECURITY DEFINER の関数の中からでも同じ (current_user を見ない)。結合テストで free のグループにメンバーを足すときは、
--      先に代表者へ手動付与 (billing_grant_manual_subscription) で家族プランを入れる (§16.1)
CREATE OR REPLACE FUNCTION public.family_members_billing_plan_gate() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan_key text;
  v_status   text;
BEGIN
  IF NEW.role = 'representative' THEN
    RETURN NEW;
  END IF;
  SELECT g.plan_key, g.status INTO v_plan_key, v_status FROM public.family_groups AS g WHERE g.id = NEW.family_id;
  IF v_status = 'active' AND v_plan_key = 'free' THEN
    RAISE EXCEPTION 'FAMILY_PLAN_REQUIRED' USING ERRCODE = 'P0001', DETAIL = NEW.family_id::text;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.family_members_billing_plan_gate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS family_members_billing_plan_gate ON public.family_members;
CREATE TRIGGER family_members_billing_plan_gate
  BEFORE INSERT ON public.family_members
  FOR EACH ROW EXECUTE FUNCTION public.family_members_billing_plan_gate();

-- (6'') create_family_group: ALREADY_IN_FAMILY の検査の直後に家族プランの門を足す (ほかは土台の逐語。GRANT / REVOKE は既存のまま)
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
  -- billing/03 §6.6: 家族グループは家族プラン (family_basic / family_pro) の契約者だけが作れる
  IF NOT public.billing_has_live_family_plan(auth.uid()) THEN
    RAISE EXCEPTION 'FAMILY_PLAN_REQUIRED' USING ERRCODE = 'P0001';
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

-- ----------------------------------------------------------------
-- (7) 手動付与 (billing/02) の M 行の述語に iap_store IS NULL を足す (§6.7。ほかは土台の逐語)
-- ----------------------------------------------------------------
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
     AND s.stripe_subscription_id IS NULL AND s.iap_store IS NULL
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
     AND s.stripe_subscription_id IS NULL AND s.iap_store IS NULL
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
     WHERE s.stripe_subscription_id IS NULL AND s.iap_store IS NULL
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
