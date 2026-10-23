-- rollback: 20261024110000_plan_deprecate_lock_and_price_change_reservation.sql
-- 廃止の安全弁のトリガーと、価格の変更の予約 (表と関数 3 本) を外す。本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。
-- ⚠️ 先にアプリを戻すこと: POST /api/super-admin/plans/{id}/price-change は begin_plan_price_change / apply_plan_price_change /
--    release_plan_price_change を呼ぶ (無ければ価格の変更が 500 になる)。PATCH /api/super-admin/plans/{id} はトリガーが無くても動く
--    (廃止の前の数え上げは route にも残っている。数えてから書くまでの間の契約を見落とす窓が戻るだけ)。
-- 影響: 予約の表の行 (進行中の価格の変更の予約) は消える。plan_price_history・subscription_plans の行は変えない。
-- 何度流しても同じ結果になる (DROP ... IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS trg_guard_plan_deprecate_subscribers ON public.subscription_plans;
DROP FUNCTION IF EXISTS public.guard_plan_deprecate_subscribers();

DROP FUNCTION IF EXISTS public.release_plan_price_change(uuid, uuid);
DROP FUNCTION IF EXISTS public.apply_plan_price_change(uuid, uuid, integer, integer, text, text, uuid, text, timestamptz, text);
DROP FUNCTION IF EXISTS public.begin_plan_price_change(uuid, integer);
DROP TABLE IF EXISTS public.plan_price_change_reservations;
