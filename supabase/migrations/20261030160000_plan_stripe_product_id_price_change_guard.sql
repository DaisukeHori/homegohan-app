-- migration: 20261030160000_plan_stripe_product_id_price_change_guard.sql
-- 戻し方: supabase/rollbacks/20261030160000_plan_stripe_product_id_price_change_guard.down.sql
-- #2112 Z1-1: 価格の変更 (Stripe の Price の作成) が進行中のあいだは、プランの Stripe の商品の ID (stripe_product_id) を変えない。
--
-- 背景:
--   PATCH /api/super-admin/plans/{id} は、公開中・非公開のプランでも、月額・年額のどちらの Stripe の Price もまだ無いあいだだけ
--   stripe_product_id を変えられる (src/lib/super-admin/plans-schemas.ts の isStripeProductIdEditable。販売開始の手順で、公開中のプランに
--   商品の ID を入れるため)。書く条件は「両方の Price ID が NULL のまま」だけで、まだ commit されていない進行中の Price は防げない:
--   価格の変更 (POST /api/super-admin/plans/{id}/price-change) は begin_plan_price_change で予約を取り、ロックの下で読んだプランの
--   stripe_product_id (商品 A) を Edge Function stripe-price-sync に渡して Stripe の Price を作り、apply_plan_price_change が商品を
--   確かめずに stripe_price_id を書く (20261024130000_plan_deprecate_lock_and_price_change_reservation.sql)。その間 (Edge Function の呼び出し中)
--   に PATCH が商品を B (か NULL) に変えると、Price ID がまだ NULL なので書け、最後は stripe_product_id = B で stripe_price_id は
--   商品 A の Price になる (Price は商品に紐づくのに、作ったあとで商品が変わる)。NULL にした場合は Price ID があるので欄が止まり、
--   Product ID が無いので年額の Price も作れなくなる。
--
-- 変更 (関数とトリガーを 1 本ずつ足すだけ。表・ポリシー・既存の関数・行は変えない):
--   subscription_plans の BEFORE UPDATE OF stripe_product_id の行トリガー trg_guard_plan_stripe_product_id_price_change
--   (関数 guard_plan_stripe_product_id_price_change)。stripe_product_id が変わる行で、そのプランに期限内の価格の変更の予約
--   (plan_price_change_reservations。reserved_at が期限 c_stale_after_seconds より新しい) があれば
--   RAISE 'OP_PLAN_PRICE_CHANGE_IN_PROGRESS' (P0001) で止める。route はこれを 409 OP_PLAN_PRICE_CHANGE_IN_PROGRESS に写す。
--   待ち合い: BEFORE UPDATE の行トリガーは、行のロック (FOR NO KEY UPDATE と同じ強さ) を取ってから動く。begin / apply も
--   プランの行を FOR NO KEY UPDATE でロックするので、
--     - begin が commit 前なら、この UPDATE はその commit を待ち、commit の後に予約を読んで止まる
--       (plpgsql の文ごとに新しいスナップショットなので、待った相手の commit が見える)
--     - この UPDATE が先なら、begin はその commit を待ってから、変わった後の商品を読んで Stripe に渡す
--     - apply (予約を消して Price ID を書く) が commit 前なら、この UPDATE はその commit を待ち、route の書く条件
--       (stripe_price_id / stripe_yearly_price_id が NULL) で 0 行になる (route は読み直して 409 CONFLICT_STALE_DATA)
--   期限: begin_plan_price_change が予約を取り直す期限 (route が渡す PRICE_CHANGE_RESERVATION_STALE_SECONDS。
--   src/lib/super-admin/plan-price-change-reservation.ts) と同じ値。期限を過ぎた予約 (route の途中で落ちて消えなかった予約。
--   期限は Vercel の関数が 1 回の要求で動ける時間の上限より長いので、その route はもう apply しない) では止めない
--   (止めると、次の価格の変更が予約を取り直すまで商品の ID を変えられなくなる)。値を変えるときは両方を同じに直す
--   (tests/plan-stripe-product-id-price-change-guard-migration-contract.test.ts が突き合わせる)。
--   商品の ID を変えない UPDATE (価格の変更の apply・表示名などの編集・状態の変更) はトリガーの WHEN で外れるので、予約中でも止めない。
--   SECURITY DEFINER (予約の表は RLS を有効にして利用者の権限を外してある)・search_path = ''。EXECUTE は誰にも与えない (トリガーだけが呼ぶ)。
--
-- 既存データへの影響: なし (トリガーは今後の UPDATE にだけ効く)。
-- 冪等: CREATE OR REPLACE FUNCTION・DROP TRIGGER IF EXISTS → CREATE TRIGGER・REVOKE は何度流しても同じ。
-- 確かめるテスト: tests/plan-stripe-product-id-price-change-guard-migration-contract.test.ts (文面)・
--   tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts の PG-1〜PG-4 (実 DB。待ち合いと結果)・
--   tests/integration/operator/super-admin-plans-id.test.ts (route の 409)・tests/plan-launch-screen-2112.test.tsx (route と画面)

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.guard_plan_stripe_product_id_price_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  -- 予約の期限 (秒)。src/lib/super-admin/plan-price-change-reservation.ts の PRICE_CHANGE_RESERVATION_STALE_SECONDS と同じ値
  -- (begin_plan_price_change が予約を取り直す期限。route が p_stale_after_seconds に渡す)
  c_stale_after_seconds CONSTANT integer := 900;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.plan_price_change_reservations AS r
     WHERE r.plan_id = OLD.id
       AND r.reserved_at > pg_catalog.now() - pg_catalog.make_interval(secs => c_stale_after_seconds)
  ) THEN
    RAISE EXCEPTION 'OP_PLAN_PRICE_CHANGE_IN_PROGRESS' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.guard_plan_stripe_product_id_price_change() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.guard_plan_stripe_product_id_price_change() IS
  '#2112 Z1-1: プランの stripe_product_id を変える UPDATE の中で (行のロックの後)、そのプランに期限内の価格の変更の予約 (plan_price_change_reservations) があれば OP_PLAN_PRICE_CHANGE_IN_PROGRESS (P0001) で止める。進行中の価格の変更が Stripe に渡した商品と、DB の商品が食い違わないようにする。期限 (c_stale_after_seconds) は PRICE_CHANGE_RESERVATION_STALE_SECONDS と同じ';

DROP TRIGGER IF EXISTS trg_guard_plan_stripe_product_id_price_change ON public.subscription_plans;
CREATE TRIGGER trg_guard_plan_stripe_product_id_price_change
  BEFORE UPDATE OF stripe_product_id ON public.subscription_plans
  FOR EACH ROW
  WHEN (NEW.stripe_product_id IS DISTINCT FROM OLD.stripe_product_id)
  EXECUTE FUNCTION public.guard_plan_stripe_product_id_price_change();
