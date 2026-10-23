-- migration: 20261021110000_org_plan_ai_daily_limits.sql
-- #1912 段 A の整合ゲートの指摘: 組織のプランの値 'premium'・'enterprise' に AI の 1 日の上限の行が無い
--
-- 背景:
--   billing/03 §6.5 (5a)・§0.5 Q-2・§0.6 は「組織の利用者の 1 日の上限は変えない (これから作る組織も同じ上限)」と定める。
--   20261021100000_billing_paid_plans_iap.sql の (5a) は、free を 3 にする前に、組織の plan の値 (organizations.plan の既存の値・
--   列の既定 'standard'・subscription_plans の plan_type = 'org' の行) に、いまの free の値 (10) を行として写した。
--   organizations.plan を書く経路は 3 つある:
--     a. 運営の組織の作成 POST /api/admin/organizations (service_role。本文を Zod で ORG_PLAN_VALUES に限る)
--     b. 組織の設定 PUT /api/org/settings (owner / admin の JWT。本文を Zod で ORG_PLAN_VALUES に限る。RLS organizations_update_admin 経由)
--     c. owner / admin の JWT で PostgREST (/rest/v1/organizations) から直接 UPDATE する (b と同じ RLS と権限。アプリの Zod を通らない)
--   ORG_PLAN_VALUES (src/lib/org-plans.ts) は 'standard'・'premium'・'enterprise' の 3 つ。このうち 'premium' と 'enterprise' は
--   本番の組織がまだ無いので (5a) の写す先に入らず、行が無い。get_effective_plan は、個人の契約も家族も無い組織の利用者に
--   organizations.plan をそのまま返し、consume_ai_usage_at は行の無いプランを free の行 (3) で判定するので、運営がこれから
--   'premium' / 'enterprise' の組織を作ると、そのメンバーの上限が 10 から 3 に下がる。
--   さらに c の経路は値を限っていなかった (organizations.plan は CHECK の無い text で、guard_organizations_privileged は
--   owner_id と status だけを止める)。owner / admin が plan を 'pro' / 'family_pro' などの有料の plan_key にすると、
--   get_effective_plan がそれを返し、組織のメンバーと自分が支払い無しで有料の上限と機能の枠を得る。行の無い値 (任意の文字列) に
--   すると free の 3 で判定される。
--
-- 足すもの:
--   1. ai_daily_limits に 'premium' と 'enterprise' の行 (daily_limit = 10)。
--      10 = 組織の利用者のいまの 1 日の上限 (20261011020000_ai_daily_limits.sql の既定の行の値で、(5a) が 'standard'・org_* に写した値)。
--      既に行があれば上書きしない (運営が画面で値を決めていれば、その値を残す)。
--   2. トリガー関数 guard_organizations_plan_value と BEFORE UPDATE OF plan のトリガー trg_guard_organizations_plan_value。
--      ログインした利用者 (authenticated) と anon が plan を変えるときは、変えた先を ORG_PLAN_VALUES の 3 つに限る
--      (NULL・有料の plan_key・行の無い値は ORG_PLAN_NOT_ALLOWED (42501) で拒む)。b の経路 (Zod で同じ 3 つに限る) は変わらない。
--      service_role (a・運営の作業・テストのフィクスチャ) と SECURITY DEFINER の関数の中の書き込みは止めない
--      (既存の guard_organizations_privileged と同じ current_user の見分け方)。plan を変えない UPDATE (名前の変更など) は止めない。
--      INSERT は止めない: authenticated / anon には organizations の INSERT のポリシーが無く、RLS が拒む。
-- 既存の行・関数・トリガー・テーブルは変えない。行を消さない (追加だけ)。
-- 冪等: INSERT ... ON CONFLICT (plan_key) DO NOTHING / CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER。
-- 確認: tests/org-plan-ai-daily-limits-contract.test.ts (ORG_PLAN_VALUES のすべての値に行と 10 があること・トリガーの許す値が
--       ORG_PLAN_VALUES と同じであること)・
--       tests/integration/rls/ai-plan-feature-caps-rpc.test.ts (DB の行と、'premium' / 'enterprise' の組織のメンバーの判定・
--       owner / admin の JWT による plan の直接の UPDATE が ORG_PLAN_VALUES の外へは拒まれること)
-- 戻し方: supabase/rollbacks/20261021110000_org_plan_ai_daily_limits.down.sql

SET LOCAL lock_timeout = '10s';

INSERT INTO public.ai_daily_limits (plan_key, daily_limit)
VALUES ('premium', 10), ('enterprise', 10)
ON CONFLICT (plan_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_organizations_plan_value()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NEW.plan IS DISTINCT FROM OLD.plan THEN
    -- 許す値は src/lib/org-plans.ts の ORG_PLAN_VALUES と同じ (tests/org-plan-ai-daily-limits-contract.test.ts が突き合わせる)
    IF NEW.plan IS NULL OR NEW.plan NOT IN ('standard', 'premium', 'enterprise') THEN
      RAISE EXCEPTION 'ORG_PLAN_NOT_ALLOWED' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.guard_organizations_plan_value() IS
  '#1912: ログインした利用者 (authenticated) と anon が organizations.plan を変えるときは、変えた先を standard / premium / enterprise (src/lib/org-plans.ts の ORG_PLAN_VALUES) に限る。NULL や有料の plan_key は ORG_PLAN_NOT_ALLOWED (42501)。service_role と SECURITY DEFINER の関数の中の書き込みは止めない';

-- トリガーとして動くときは EXECUTE を確かめない。RPC としては呼べないので、誰にも EXECUTE を付けない
REVOKE ALL ON FUNCTION public.guard_organizations_plan_value() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE TRIGGER trg_guard_organizations_plan_value
  BEFORE UPDATE OF plan ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.guard_organizations_plan_value();
