-- migration: 20261016210000_billing_core.sql
-- 戻し方: supabase/rollbacks/20261016210000_billing_core.down.sql
-- 設計: docs/design/billing/01-billing-core.md §6 (方針は billing/01 で定めた)
--
-- ── 前半: personal_subscriptions の変更 (§6.2) ──
-- billing/01 (課金の核): personal_subscriptions を Stripe の Subscription の写しとして使えるようにする。
-- 本番の personal_subscriptions は 0 行 (2026-10-15 読み取り)。既存の行の書き換え (UPDATE / DELETE) は無い。

SET LOCAL lock_timeout = '10s';

-- (1) 列を足す (すべて NULL 可か既定値つき。行の書き換えは起きない)
ALTER TABLE public.personal_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_synced_at       timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_status          varchar(30),
  ADD COLUMN IF NOT EXISTS cancel_at_period_end   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_interval       varchar(10);

COMMENT ON COLUMN public.personal_subscriptions.stripe_synced_at IS
  'Stripe から Subscription を取り直した時刻 (billing_apply_stripe_subscription の p_fetched_at)。これより古い取り直しの結果は適用しない (単調)。手動付与の行は NULL';
COMMENT ON COLUMN public.personal_subscriptions.stripe_status IS
  'Stripe の Subscription.status の素の値 (incomplete / incomplete_expired / trialing / active / past_due / canceled / unpaid / paused)。status はこれを写像したもの';
COMMENT ON COLUMN public.personal_subscriptions.cancel_at_period_end IS
  'Stripe の cancel_at_period_end。true なら current_period_end で解約される (status は変わらない)';
COMMENT ON COLUMN public.personal_subscriptions.billing_interval IS
  'month / year。items[0].price.recurring.interval';

ALTER TABLE public.personal_subscriptions
  DROP CONSTRAINT IF EXISTS personal_subscriptions_billing_interval_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_billing_interval_check
  CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year'));

-- (2) status に incomplete を足す (Stripe の incomplete。live ではない)。
--     本番は 0 行なので違反する行は無い。既存の値はそのまま。
ALTER TABLE public.personal_subscriptions
  DROP CONSTRAINT IF EXISTS personal_subscriptions_status_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_status_check
  CHECK (status IN ('incomplete', 'trialing', 'active', 'paused', 'cancelled', 'expired', 'past_due', 'grace'));

-- (3) updated_at を自動で進める (本番にトリガーが無い。関数 update_updated_at_column は baseline にある)
DROP TRIGGER IF EXISTS personal_subscriptions_set_updated_at ON public.personal_subscriptions;
CREATE TRIGGER personal_subscriptions_set_updated_at
  BEFORE UPDATE ON public.personal_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- (4) RLS: 利用者本人の INSERT / UPDATE を外す (F6)。SELECT (本人 + admin/super_admin/finance/support) と DELETE 禁止はそのまま。
--     admin / super_admin の直接の書き込みは従来どおり残す (手動付与の画面は配線の冊)。
DROP POLICY IF EXISTS personal_subscriptions_insert ON public.personal_subscriptions;
DROP POLICY IF EXISTS personal_subscriptions_update ON public.personal_subscriptions;
CREATE POLICY personal_subscriptions_insert_admin ON public.personal_subscriptions
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles));
CREATE POLICY personal_subscriptions_update_admin ON public.personal_subscriptions
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles));
-- anon は読む必要も書く必要も無い (baseline は GRANT ALL を anon にも付けていた)
REVOKE INSERT, UPDATE, DELETE ON public.personal_subscriptions FROM anon;

-- ── 中盤: billing_customers (新設) と stripe_webhook_events の変更 (§6.3) ──

