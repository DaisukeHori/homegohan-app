-- rollback: 20261030160000_plan_stripe_product_id_price_change_guard.sql
-- #2112 Z1-1 で足した、価格の変更が進行中のあいだプランの stripe_product_id を変えさせないトリガー
-- trg_guard_plan_stripe_product_id_price_change と、その関数 guard_plan_stripe_product_id_price_change() を消す。
-- 表・ポリシー・既存の関数・行には触れていないので、戻すのはトリガーと関数だけ。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、価格の変更 (Stripe の Price の作成) が進行中のあいだも、PATCH /api/super-admin/plans/{id} が公開中・非公開のプランの
--     stripe_product_id を書けるようになる (Price ID がまだ NULL なら)。進行中の価格の変更が作った Price と、DB の商品が食い違いうる。
--     route の 409 OP_PLAN_PRICE_CHANGE_IN_PROGRESS は出なくなる (ほかの応答は変わらない)。
--   - 消える行は無い。
--
-- 何度流しても同じ結果になる (冪等: DROP TRIGGER IF EXISTS・DROP FUNCTION IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS trg_guard_plan_stripe_product_id_price_change ON public.subscription_plans;
DROP FUNCTION IF EXISTS public.guard_plan_stripe_product_id_price_change();
