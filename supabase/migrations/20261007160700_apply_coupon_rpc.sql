-- migration: 20261007160700_apply_coupon_rpc.sql
-- #1224: クーポン適用の per_user_limit / 組織上限が check-then-act の競合で突破できる問題と、
--        「旧 redemption の終了 -> 新規 INSERT」が非トランザクションな問題を、DB 関数 1 本にまとめて直す
--
-- 背景:
--   super_admin 専用の POST /api/super-admin/coupons/[id]/apply (src/lib/plan/coupon.ts の applyCoupon) は、
--   PostgREST への複数回の HTTP 呼び出しで次の順に処理していた。
--     1) coupons を読んで有効性を検証 -> 2) 契約とプランを読む
--     3) coupon_redemptions を COUNT して per_user_limit (組織宛なら組織の上限) と JS で比較   <- check
--     4) coupons.uses_count を CAS (楽観ロック) で +1 (max_uses だけはここで原子化されていた)
--     5) 同じ契約の有効な redemption を終了 -> 6) 新しい redemption を INSERT                  <- act
--     7) personal_subscriptions.active_coupon_redemption_id を更新
--   問題は 2 つ。
--     a) 3) の COUNT と 6) の INSERT の間にロックが無く、同じクーポン・同じユーザー (別の契約宛) への適用が
--        同時に 2 本来ると、どちらも COUNT を通って per_user_limit=1 でも redemption が 2 件できる。
--        coupon_redemptions に (coupon_id, user_id) の UNIQUE は無い (per_user_limit は 1 以外も取れるので置けない)。
--        既存の idx_coupon_redemptions_active_per_subscription は「同じ契約」宛の同時 2 件しか弾かない。
--     b) 5) と 6) は別々の HTTP 呼び出しで、6) が失敗すると、catch が戻すのは uses_count だけ。
--        旧 redemption は終了したまま、新しいものが無い状態 (割引が黙って消える) が残り得る。
--
-- 変更 (public.apply_coupon を 1 本追加するだけ。テーブル・制約・インデックス・既存データには触れない):
--   上の 1)〜7) を、1 つの関数 = 1 トランザクションの中で次の順に行う。
--     1. coupons の行を SELECT ... FOR UPDATE でロックする (同じクーポンの適用はここで直列化される。
--        per_user_limit・組織上限・max_uses の COUNT / 比較は、ロックを取った後の最新の状態を見る)
--     2. クーポンの有効性 (status / 有効期間 / 適用対象) を検証する
--     3. 対象の契約行 (個人は personal_subscriptions、組織は organizations) を FOR NO KEY UPDATE でロックして読み、
--        プランと月額を解決する (「同じ契約への別クーポンの同時適用」はここで直列化される。FOR NO KEY UPDATE は
--        外部キーの検査 (FOR KEY SHARE) を邪魔しない)
--     4. applicable_plans を検証する
--     5. per_user_limit (個人) / 組織の上限 (組織) と max_uses を検証する
--     6. coupons.uses_count を +1 する
--     7. 同じ契約の有効な redemption を終了する (end_reason = 'replaced_by_other_coupon')
--     8. 割引額を計算して新しい redemption を INSERT する
--     9. 個人契約なら personal_subscriptions.active_coupon_redemption_id を更新する
--   途中のどこかで失敗すれば全部ロールバックされる (uses_count の加算も旧 redemption の終了もなかったことになる)。
--   ロックの順序は常に「coupons -> 契約行」なので、デッドロックしない
--   (別クーポン同士は契約行で待つだけで、互いに相手のクーポン行を待たない)。
--
-- 従来の API との互換 (src/lib/plan/coupon.ts の applyCoupon のエラーコードと検証順序をそのまま写している):
--   - 検証の順序: クーポンの有無 -> status -> 有効開始 -> 有効期限 -> 適用対象 (個人 / 組織) -> 契約の有無 -> プランの有無
--                 -> applicable_plans -> per_user_limit (組織上限) -> max_uses
--   - per_user_limit の数え方: そのクーポンの redemption のうち、同じユーザー (組織宛なら同じ組織) のもの。
--     置き換えられて終了した redemption も 1 回と数える (従来どおり)。
--   - 置き換えられた側のクーポンの uses_count は戻さない (従来どおり)。
--   - 割引額: 月額が 0 以下なら 0。定率は floor(月額 x 率 / 100)、定額はそのまま。どちらも 0 以上 月額以下に丸める。
--     (JS の浮動小数点ではなく numeric で計算するので、小数の率でも誤差が出ない)
--   - 違いは次の 2 点だけ。
--     (1) 従来は personal_subscriptions.active_coupon_redemption_id の更新に失敗しても redemption は残っていた (ログに出すだけ)。
--         今は 1 トランザクションなので、更新に失敗したら適用全体がなかったことになる。
--     (2) 同時に来たときの結果。従来は上限を超えて適用できたり、同じ契約宛の同時 2 件で UNIQUE 違反 (23505。route では 500) に
--         なったりした。今は直列化され、負けた側は OP_COUPON_LIMIT_REACHED (422) になる。
--         別々のクーポンを同じ契約へ同時に適用したときは、後から入った方が先の方を置き換える (どちらも成功する)。
--
-- エラーの渡し方 (既存の RPC と同じ流儀: RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001'):
--   メッセージにエラーコード、文言が分かれるものは DETAIL に種別を入れる。PostgREST では
--   { code: 'P0001', message: '<コード>', details: '<種別>' } になり、TS 側 (applyCoupon) が従来の CouponApplyError に戻す。
--     OP_COUPON_NOT_FOUND         -                              クーポンが無い
--     OP_COUPON_INVALID           -                              status が active でない
--     OP_COUPON_NOT_YET_VALID     -                              有効開始日の前
--     OP_COUPON_EXPIRED           -                              有効期限切れ
--     OP_COUPON_NOT_APPLICABLE    target / plan                  契約種別が合わない / applicable_plans に無い
--     OP_SUBSCRIPTION_NOT_FOUND   personal / org                 契約 (個人) / 組織が無い
--     OP_PLAN_NOT_FOUND           org_plan_unset / plan          組織に plan が無い / subscription_plans に無い
--     OP_COUPON_LIMIT_REACHED     per_user / per_organization / max_uses
--   引数の誤り (p_target が personal / org 以外、p_approved_by が NULL) は 22023 (invalid_parameter_value)。
--   それ以外の DB エラー (外部キー違反 23503 など) はそのまま返る (TS 側は 500 扱い)。
--
-- 権限: service_role だけ (PUBLIC / anon / authenticated から REVOKE)。
--   呼び出し元の route は requireRole(['super_admin']) を通した後に service-role クライアントで呼ぶ。
--   SECURITY DEFINER + search_path = '' (完全修飾名)。p_approved_by は呼び出し元 (サーバ) が渡す承認者で、
--   クライアントからは渡せない (関数自体を呼べないため)。
--
-- 注意: この migration は関数を 1 本足すだけで、本番のデータは一切書き換えない (UPDATE / DELETE の修復文なし)。
--       新しい Web が apply_coupon を呼ぶので、この migration を先に (または同時に) 本番へ反映すること。
--
-- 冪等: CREATE OR REPLACE FUNCTION。REVOKE / GRANT / COMMENT は何度流しても同じ結果になる。
-- ロールバック: supabase/rollbacks/20261007160700_apply_coupon_rpc.down.sql
--   (先に Web のデプロイを戻すこと。新しい Web のままこの関数だけ消すと、クーポン適用 API が 500 になる)

CREATE OR REPLACE FUNCTION public.apply_coupon(
  p_coupon_id       UUID,
  p_target          TEXT,
  p_subscription_id UUID,
  p_approved_by     UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_coupon        public.coupons%ROWTYPE;
  v_compatible    BOOLEAN;
  v_user_id       UUID;
  v_org_id        UUID;
  v_plan_key      TEXT;
  v_plan_id       UUID;
  v_price_jpy     INTEGER;
  v_used_count    BIGINT;
  v_raw_discount  NUMERIC;
  v_discount_jpy  INTEGER;
  v_redemption_id UUID;
BEGIN
  -- 0. 引数の検証 (route の zod でも弾いているが、RPC 単体でも壊れた値を通さない)
  IF p_target IS NULL OR p_target NOT IN ('personal', 'org') THEN
    RAISE EXCEPTION 'apply_coupon: p_target must be personal or org' USING ERRCODE = '22023';
  END IF;
  IF p_approved_by IS NULL THEN
    RAISE EXCEPTION 'apply_coupon: p_approved_by is required' USING ERRCODE = '22023';
  END IF;

  -- 1. クーポン行をロックして最新の状態を読む。
  --    同じクーポンの適用はここで直列化され、以降の COUNT / 比較はロック後の状態を見る
  --    (READ COMMITTED でも、先に入った適用が commit してロックを手放した後の行が見える)。
  SELECT c.* INTO v_coupon
    FROM public.coupons AS c
   WHERE c.id = p_coupon_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OP_COUPON_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 2. クーポンの有効性
  IF v_coupon.status <> 'active' THEN
    RAISE EXCEPTION 'OP_COUPON_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF now() < v_coupon.valid_from THEN
    RAISE EXCEPTION 'OP_COUPON_NOT_YET_VALID' USING ERRCODE = 'P0001';
  END IF;
  IF now() > v_coupon.valid_until THEN
    RAISE EXCEPTION 'OP_COUPON_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  IF v_coupon.applicable_to <> 'all' THEN
    IF p_target = 'org' THEN
      v_compatible := (v_coupon.applicable_to = 'org');
    ELSE
      v_compatible := (v_coupon.applicable_to IN ('personal', 'family'));
    END IF;
    IF NOT v_compatible THEN
      RAISE EXCEPTION 'OP_COUPON_NOT_APPLICABLE' USING ERRCODE = 'P0001', DETAIL = 'target';
    END IF;
  END IF;

  -- 3. 対象の契約をロックして読み、プランと現在の月額を解決する。
  --    p_subscription_id は、個人なら personal_subscriptions.id、組織なら organizations.id。
  --    ロック順序は常に coupons -> 契約行 (デッドロックしない)。
  IF p_target = 'personal' THEN
    SELECT s.user_id, s.plan_key
      INTO v_user_id, v_plan_key
      FROM public.personal_subscriptions AS s
     WHERE s.id = p_subscription_id
       FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OP_SUBSCRIPTION_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'personal';
    END IF;
  ELSE
    -- org_license_pools は plan_key を持たない (ライセンス数のみ管理) ため、組織の契約プランは
    -- organizations.plan (plan_key 相当) を参照する。
    SELECT o.id, o.plan
      INTO v_org_id, v_plan_key
      FROM public.organizations AS o
     WHERE o.id = p_subscription_id
       FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OP_SUBSCRIPTION_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'org';
    END IF;
    IF v_plan_key IS NULL THEN
      RAISE EXCEPTION 'OP_PLAN_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'org_plan_unset';
    END IF;
  END IF;

  SELECT sp.id, sp.monthly_price_jpy
    INTO v_plan_id, v_price_jpy
    FROM public.subscription_plans AS sp
   WHERE sp.plan_key = v_plan_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OP_PLAN_NOT_FOUND' USING ERRCODE = 'P0001', DETAIL = 'plan';
  END IF;
  v_price_jpy := COALESCE(v_price_jpy, 0);

  -- 4. applicable_plans (空配列なら全プラン対象)
  IF COALESCE(cardinality(v_coupon.applicable_plans), 0) > 0
     AND NOT (v_plan_id = ANY (v_coupon.applicable_plans)) THEN
    RAISE EXCEPTION 'OP_COUPON_NOT_APPLICABLE' USING ERRCODE = 'P0001', DETAIL = 'plan';
  END IF;

  -- 5. 利用上限。クーポン行をロック済みなので、ここで数えた件数は INSERT までの間に変わらない。
  --    置き換えられて終了した redemption も 1 回と数える (従来どおり)。
  IF p_target = 'personal' THEN
    SELECT count(*) INTO v_used_count
      FROM public.coupon_redemptions AS r
     WHERE r.coupon_id = v_coupon.id
       AND r.user_id = v_user_id;
    IF v_used_count >= v_coupon.per_user_limit THEN
      RAISE EXCEPTION 'OP_COUPON_LIMIT_REACHED' USING ERRCODE = 'P0001', DETAIL = 'per_user';
    END IF;
  ELSE
    SELECT count(*) INTO v_used_count
      FROM public.coupon_redemptions AS r
     WHERE r.coupon_id = v_coupon.id
       AND r.organization_id = v_org_id;
    IF v_used_count >= v_coupon.per_user_limit THEN
      RAISE EXCEPTION 'OP_COUPON_LIMIT_REACHED' USING ERRCODE = 'P0001', DETAIL = 'per_organization';
    END IF;
  END IF;

  IF v_coupon.max_uses IS NOT NULL AND v_coupon.uses_count >= v_coupon.max_uses THEN
    RAISE EXCEPTION 'OP_COUPON_LIMIT_REACHED' USING ERRCODE = 'P0001', DETAIL = 'max_uses';
  END IF;

  -- 6. 利用回数を +1 (以降のどこかで失敗すれば、このトランザクションごと戻る)
  UPDATE public.coupons AS c
     SET uses_count = c.uses_count + 1
   WHERE c.id = v_coupon.id;

  -- 7. 同じ契約の有効な適用を終了する (1 契約につき ended_at IS NULL は常に 1 件まで)
  UPDATE public.coupon_redemptions AS r
     SET ended_at = now(),
         end_reason = 'replaced_by_other_coupon'
   WHERE r.subscription_target = p_target
     AND r.applied_to_subscription_id = p_subscription_id
     AND r.ended_at IS NULL;

  -- 8. 割引額 (JPY は小数を持たないので floor。0 以上、月額以下)
  IF v_price_jpy <= 0 THEN
    v_discount_jpy := 0;
  ELSE
    IF v_coupon.discount_type = 'percentage' THEN
      v_raw_discount := (v_price_jpy * v_coupon.discount_value) / 100;
    ELSE
      v_raw_discount := v_coupon.discount_value;
    END IF;
    v_discount_jpy := GREATEST(0, LEAST(floor(v_raw_discount), v_price_jpy))::INTEGER;
  END IF;

  -- 遡及適用 (applied_retroactively = true、approved_by = 承認した super_admin)
  INSERT INTO public.coupon_redemptions (
    coupon_id,
    user_id,
    organization_id,
    subscription_target,
    applied_to_subscription_id,
    discount_amount_jpy,
    duration_months,
    applied_retroactively,
    approved_by
  ) VALUES (
    v_coupon.id,
    v_user_id,
    v_org_id,
    p_target,
    p_subscription_id,
    v_discount_jpy,
    v_coupon.duration_months,
    true,
    p_approved_by
  )
  RETURNING id INTO v_redemption_id;

  -- 9. 個人契約は、有効な適用への参照を更新する (組織には該当する列が無い)
  IF p_target = 'personal' THEN
    UPDATE public.personal_subscriptions AS s
       SET active_coupon_redemption_id = v_redemption_id
     WHERE s.id = p_subscription_id;
  END IF;

  RETURN jsonb_build_object(
    'redemption_id', v_redemption_id,
    'discount_amount_jpy', v_discount_jpy,
    'duration_months', v_coupon.duration_months
  );
END
$$;

-- 関数の権限: service_role のみ。
-- Supabase は関数作成時に anon / authenticated / service_role へ EXECUTE を自動付与し、PUBLIC にも EXECUTE が付く。
-- 引数の型まで含めた完全形で REVOKE する (20261007150300_native_bridge_codes.sql と同じ理屈)。
REVOKE ALL ON FUNCTION public.apply_coupon(UUID, TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_coupon(UUID, TEXT, UUID, UUID)
  TO service_role;

COMMENT ON FUNCTION public.apply_coupon(UUID, TEXT, UUID, UUID) IS
  '#1224: クーポンを契約 (個人: personal_subscriptions / 組織: organizations) に遡及適用する。検証・利用回数の加算・旧 redemption の終了・新規 redemption・契約の参照更新を 1 トランザクションで行い、coupons 行のロックで per_user_limit / 組織上限 / max_uses の競合を防ぐ。業務エラーは RAISE EXCEPTION ''OP_*'' (P0001, DETAIL に種別)。service_role のみ。';