-- (5) 利用者と Stripe Customer の対応表。1 利用者 = 1 顧客。退会では user_id が SET NULL になり、anonymized_at が入った行が残る
--     (Stripe 側の顧客も氏名・メールを消して残す。billing/01 §11)。auth.users を指す外部キーは NO ACTION にしない
--     (tests/integration/security/auth-users-fk-on-delete.test.ts A)。
CREATE TABLE IF NOT EXISTS public.billing_customers (
  stripe_customer_id  varchar(255) PRIMARY KEY,
  user_id             uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  anonymized_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.billing_customers IS
  '利用者と Stripe Customer (cus_) の対応。service_role だけが読み書きする (RLS は全部拒否)。退会で user_id は NULL になり、anonymized_at が入る。本人のデータの書き出しには出さない (src/lib/account-export-tables.ts の ACCOUNT_EXPORT_EXCLUDED)';
DROP TRIGGER IF EXISTS billing_customers_set_updated_at ON public.billing_customers;
CREATE TRIGGER billing_customers_set_updated_at
  BEFORE UPDATE ON public.billing_customers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_customers_no_access ON public.billing_customers;
CREATE POLICY billing_customers_no_access ON public.billing_customers USING (false) WITH CHECK (false);
REVOKE ALL ON public.billing_customers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.billing_customers TO service_role;

-- (6) stripe_webhook_events: 権利を取った時刻と回数 (billing_claim_stripe_event が使う)
ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count         integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.stripe_webhook_events.processing_started_at IS
  '最後に処理の権利を取った時刻。processing のままこれが古い行は、次の再送で再び権利を取れる (billing_claim_stripe_event の p_stuck_after)';
COMMENT ON COLUMN public.stripe_webhook_events.attempt_count IS '権利を取った回数 (初回 1)';
-- payload に残すのはイベントの最小化した写しだけ (TS の minimizeStripeEventPayload。billing/01 §8.1・§9.6)。
-- 氏名・メールアドレス・住所 (customer_email / customer_name / customer_details など) を DB に残さない (退会の匿名化 #1562 と同じ扱い)。
-- 本番は 0 行 (2026-10-15 読み取り。§2.2 F7) なので、既存の行の書き換えは無い
COMMENT ON COLUMN public.stripe_webhook_events.payload IS
  'Stripe のイベントの最小化した写し (id / type / created / livemode と data.object の許可リストの項目だけ。billing/01 §8.1 minimizeStripeEventPayload)。氏名・メールアドレス・住所を持たない';

-- ── 後半: DB 関数 3 本・家族のトリガー・特権列ガード (§6.4) ──

-- (7) Webhook の冪等キー (event.id) で処理の権利を取る。
--     戻り値: 'claimed' (この呼び出しが処理する) / 'completed' (処理済み。受け口は 200) /
--             'in_progress' (ほかが processing 中で p_stuck_after 以内。受け口は 409 を返し、Stripe に再送させる)。
--     pending / failed の行、または processing のまま p_stuck_after より古い行は、再び権利を取れる (= 再処理)。
--     p_stuck_after の既定 15 分は Vercel の関数の最長 (maxDuration) を十分に超える値 (operator/05 §8.3 と同じ値)。
CREATE OR REPLACE FUNCTION public.billing_claim_stripe_event(
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
    RAISE EXCEPTION 'billing_claim_stripe_event: p_event_id / p_event_type / p_payload are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.stripe_webhook_events (id, event_type, payload, processing_status, processing_started_at, attempt_count)
  VALUES (p_event_id, p_event_type, p_payload, 'processing', now(), 1)
  ON CONFLICT (id) DO UPDATE
     SET processing_status      = 'processing',
         processing_started_at  = now(),
         error_message          = NULL,
         attempt_count          = public.stripe_webhook_events.attempt_count + 1
   WHERE public.stripe_webhook_events.processing_status IN ('pending', 'failed')
      OR (public.stripe_webhook_events.processing_status = 'processing'
          AND COALESCE(public.stripe_webhook_events.processing_started_at, public.stripe_webhook_events.received_at)
              < now() - p_stuck_after)
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN 'claimed';
  END IF;
  -- 権利を取れなかった: 処理済みか、ほかが処理中か (ON CONFLICT DO UPDATE は WHERE が偽でも行をロックしているので、いまの値が読める)
  SELECT e.processing_status INTO v_status FROM public.stripe_webhook_events AS e WHERE e.id = p_event_id;
  RETURN CASE WHEN v_status = 'completed' THEN 'completed' ELSE 'in_progress' END;
END
$$;
REVOKE ALL ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) TO service_role;
COMMENT ON FUNCTION public.billing_claim_stripe_event(text, text, jsonb, interval) IS
  'billing/01 §6.4: Stripe Webhook の event.id で処理の権利を取る (claimed / completed / in_progress)。failed と古い processing は再処理できる';

-- (8) 処理の結果を記録する。p_error には固定のコード (BILL_… / EXT_…) だけを渡す (生のエラー文・秘密は渡さない)。
CREATE OR REPLACE FUNCTION public.billing_finish_stripe_event(
  p_event_id text,
  p_ok       boolean,
  p_error    text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stripe_webhook_events
     SET processing_status = CASE WHEN p_ok THEN 'completed' ELSE 'failed' END,
         processed_at      = CASE WHEN p_ok THEN now() ELSE processed_at END,
         error_message     = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
   WHERE id = p_event_id;
END
$$;
REVOKE ALL ON FUNCTION public.billing_finish_stripe_event(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_finish_stripe_event(text, boolean, text) TO service_role;
COMMENT ON FUNCTION public.billing_finish_stripe_event(text, boolean, text) IS
  'billing/01 §6.4: Stripe Webhook の処理の結果 (completed / failed) を記録する';

-- (9) Stripe の Subscription の写像 (本冊の中心)。
--     p_snapshot は billing/01 §8.1 の SubscriptionSnapshot (TS が Stripe の最新のオブジェクトから作る)。
--     p_fetched_at は Stripe から取り直した時刻。既存の行の stripe_synced_at がこれ以上なら何もしない (stale)。
--     p_source は 'webhook:<event.id>' / 'checkout_sync' / 'api:cancel' / 'api:resume' / 'wiring:<job>' のような出どころ (監査の details に残す)。
--     戻り値 (jsonb): applied のとき { applied: true, subscription_id, user_id, status_from, status_to, plan_key } /
--                     古い取り直しのとき { applied: false, skipped: 'stale', subscription_id, user_id } (user_id は必ず入る。
--                     invoice.payment_failed の監査が使う。billing/01 §8.6) /
--                     退会済みのとき { applied: false, skipped: 'user_deleted', customer_closed } (customer_closed = この契約の顧客の
--                     対応表の行が「利用者が消えた」(user_id IS NULL) か。true なら TS が Stripe の契約を即時解約する。billing/01 §8.6 syncSubscription・§11)
--     既存の行は「3.」で FOR NO KEY UPDATE でロックしてから読む。配線の直接の UPDATE (past_due → grace・paused。§12) と
--     行ロックで直列になり、commit 済みの grace / paused を読んで保持の規則に掛ける (ロックせずに読むと、その UPDATE を巻き戻す)。
--     ロックの順 (billing/01 §7.1): advisory 2 本 → 契約の行 → family_groups の行 → user_profiles の行。family_groups → user_profiles は
--     家族の関数の LOCK-ORDER (#1310。リポジトリの CLAUDE.md「家族 (family_*) を変える関数のロック順」) と同じ向き。
--     逆 (user_profiles → family_groups) にすると、運営の強制解散・代表者の家族の削除 (family_groups → user_profiles) とデッドロックする。
--     業務エラー (RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001', DETAIL = <補足>): BILL_UNKNOWN_USER / BILL_UNKNOWN_PLAN /
--     BILL_UNKNOWN_STRIPE_STATUS / BILL_LIVE_ROW_CONFLICT。引数の不足は 22023。
CREATE OR REPLACE FUNCTION public.billing_apply_stripe_subscription(
  p_snapshot   jsonb,
  p_fetched_at timestamptz,
  p_source     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub_id           text := p_snapshot->>'stripe_subscription_id';
  v_customer_id      text := p_snapshot->>'stripe_customer_id';
  v_user_id          uuid := NULLIF(p_snapshot->>'user_id', '')::uuid;
  v_plan_key         text := NULLIF(p_snapshot->>'plan_key', '');
  v_stripe_status    text := p_snapshot->>'stripe_status';
  v_pause            boolean := COALESCE((p_snapshot->>'pause_collection')::boolean, false);
  v_existing         public.personal_subscriptions%ROWTYPE;
  v_plan             public.subscription_plans%ROWTYPE;
  v_status           text;
  v_live             boolean;
  v_row_id           uuid;
  v_status_from      text;
  v_other_live       uuid;
  v_cancelled_at     timestamptz;
  v_past_due_since   timestamptz;
  v_grace_started_at timestamptz;
  v_member_limit     integer;
  v_customer_anonymized_at timestamptz;
BEGIN
  IF v_sub_id IS NULL OR v_customer_id IS NULL OR v_stripe_status IS NULL OR p_fetched_at IS NULL OR p_source IS NULL THEN
    RAISE EXCEPTION 'billing_apply_stripe_subscription: snapshot / p_fetched_at / p_source are required' USING ERRCODE = '22023';
  END IF;

  -- 1. 利用者の解決: snapshot の user_id (Checkout の metadata) → 顧客の対応表 → 既存の行
  IF v_user_id IS NULL THEN
    SELECT c.user_id, c.anonymized_at INTO v_user_id, v_customer_anonymized_at
      FROM public.billing_customers AS c WHERE c.stripe_customer_id = v_customer_id;
    -- 退会で匿名化した顧客 (退会の段階 billing が anonymized_at を入れ、deleteUser の SET NULL で user_id が NULL)。
    -- metadata.user_id を持たない契約 (Dashboard で作った契約。S13) の退会後のイベントも、退会済みとして何もしない
    -- (契約の行は CASCADE で消えているので、ここで返さないと BILL_UNKNOWN_USER の 500 になり Stripe が 3 日再送する。S10)。
    -- user_id が NULL でも anonymized_at が無い行 (退会の手順を通らずに auth.users が消えた) は下の BILL_UNKNOWN_USER のまま (運営が拾う。§13.3)
    IF v_user_id IS NULL AND v_customer_anonymized_at IS NOT NULL THEN
      -- 対応表の行の user_id が NULL (利用者が消えた) なので customer_closed は true
      RETURN jsonb_build_object('applied', false, 'skipped', 'user_deleted', 'customer_closed', true);
    END IF;
  END IF;
  IF v_user_id IS NULL THEN
    SELECT s.user_id INTO v_user_id FROM public.personal_subscriptions AS s WHERE s.stripe_subscription_id = v_sub_id;
  END IF;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_USER' USING ERRCODE = 'P0001', DETAIL = v_sub_id;
  END IF;
  -- 退会済み (auth.users に無い) なら何も書かない。契約の行は CASCADE で消えている。
  -- customer_closed: この契約の顧客が当社の対応表にあり、その利用者が消えた (deleteUser の SET NULL で user_id IS NULL) か。
  -- true なら退会した利用者の顧客に残った契約 (退会の段階 billing_recheck のあと deleteUser までに完了した Checkout の契約など) なので、TS が Stripe で即時解約する
  -- (billing/01 §8.6 syncSubscription)。対応表に無い顧客 (同じ Stripe のテスト用アカウントを使う別の環境が作った契約など) は false で、何もしない
  IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = v_user_id) THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'user_deleted',
                              'customer_closed', EXISTS (
                                SELECT 1 FROM public.billing_customers AS c
                                 WHERE c.stripe_customer_id = v_customer_id AND c.user_id IS NULL));
  END IF;

  -- 2. ロック (利用者 → サブスクリプションの順。cross/02 §6.2 の命名)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || v_user_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('stripe-subscription:' || v_sub_id));

  -- 3. 既存の行と鮮度。行は FOR NO KEY UPDATE でロックしてから読む (apply_coupon と同じロックの強さ)。
  --    advisory lock は写像どうしを直列にするだけで、配線の直接の UPDATE (§12 の past_due → grace・paused) とは直列にならない。
  --    行ロックで待つので、相手が commit した grace / paused を読み、5. の保持の規則がそれを保つ (相手が後なら、相手の
  --    UPDATE の WHERE が写像の書いた行で評価し直される)。ロックの順は advisory 2 本 → 契約の行 → (10. で) family_groups の行 →
  --    user_profiles の行 (§7.1 の消費経路の行。family_groups を user_profiles より先に取る。冒頭の注)
  SELECT s.* INTO v_existing FROM public.personal_subscriptions AS s WHERE s.stripe_subscription_id = v_sub_id
     FOR NO KEY UPDATE;
  IF v_existing.id IS NOT NULL AND v_existing.stripe_synced_at IS NOT NULL AND v_existing.stripe_synced_at >= p_fetched_at THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'stale', 'subscription_id', v_existing.id, 'user_id', v_user_id);
  END IF;

  -- 4. プラン (既存の行の plan_key → snapshot の plan_key)。行の plan_key は行を作ったときに決まり、以後変わらない
  --    (既存の契約の Price を Stripe の Dashboard で付け替えても、プラン・plan_key_cached・家族のグループは変えない。
  --    付け替え先の Price が別のプラン (家族 ↔ 個人) でも、家族のグループの戻しが取り残されない。billing/01 §7.3)
  IF v_existing.id IS NOT NULL THEN
    v_plan_key := v_existing.plan_key;
  END IF;
  IF v_plan_key IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_PLAN' USING ERRCODE = 'P0001', DETAIL = v_sub_id;
  END IF;
  SELECT p.* INTO v_plan FROM public.subscription_plans AS p WHERE p.plan_key = v_plan_key;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_PLAN' USING ERRCODE = 'P0001', DETAIL = v_plan_key;
  END IF;

  -- 5. 状態の写像 (billing/01 §7.2 の表) と保持の規則
  v_status := CASE v_stripe_status
    WHEN 'incomplete'         THEN 'incomplete'
    WHEN 'incomplete_expired' THEN 'expired'
    WHEN 'trialing'           THEN 'trialing'
    WHEN 'active'             THEN 'active'
    WHEN 'past_due'           THEN 'past_due'
    WHEN 'unpaid'             THEN 'past_due'
    WHEN 'canceled'           THEN 'cancelled'
    WHEN 'paused'             THEN 'expired'
  END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_STRIPE_STATUS' USING ERRCODE = 'P0001', DETAIL = v_stripe_status;
  END IF;
  IF v_existing.id IS NOT NULL AND v_status = 'past_due' AND v_existing.status = 'grace' THEN
    v_status := 'grace';          -- grace は配線のジョブが past_due を進めたもの。Stripe が past_due/unpaid の間は保つ
  END IF;
  IF v_existing.id IS NOT NULL AND v_status = 'active' AND v_pause AND v_existing.status = 'paused' THEN
    v_status := 'paused';         -- 組織ライセンスの一時停止 (配線) は Stripe の pause_collection と対で保つ
  END IF;
  v_live := v_status IN ('trialing', 'active', 'paused', 'past_due', 'grace');

  -- 6. 同じ利用者の別の live 行 (別の Stripe の契約、または手動付与) があれば失敗させる (部分 UNIQUE の違反を先に名指しする)
  IF v_live THEN
    SELECT s.id INTO v_other_live
      FROM public.personal_subscriptions AS s
     WHERE s.user_id = v_user_id
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
       AND s.stripe_subscription_id IS DISTINCT FROM v_sub_id
     LIMIT 1;
    IF v_other_live IS NOT NULL THEN
      RAISE EXCEPTION 'BILL_LIVE_ROW_CONFLICT' USING ERRCODE = 'P0001', DETAIL = v_other_live::text;
    END IF;
  END IF;

  -- 7. 時刻の列の規則 (billing/01 §7.3)
  v_past_due_since   := CASE WHEN v_status IN ('past_due', 'grace') THEN COALESCE(v_existing.past_due_since, now()) ELSE NULL END;
  v_grace_started_at := CASE WHEN v_status = 'grace' THEN v_existing.grace_started_at ELSE NULL END;
  v_cancelled_at     := CASE WHEN v_status = 'cancelled'
                             THEN COALESCE((p_snapshot->>'ended_at')::timestamptz, (p_snapshot->>'canceled_at')::timestamptz,
                                           v_existing.cancelled_at, now())
                             ELSE NULL END;

  -- 8. upsert (stripe_subscription_id で 1 行)。行が無ければ status に関わらず INSERT する: 最初の写像が終端・非 live
  --    (cancelled / expired) でも履歴の行を作る (§7.3 の「– → cancelled / expired (INSERT)」の行。例: S12 の 2 本目を運営が解約した)
  IF v_existing.id IS NULL THEN
    INSERT INTO public.personal_subscriptions (
      user_id, plan_key, status, stripe_status, stripe_customer_id, stripe_subscription_id, stripe_price_id, billing_interval,
      starts_at, current_period_start, current_period_end,
      trial_started_at, trial_ends_at, trial_source,
      cancel_at, cancel_at_period_end, cancelled_at, past_due_since, grace_started_at, stripe_synced_at
    ) VALUES (
      v_user_id, v_plan_key, v_status, v_stripe_status, v_customer_id, v_sub_id,
      NULLIF(p_snapshot->>'stripe_price_id', ''), NULLIF(p_snapshot->>'billing_interval', ''),
      COALESCE((p_snapshot->>'start_date')::timestamptz, now()),
      (p_snapshot->>'current_period_start')::timestamptz, (p_snapshot->>'current_period_end')::timestamptz,
      (p_snapshot->>'trial_start')::timestamptz, (p_snapshot->>'trial_end')::timestamptz,
      CASE WHEN p_snapshot->>'trial_start' IS NOT NULL THEN 'checkout' ELSE NULL END,
      (p_snapshot->>'cancel_at')::timestamptz, COALESCE((p_snapshot->>'cancel_at_period_end')::boolean, false),
      v_cancelled_at, v_past_due_since, v_grace_started_at, p_fetched_at
    ) RETURNING id INTO v_row_id;
    v_status_from := NULL;
  ELSE
    UPDATE public.personal_subscriptions
       SET plan_key             = v_plan_key,
           status               = v_status,
           stripe_status        = v_stripe_status,
           stripe_customer_id   = v_customer_id,
           stripe_price_id      = NULLIF(p_snapshot->>'stripe_price_id', ''),
           billing_interval     = NULLIF(p_snapshot->>'billing_interval', ''),
           current_period_start = (p_snapshot->>'current_period_start')::timestamptz,
           current_period_end   = (p_snapshot->>'current_period_end')::timestamptz,
           trial_started_at     = COALESCE((p_snapshot->>'trial_start')::timestamptz, trial_started_at),
           trial_ends_at        = COALESCE((p_snapshot->>'trial_end')::timestamptz, trial_ends_at),
           cancel_at            = (p_snapshot->>'cancel_at')::timestamptz,
           cancel_at_period_end = COALESCE((p_snapshot->>'cancel_at_period_end')::boolean, false),
           cancelled_at         = v_cancelled_at,
           past_due_since       = v_past_due_since,
           grace_started_at     = v_grace_started_at,
           stripe_synced_at     = p_fetched_at
     WHERE id = v_existing.id;
    v_row_id := v_existing.id;
    v_status_from := v_existing.status;
  END IF;

  -- 9. 顧客の対応表 (Dashboard で作られた契約など、まだ無ければ足す。どちらかの UNIQUE に当たれば何もしない)
  INSERT INTO public.billing_customers (stripe_customer_id, user_id) VALUES (v_customer_id, v_user_id)
  ON CONFLICT DO NOTHING;

  -- 10. 家族プランのグループへの反映と、個人契約のキャッシュ (live な行が無ければ NULL = free)。
  --     **family_groups の UPDATE を user_profiles の UPDATE より先に流す** (ロックの順 = family_groups の行 → user_profiles の行。
  --     家族の関数の LOCK-ORDER #1310 と同じ向き)。逆の順だと、写像が user_profiles (代表者) を持ったまま family_groups を待ち、
  --     運営の強制解散 (operator_force_dissolve_family: family_groups → user_profiles WHERE family_id) や代表者の家族の削除
  --     (DELETE family_groups → user_profiles.family_id の ON DELETE SET NULL) が family_groups を持ったまま user_profiles (代表者) を
  --     待って 40P01 になる (§7.1 の family の関数の行・テスト 106)。
  --     グループはいまの代表者 = v_user_id のものだけ。代表者が交代したときの付け替えは (10) のトリガーが受け持つ。
  --     WHERE に当たらない (プランと上限が同じ・グループが無い・代表者でない) ときは family_groups の行をロックしない
  IF v_plan.plan_type = 'family' THEN
    -- member_limit の CHECK は 1〜20 (family_groups_member_limit_check)。max_members が無いプランは既定の 4 (DDL の既定値と同じ)
    v_member_limit := LEAST(COALESCE(v_plan.max_members, 4), 20);
    IF v_live THEN
      UPDATE public.family_groups AS g
         SET plan_key = v_plan_key, member_limit = v_member_limit
       WHERE g.representative_id = v_user_id AND g.status = 'active'
         AND (g.plan_key IS DISTINCT FROM v_plan_key OR g.member_limit IS DISTINCT FROM v_member_limit);
    ELSE
      -- 同じ利用者に同じプランの live な行が残っている (例: 未完了 (incomplete) の 1 本目が期限切れになったが、2 本目が live) なら戻さない
      UPDATE public.family_groups AS g
         SET plan_key = 'free', member_limit = 4
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

  -- 11. 監査 (状態が変わったときだけ。actor_id は NULL = system。target は利用者)
  IF v_status_from IS DISTINCT FROM v_status THEN
    INSERT INTO public.admin_audit_logs (actor_id, action_type, target_id, target_type, severity, details)
    VALUES (
      NULL,
      CASE WHEN v_status_from IS NULL THEN 'system.billing.subscription_created' ELSE 'system.billing.subscription_status_changed' END,
      v_user_id, 'user',
      CASE WHEN v_status IN ('past_due', 'grace') THEN 'warn' ELSE 'info' END,
      jsonb_build_object('stripe_subscription_id', v_sub_id, 'plan_key', v_plan_key, 'from', v_status_from, 'to', v_status,
                         'stripe_status', v_stripe_status, 'source', p_source)
    );
  END IF;

  RETURN jsonb_build_object('applied', true, 'subscription_id', v_row_id, 'user_id', v_user_id,
                            'status_from', v_status_from, 'status_to', v_status, 'plan_key', v_plan_key);
END
$$;
REVOKE ALL ON FUNCTION public.billing_apply_stripe_subscription(jsonb, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_apply_stripe_subscription(jsonb, timestamptz, text) TO service_role;
COMMENT ON FUNCTION public.billing_apply_stripe_subscription(jsonb, timestamptz, text) IS
  'billing/01 §6.4: Stripe の Subscription の最新の姿 (snapshot) を personal_subscriptions に写す唯一の入口。p_fetched_at で単調。plan_key_cached と family_groups.plan_key も同期する';

-- (10) 家族グループを作ったとき・代表者が変わったときに、グループのプランを代表者の契約に合わせる (billing/01 §7.3・S18・S20)。
--      不変条件: active なグループの plan_key は「いまの代表者の live な家族プラン (plan_type='family') の契約」のプラン。
--      代表者を変えるのは family の DB 関数 2 本 (operator_force_representative_transfer / accept_family_representative_transfer)、
--      グループを作るのは create_family_group。どの関数も変えず、family_groups の BEFORE INSERT / BEFORE UPDATE OF representative_id で
--      合わせる (今後ほかの経路が増えても同じ規則になる)。
--      - 代表者に live な家族プランの契約がある → そのプランと上限。
--      - INSERT で契約が無い → plan_key = 'free' (create_family_group の p_plan_key は使わない。利用者が課金なしで家族プランを
--        名乗れる穴 (F23) を閉じる)。member_limit は呼び出し側の値 (既定 4) のまま。INSERT は呼び出し元を問わない
--        (service_role の直接の INSERT も同じ)。契約なしで家族プランのグループが要るとき (運営の手動・結合テスト) は、
--        INSERT のあとに service_role で plan_key を UPDATE する (UPDATE OF plan_key はこのトリガーに当たらない。§16.1)。
--      - UPDATE で契約が無い → グループのプランが旧代表者の契約から来たもの (旧代表者に同じ plan_key の live な行がある) のときだけ
--        free / 4 に戻す (ほかの経路 = service_role の直接の UPDATE で入ったプランは触らない)。
--      名前は trg_guard_family_groups_privileged より前に並ぶ (同じ BEFORE UPDATE は名前の順に動く)。authenticated / anon が
--      representative_id を直接変えた UPDATE は、そのあとのガードが 42501 で止めるので、ここで NEW を変えても書かれない。
CREATE OR REPLACE FUNCTION public.billing_family_plan_follow_representative() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_plan     public.subscription_plans%ROWTYPE;
  v_old_is_owner boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.representative_id IS NOT DISTINCT FROM OLD.representative_id THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  -- 新しい代表者の写像 (9) と直列にする (写像と同じ鍵 billing-user:<uuid>)。取らないと、代表者の購入・解約の写像が commit する前の
  -- 契約を読み、写像の側の family_groups の UPDATE (WHERE representative_id = 新しい代表者) は交代・作成の commit 前の行に当たらず、
  -- グループのプランが契約と食い違ったまま残る。旧代表者の鍵は取らない (旧代表者の写像は WHERE representative_id = 旧代表者 で
  -- この行のロックを待つので、ここで旧代表者の鍵を待つと循環する)。旧代表者の契約は下でロックなしで読む (§7.1 の family の行)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || NEW.representative_id::text));
  SELECT p.* INTO v_new_plan
    FROM public.personal_subscriptions AS s
    JOIN public.subscription_plans AS p ON p.plan_key = s.plan_key
   WHERE s.user_id = NEW.representative_id
     AND p.plan_type = 'family'
     AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
   ORDER BY s.created_at DESC, s.id
   LIMIT 1;
  IF v_new_plan.id IS NOT NULL THEN
    NEW.plan_key     := v_new_plan.plan_key;
    -- 写像 (9) の 10. と同じ: member_limit の CHECK は 1〜20。max_members が無いプランは DDL の既定値 4
    NEW.member_limit := LEAST(COALESCE(v_new_plan.max_members, 4), 20);
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.plan_key := 'free';
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.personal_subscriptions AS s
     WHERE s.user_id = OLD.representative_id AND s.plan_key = OLD.plan_key
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
  ) INTO v_old_is_owner;
  IF v_old_is_owner THEN
    NEW.plan_key     := 'free';
    NEW.member_limit := 4;   -- family_groups.member_limit の DDL の既定値 (写像 (9) の 10. の戻しと同じ)
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.billing_family_plan_follow_representative() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.billing_family_plan_follow_representative() IS
  'billing/01 §6.4 (10): family_groups の作成と代表者の交代で、plan_key / member_limit を代表者の live な家族プランの契約に合わせる (作成で契約が無ければ free)';
DROP TRIGGER IF EXISTS family_groups_billing_plan_follow_representative ON public.family_groups;
CREATE TRIGGER family_groups_billing_plan_follow_representative
  BEFORE INSERT OR UPDATE OF representative_id ON public.family_groups
  FOR EACH ROW EXECUTE FUNCTION public.billing_family_plan_follow_representative();

-- (11) 特権列ガード 2 本に plan_key_cached を足す (本人が自分の契約の写しを書けないように。F21)。
--      土台は 20261008200700_legal_documents_acceptance.sql の定義 (最新)。足すのは plan_key_cached の 1 行ずつだけで、ほかは逐語。
--      写像 (9) は SECURITY DEFINER (所有者 postgres) なので current_user が authenticated / anon にならず、ガードに当たらない。
CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.roles            IS DISTINCT FROM OLD.roles
       OR NEW.org_role         IS DISTINCT FROM OLD.org_role
       OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
       OR NEW.family_id        IS DISTINCT FROM OLD.family_id
       OR NEW.is_active_in_org IS DISTINCT FROM OLD.is_active_in_org
       OR NEW.joined_org_at    IS DISTINCT FROM OLD.joined_org_at
       OR NEW.frozen_at        IS DISTINCT FROM OLD.frozen_at
       OR NEW.frozen_by        IS DISTINCT FROM OLD.frozen_by
       OR NEW.frozen_reason    IS DISTINCT FROM OLD.frozen_reason
       OR NEW.unban_at         IS DISTINCT FROM OLD.unban_at
       OR NEW.department_id    IS DISTINCT FROM OLD.department_id
       OR NEW.terms_version_accepted   IS DISTINCT FROM OLD.terms_version_accepted
       OR NEW.privacy_version_accepted IS DISTINCT FROM OLD.privacy_version_accepted
       OR NEW.legal_accepted_at        IS DISTINCT FROM OLD.legal_accepted_at
       OR NEW.plan_key_cached          IS DISTINCT FROM OLD.plan_key_cached THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF (NEW.roles IS NOT NULL AND NEW.roles IS DISTINCT FROM ARRAY['user']::text[])
       OR NEW.org_role         IS NOT NULL
       OR NEW.organization_id  IS NOT NULL
       OR NEW.family_id        IS NOT NULL
       OR NEW.is_active_in_org IS DISTINCT FROM false
       OR NEW.joined_org_at    IS NOT NULL
       OR NEW.frozen_at        IS NOT NULL
       OR NEW.frozen_by        IS NOT NULL
       OR NEW.frozen_reason    IS NOT NULL
       OR NEW.unban_at         IS NOT NULL
       OR NEW.department_id    IS NOT NULL
       OR NEW.terms_version_accepted   IS NOT NULL
       OR NEW.privacy_version_accepted IS NOT NULL
       OR NEW.legal_accepted_at        IS NOT NULL
       OR NEW.plan_key_cached          IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON COLUMN public.user_profiles.plan_key_cached IS
  '個人契約の plan_key の写し (live な行が無ければ NULL = free)。billing_apply_stripe_subscription だけが書く。本人は直接変更できない (guard_user_profiles_privileged)。billing/01';
