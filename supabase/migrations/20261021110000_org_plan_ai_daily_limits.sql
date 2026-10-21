-- migration: 20261021110000_org_plan_ai_daily_limits.sql
-- #1912 段 A の整合ゲートの指摘: 組織のプランの値 'premium'・'enterprise' に AI の 1 日の上限の行が無い
--
-- 背景:
--   billing/03 §6.5 (5a)・§0.5 Q-2・§0.6 は「組織の利用者の 1 日の上限は変えない (これから作る組織も同じ上限)」と定める。
--   20261021100000_billing_paid_plans_iap.sql の (5a) は、free を 3 にする前に、組織の plan の値 (organizations.plan の既存の値・
--   列の既定 'standard'・subscription_plans の plan_type = 'org' の行) に、いまの free の値 (10) を行として写した。
--   アプリが organizations.plan に書ける値は 'standard'・'premium'・'enterprise' の 3 つ (src/lib/org-plans.ts の ORG_PLAN_VALUES。
--   運営の組織の作成 POST /api/admin/organizations と組織の設定 PUT /api/org/settings が使う)。このうち 'premium' と 'enterprise' は
--   本番の組織がまだ無いので (5a) の写す先に入らず、行が無い。get_effective_plan は、個人の契約も家族も無い組織の利用者に
--   organizations.plan をそのまま返し、consume_ai_usage_at は行の無いプランを free の行 (3) で判定するので、運営がこれから
--   'premium' / 'enterprise' の組織を作ると、そのメンバーの上限が 10 から 3 に下がる。
--
-- 足すもの: ai_daily_limits に 'premium' と 'enterprise' の行 (daily_limit = 10)。
--   10 = 組織の利用者のいまの 1 日の上限 (20261011020000_ai_daily_limits.sql の既定の行の値で、(5a) が 'standard'・org_* に写した値)。
--   既に行があれば上書きしない (運営が画面で値を決めていれば、その値を残す)。
-- 既存の行・関数・テーブルは変えない。行を消さない (追加だけ)。
-- 冪等: INSERT ... ON CONFLICT (plan_key) DO NOTHING。
-- 確認: tests/org-plan-ai-daily-limits-contract.test.ts (ORG_PLAN_VALUES のすべての値に行と 10 があること)・
--       tests/integration/rls/ai-plan-feature-caps-rpc.test.ts (DB の行と、'premium' の組織のメンバーの判定)
-- 戻し方: supabase/rollbacks/20261021110000_org_plan_ai_daily_limits.down.sql

SET LOCAL lock_timeout = '10s';

INSERT INTO public.ai_daily_limits (plan_key, daily_limit)
VALUES ('premium', 10), ('enterprise', 10)
ON CONFLICT (plan_key) DO NOTHING;
