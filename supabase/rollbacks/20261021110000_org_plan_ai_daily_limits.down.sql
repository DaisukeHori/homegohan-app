-- rollback: 20261021110000_org_plan_ai_daily_limits.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの: migration が足した ai_daily_limits の 'premium' と 'enterprise' の行のうち、運営が画面で変えていない
--   (updated_by IS NULL) 行だけを消す。運営が値を保存した行は運営の決定なので残す。
-- 戻したあと: 'premium' / 'enterprise' の組織のメンバー (個人の契約も家族も無い人) は free の行の値で判定される。
-- 順序: 20261021100000_billing_paid_plans_iap.down.sql より先に流す (新しい migration から順に戻す)。
-- 冪等: DELETE は 2 回目は何も消さない。

SET LOCAL lock_timeout = '10s';

DELETE FROM public.ai_daily_limits AS l
 WHERE l.updated_by IS NULL
   AND l.plan_key IN ('premium', 'enterprise');
