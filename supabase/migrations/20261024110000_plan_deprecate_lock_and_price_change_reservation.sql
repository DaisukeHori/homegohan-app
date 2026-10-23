-- migration: 20261024110000_plan_deprecate_lock_and_price_change_reservation.sql
-- 戻し方: supabase/rollbacks/20261024110000_plan_deprecate_lock_and_price_change_reservation.down.sql
-- #1917 の続き: 運営のプランの操作で、ロックの外で読んだ値に頼っていた 2 か所を直す (追加だけ。既存のデータ・権限・ポリシーは変えない)。
--
-- (1) プランの廃止の安全弁 (#1127・#1912) を、書く文と同じトランザクションの中でも確かめる
--   背景: PATCH /api/super-admin/plans/{id} は、廃止 (status → 'deprecated') の前に契約者を数え (src/lib/super-admin/plan-subscribers.ts の
--   countPlanSubscribers)、0 件なら status を条件にした UPDATE を流す。数えてから書くまでは別の文 (別の接続) なので、その間に
--   契約者が増える (personal_subscriptions の INSERT・live でない status から live への切り替え・plan_key の付け替え、
--   家族のグループの active への切り替え・プランの付け替え、組織の作成・active への切り替え・plan の付け替え) と、契約者のいるプランを廃止できてしまう。
--   super_admin は PostgREST から subscription_plans を直接書けるので (ポリシー subscription_plans_mutate_super_admin)、route の確認を通らない経路もある。
--   変更: subscription_plans の BEFORE UPDATE OF status のトリガー guard_plan_deprecate_subscribers を足す。status が
--   'deprecated' 以外から 'deprecated' に変わる行で、
--     a. 自分の行を FOR UPDATE でロックし直す。契約者が増える書き込みは、下の (1b) のトリガー trg_subscriber_plan_key_share で
--        この行に FOR KEY SHARE を取り、commit まで持つ。外部キー (personal_subscriptions_plan_key_fkey・family_groups_plan_key_fkey →
--        subscription_plans.plan_key) の確認だけでは足りない: 外部キーの確認は INSERT と plan_key を変えた UPDATE にしか走らず
--        (plan_key を変えずに status だけを live にする UPDATE はプランの行をロックしない。例: billing_apply_stripe_subscription の
--        incomplete → active・billing_apply_store_subscription の expired / cancelled → active)、組織 (organizations.plan) には外部キーが無い。
--        UPDATE が取るロック (FOR NO KEY UPDATE) は FOR KEY SHARE と衝突しないので、そのままでは commit 前の契約を待たない。
--        FOR UPDATE は衝突するので、ここで commit (か取り消し) まで待つ。逆に、このロックを取った後に来た契約者が増える書き込みは、
--        (1b) の FOR KEY SHARE でこの UPDATE の commit を待つ (廃止の後に入る契約になる。数えてから書くまでの間に入った契約を見落とすことは無い)
--     b. ロックの後に契約者を数える (plpgsql の文ごとに新しいスナップショットなので、待った相手の commit が見える)。数え方は
--        countPlanSubscribers と同じ (個人 = live 5 値・家族 = active・組織 = plan が一致し active。組織のプランの行
--        (plan_type = 'org' で plan_key が組織の段階 standard / premium / enterprise でない行) では組織を数えず、内訳にもキーを入れない)
--     c. 1 件でもあれば RAISE 'OP_PLAN_HAS_SUBSCRIBERS' (P0001)。DETAIL に内訳の JSON (route が 409 の counts に使う) を入れる
--   ロック順: このトリガーがロックするのは対象のプランの 1 行だけで、契約・家族・組織の行は読むだけ (ロックしない)。契約者を増やす側は
--   契約の行 → プランの行 ((1b) と外部キーの確認) の順に取るので、待ち合いは一方向で循環しない。
--
-- (1b) 契約者が増える書き込みは、プランの行に FOR KEY SHARE を取る (a の待ち合いの相手)
--   personal_subscriptions・family_groups・organizations の BEFORE INSERT OR UPDATE のトリガー trg_subscriber_plan_key_share を足す
--   (関数 personal_subscription_hold_plan_key_share・family_group_hold_plan_key_share・organization_hold_plan_key_share)。
--   書いた後の行が b で数えられる行 (個人 = live 5 値・家族 = active・組織 = active) で、書く前は数えられていなかった
--   (INSERT・書く前の status が数えられない値・plan_key (組織は plan) を変えた) ときだけ、そのプランの行を FOR KEY SHARE でロックする
--   (プランの行が無ければ何もしない。組織の段階の plan は本番の subscription_plans に行が無いので、組織の書き込みは実際には何もロックしない)。
--   列を限らない UPDATE にする (UPDATE OF ... は SET に書いた列でしか動かず、ほかのトリガーが NEW を変えた行を取りこぼす)。
--   名前は各表の BEFORE のトリガーの最後に並ぶ (同じ BEFORE は名前の順に動く。ほかのトリガーが変えた後の NEW を見る)。
--   FOR KEY SHARE は FOR NO KEY UPDATE (価格の変更の begin / apply・ふつうのプランの UPDATE) と衝突しないので、プランの編集は待たせない。
--   廃止の FOR UPDATE とだけ待ち合う。
--
-- (2) 価格の変更 (POST /api/super-admin/plans/{id}/price-change) を、プランごとの予約の行で 1 本ずつにし、履歴と価格の更新を 1 つのトランザクションにする
--   背景: route はプランをロックも条件も無く読み、Edge Function stripe-price-sync (Stripe の新しい Price の作成と、その時点の DB の旧 Price の無効化) を
--   呼んでから、読んだ値を plan_price_history と監査の old_* に書き、価格を .eq(id) だけで UPDATE していた。2 人の運営がほぼ同時に
--   同じプランの価格を変えると、後の記録の old_* が実際の直前の値 (先の変更の後の値) と食い違う。読んだ値を条件にした UPDATE だけでは足りない:
--   Stripe の呼び出しは DB の鍵をまたげず、後の呼び出しの Edge Function が先の変更で入った Price を無効化したあとで 409 にすると、
--   DB が無効な Price を指したまま残る。
--   変更: 予約の表 plan_price_change_reservations (プランごとに 1 行) と、service_role だけが呼ぶ関数 3 本を足す。
--     begin_plan_price_change   : プランの行を FOR NO KEY UPDATE でロックし、予約が無い (か、p_stale_after_seconds より古い) ときだけ
--                                 新しい token で予約し、ロックの下で読んだプランの値を返す。draft・無いプラン・予約中はそれぞれの result を返す
--     apply_plan_price_change   : プランの行をロックし、予約が自分の token のままのときだけ、ロックの下で読んだ値を old_* にして
--                                 plan_price_history を INSERT し、変えた列だけを UPDATE し、予約を消す。変える前の値を返す
--                                 (route は監査の old_* をこの値で書く)。予約が自分のものでなくなっていたら何も書かない (lost)
--     release_plan_price_change : 自分の token の予約を消す (Stripe の同期に失敗したときなど、apply まで行かなかったとき)
--   route は begin → (Stripe) → apply の順に呼び、Stripe を呼ぶのは予約を取った 1 本だけになる。
--   予約の期限 (p_stale_after_seconds) は route が渡す (src/lib/super-admin/plan-price-change-reservation.ts の
--   PRICE_CHANGE_RESERVATION_STALE_SECONDS)。route の途中で落ちて消えなかった予約は、期限の後に次の begin が取り直す。
--   ロック順: 3 本とも、プランの行 → 予約の行の順 (release は予約の行だけ)。予約の INSERT は外部キーの確認でプランの行に FOR KEY SHARE を取るが、
--   同じトランザクションがそのプランの行を FOR NO KEY UPDATE で持っているので待たない。
--   読み書きは service_role の関数だけ。表は RLS を有効にし、利用者 (anon / authenticated) の権限を外す (#1039/#1020 の定型)。
--
-- 既存データへの影響: なし (トリガーは今後の INSERT / UPDATE にだけ効く。表は空で作る)。
-- 冪等: CREATE TABLE IF NOT EXISTS・CREATE OR REPLACE FUNCTION・DROP TRIGGER IF EXISTS → CREATE TRIGGER・REVOKE / GRANT は何度流しても同じ。
-- 確かめるテスト: tests/plan-deprecate-lock-price-change-reservation-migration-contract.test.ts (文面)・
--   tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts (実 DB。待ち合いと結果)・
--   tests/plan-deprecate-subscribers-route.test.ts と tests/price-change-fail-closed.test.ts (route)

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) 廃止の安全弁のトリガー
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_plan_deprecate_subscribers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_personal integer;
  v_family integer;
  v_organizations integer;
  v_counts_organizations boolean;
  v_counts jsonb;
BEGIN
  -- a. 契約者が増える書き込み ((1b) のトリガーと外部キーの確認の FOR KEY SHARE) が commit するまで待つ
  PERFORM 1 FROM public.subscription_plans AS p WHERE p.id = OLD.id FOR UPDATE;

  -- b. 契約が終わっていない契約者を数える (src/lib/super-admin/plan-subscribers.ts の countPlanSubscribers と同じ数え方)
  SELECT count(*)::integer INTO v_personal
    FROM public.personal_subscriptions AS s
   WHERE s.plan_key = OLD.plan_key
     AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace');
  SELECT count(*)::integer INTO v_family
    FROM public.family_groups AS g
   WHERE g.plan_key = OLD.plan_key
     AND g.status = 'active';
  -- 組織のプランの行 (isOrgSubscriptionPlanRow) では組織を数えない (#1912)
  v_counts_organizations := NOT (OLD.plan_type = 'org' AND OLD.plan_key NOT IN ('standard', 'premium', 'enterprise'));
  v_counts := jsonb_build_object('personal_subscriptions', v_personal, 'family_groups', v_family);
  IF v_counts_organizations THEN
    SELECT count(*)::integer INTO v_organizations
      FROM public.organizations AS o
     WHERE o.plan = OLD.plan_key
       AND o.status = 'active';
    v_counts := v_counts || jsonb_build_object('organizations', v_organizations);
  END IF;

  -- c. 1 件でもあれば止める
  IF v_personal + v_family + COALESCE(v_organizations, 0) > 0 THEN
    RAISE EXCEPTION 'OP_PLAN_HAS_SUBSCRIBERS' USING ERRCODE = 'P0001', DETAIL = v_counts::text;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.guard_plan_deprecate_subscribers() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.guard_plan_deprecate_subscribers() IS
  '#1917: プランを廃止 (status → deprecated) する UPDATE の中で、行を FOR UPDATE でロックし直して commit 前の契約者が増える書き込み (trg_subscriber_plan_key_share と外部キーの確認の FOR KEY SHARE) を待ってから契約者を数え、1 件でもあれば OP_PLAN_HAS_SUBSCRIBERS (P0001。DETAIL は内訳の JSON) で止める。数え方は countPlanSubscribers と同じ';

DROP TRIGGER IF EXISTS trg_guard_plan_deprecate_subscribers ON public.subscription_plans;
CREATE TRIGGER trg_guard_plan_deprecate_subscribers
  BEFORE UPDATE OF status ON public.subscription_plans
  FOR EACH ROW
  WHEN (NEW.status = 'deprecated' AND OLD.status IS DISTINCT FROM 'deprecated')
  EXECUTE FUNCTION public.guard_plan_deprecate_subscribers();

-- ─────────────────────────────────────────────────────────────────────────────
-- (1b) 契約者が増える書き込みは、プランの行に FOR KEY SHARE を取る
-- ─────────────────────────────────────────────────────────────────────────────

-- 個人契約: live 5 値 (src/lib/super-admin/plan-subscribers.ts の ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES・guard_plan_deprecate_subscribers の b と同じ)
CREATE OR REPLACE FUNCTION public.personal_subscription_hold_plan_key_share()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- 書く前は数えられていなかった行だけ (live のまま plan_key も変えない UPDATE は、契約者を増やさないのでロックしない)
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'), false)
     AND OLD.plan_key IS NOT DISTINCT FROM NEW.plan_key THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.subscription_plans AS p WHERE p.plan_key = NEW.plan_key FOR KEY SHARE;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.personal_subscription_hold_plan_key_share() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.personal_subscription_hold_plan_key_share() IS
  '#1917: 個人契約が数えられる行 (live 5 値) になる INSERT / UPDATE (書く前は live でない・plan_key を変えた) で、プランの行を FOR KEY SHARE でロックする。廃止のトリガー guard_plan_deprecate_subscribers の FOR UPDATE と待ち合い、数えてから書くまでの間の契約を見落とさない (plan_key を変えない UPDATE は外部キーの確認でロックを取らないため)';

DROP TRIGGER IF EXISTS trg_subscriber_plan_key_share ON public.personal_subscriptions;
CREATE TRIGGER trg_subscriber_plan_key_share
  BEFORE INSERT OR UPDATE ON public.personal_subscriptions
  FOR EACH ROW
  WHEN (NEW.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'))
  EXECUTE FUNCTION public.personal_subscription_hold_plan_key_share();

-- 家族のグループ: active
CREATE OR REPLACE FUNCTION public.family_group_hold_plan_key_share()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- 書く前は数えられていなかった行だけ (active のまま plan_key も変えない UPDATE はロックしない)
  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM 'active'
     AND OLD.plan_key IS NOT DISTINCT FROM NEW.plan_key THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.subscription_plans AS p WHERE p.plan_key = NEW.plan_key FOR KEY SHARE;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.family_group_hold_plan_key_share() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.family_group_hold_plan_key_share() IS
  '#1917: 家族のグループが数えられる行 (active) になる INSERT / UPDATE (書く前は active でない・plan_key を変えた) で、プランの行を FOR KEY SHARE でロックする。廃止のトリガー guard_plan_deprecate_subscribers の FOR UPDATE と待ち合う';

DROP TRIGGER IF EXISTS trg_subscriber_plan_key_share ON public.family_groups;
CREATE TRIGGER trg_subscriber_plan_key_share
  BEFORE INSERT OR UPDATE ON public.family_groups
  FOR EACH ROW
  WHEN (NEW.status = 'active')
  EXECUTE FUNCTION public.family_group_hold_plan_key_share();

-- 組織: active (organizations.plan には subscription_plans への外部キーが無いので、INSERT もここでロックを取る)
CREATE OR REPLACE FUNCTION public.organization_hold_plan_key_share()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- 書く前は数えられていなかった行だけ (active のまま plan も変えない UPDATE はロックしない)
  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM 'active'
     AND OLD.plan IS NOT DISTINCT FROM NEW.plan THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.subscription_plans AS p WHERE p.plan_key = NEW.plan FOR KEY SHARE;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.organization_hold_plan_key_share() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.organization_hold_plan_key_share() IS
  '#1917: 組織が数えられる行 (active) になる INSERT / UPDATE (書く前は active でない・plan を変えた) で、plan と同じ plan_key のプランの行を FOR KEY SHARE でロックする (行が無ければ何もしない)。廃止のトリガー guard_plan_deprecate_subscribers の FOR UPDATE と待ち合う';

DROP TRIGGER IF EXISTS trg_subscriber_plan_key_share ON public.organizations;
CREATE TRIGGER trg_subscriber_plan_key_share
  BEFORE INSERT OR UPDATE ON public.organizations
  FOR EACH ROW
  WHEN (NEW.status = 'active')
  EXECUTE FUNCTION public.organization_hold_plan_key_share();

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) 価格の変更の予約
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plan_price_change_reservations (
  plan_id uuid PRIMARY KEY REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  token uuid NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.plan_price_change_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.plan_price_change_reservations FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.plan_price_change_reservations IS
  '#1917: 価格の変更 (POST /api/super-admin/plans/{id}/price-change) の予約 (プランごとに 1 行)。begin_plan_price_change が作り、apply / release が消す。期限より古い行は次の begin が取り直す。service_role の関数だけが読み書きする';

CREATE OR REPLACE FUNCTION public.begin_plan_price_change(p_plan_id uuid, p_stale_after_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_plan public.subscription_plans%ROWTYPE;
  v_reserved_at timestamptz;
  v_token uuid;
BEGIN
  IF p_stale_after_seconds IS NULL OR p_stale_after_seconds <= 0 THEN
    RAISE EXCEPTION 'PRICE_CHANGE_INVALID_STALE_AFTER' USING ERRCODE = '22023';
  END IF;

  SELECT p.* INTO v_plan FROM public.subscription_plans AS p WHERE p.id = p_plan_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_plan.status = 'draft' THEN
    RETURN jsonb_build_object('result', 'draft');
  END IF;

  SELECT r.reserved_at INTO v_reserved_at
    FROM public.plan_price_change_reservations AS r
   WHERE r.plan_id = p_plan_id
     FOR UPDATE;
  IF FOUND AND v_reserved_at > pg_catalog.now() - pg_catalog.make_interval(secs => p_stale_after_seconds) THEN
    RETURN jsonb_build_object('result', 'in_progress');
  END IF;

  v_token := gen_random_uuid();
  INSERT INTO public.plan_price_change_reservations (plan_id, token, reserved_at)
  VALUES (p_plan_id, v_token, pg_catalog.now())
  ON CONFLICT (plan_id) DO UPDATE SET token = EXCLUDED.token, reserved_at = EXCLUDED.reserved_at;

  RETURN jsonb_build_object(
    'result', 'reserved',
    'token', v_token,
    'plan', jsonb_build_object(
      'id', v_plan.id,
      'plan_key', v_plan.plan_key,
      'status', v_plan.status,
      'stripe_product_id', v_plan.stripe_product_id,
      'stripe_price_id', v_plan.stripe_price_id,
      'stripe_yearly_price_id', v_plan.stripe_yearly_price_id,
      'monthly_price_jpy', v_plan.monthly_price_jpy,
      'yearly_price_jpy', v_plan.yearly_price_jpy
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.begin_plan_price_change(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_plan_price_change(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.begin_plan_price_change(uuid, integer) IS
  '#1917: 価格の変更の予約を取る。プランの行を FOR NO KEY UPDATE でロックし、予約が無い (か p_stale_after_seconds 秒より古い) ときだけ新しい token で予約して、ロックの下で読んだプランの値を返す ({result: reserved, token, plan})。無ければ not_found・draft なら draft・予約中なら in_progress。service_role だけ (route は requireRole([''super_admin'']) の後に呼ぶ)';

CREATE OR REPLACE FUNCTION public.apply_plan_price_change(
  p_plan_id uuid,
  p_token uuid,
  p_new_monthly_price_jpy integer,
  p_new_yearly_price_jpy integer,
  p_new_stripe_price_id text,
  p_new_stripe_yearly_price_id text,
  p_changed_by uuid,
  p_reason text,
  p_effective_at timestamptz,
  p_applies_to text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_plan public.subscription_plans%ROWTYPE;
BEGIN
  SELECT p.* INTO v_plan FROM public.subscription_plans AS p WHERE p.id = p_plan_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- 予約が自分の token のままか (期限の後に別の begin が取り直していたら、何も書かない)
  PERFORM 1 FROM public.plan_price_change_reservations AS r
   WHERE r.plan_id = p_plan_id AND r.token = p_token
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'lost');
  END IF;

  -- 履歴の old_* は、ロックの下で読んだ値 (この UPDATE の実際の直前の値)。new_stripe_price_id は月額の新しい Price ID (変えなかったら NULL)
  INSERT INTO public.plan_price_history (
    plan_id, old_monthly_price_jpy, new_monthly_price_jpy, old_yearly_price_jpy, new_yearly_price_jpy,
    old_stripe_price_id, new_stripe_price_id, changed_by, reason, effective_at, applies_to
  ) VALUES (
    p_plan_id, v_plan.monthly_price_jpy, COALESCE(p_new_monthly_price_jpy, v_plan.monthly_price_jpy),
    v_plan.yearly_price_jpy, COALESCE(p_new_yearly_price_jpy, v_plan.yearly_price_jpy),
    v_plan.stripe_price_id, p_new_stripe_price_id, p_changed_by, p_reason, p_effective_at, p_applies_to
  );

  -- 変えた列だけを書く (NULL の引数の列は今の値のまま)
  UPDATE public.subscription_plans AS p
     SET monthly_price_jpy      = COALESCE(p_new_monthly_price_jpy, p.monthly_price_jpy),
         yearly_price_jpy       = COALESCE(p_new_yearly_price_jpy, p.yearly_price_jpy),
         stripe_price_id        = COALESCE(p_new_stripe_price_id, p.stripe_price_id),
         stripe_yearly_price_id = COALESCE(p_new_stripe_yearly_price_id, p.stripe_yearly_price_id),
         updated_at             = pg_catalog.now()
   WHERE p.id = p_plan_id;

  DELETE FROM public.plan_price_change_reservations AS r WHERE r.plan_id = p_plan_id AND r.token = p_token;

  RETURN jsonb_build_object(
    'result', 'applied',
    'previous', jsonb_build_object(
      'monthly_price_jpy', v_plan.monthly_price_jpy,
      'yearly_price_jpy', v_plan.yearly_price_jpy,
      'stripe_price_id', v_plan.stripe_price_id,
      'stripe_yearly_price_id', v_plan.stripe_yearly_price_id
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.apply_plan_price_change(uuid, uuid, integer, integer, text, text, uuid, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_plan_price_change(uuid, uuid, integer, integer, text, text, uuid, text, timestamptz, text)
  TO service_role;

COMMENT ON FUNCTION public.apply_plan_price_change(uuid, uuid, integer, integer, text, text, uuid, text, timestamptz, text) IS
  '#1917: 予約が自分の token のままのときだけ、プランの行をロックして読んだ値を old_* にして plan_price_history を INSERT し、変えた列だけを UPDATE し、予約を消す ({result: applied, previous})。無ければ not_found・予約を失っていれば lost (何も書かない)。service_role だけ';

CREATE OR REPLACE FUNCTION public.release_plan_price_change(p_plan_id uuid, p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.plan_price_change_reservations AS r WHERE r.plan_id = p_plan_id AND r.token = p_token;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.release_plan_price_change(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_plan_price_change(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.release_plan_price_change(uuid, uuid) IS
  '#1917: 自分の token の価格の変更の予約を消す (apply まで行かなかったとき)。消したら true、もう無ければ false。service_role だけ';
