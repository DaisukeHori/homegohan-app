-- rollback: 20261022170000_org_plan_operator_only.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの: トリガー関数 guard_organizations_plan_value の本体と説明 (COMMENT) を、この migration より前の最新の定義
--   (20261021110000_org_plan_ai_daily_limits.sql) に逐語で戻す
--   (tests/org-plan-operator-only-migration-contract.test.ts が、その定義との逐語の一致を見る)。
--   トリガー・signature・SECURITY INVOKER・search_path・所有者・EXECUTE の権限は、戻す前後で変わらない (CREATE OR REPLACE)。
-- ⚠️ 戻すと、組織の owner / admin がまた自分の組織の plan を standard / premium / enterprise のどれにでも変えられる
--   (JWT で PostgREST から直接 UPDATE する経路。値の外 (有料の plan_key・NULL) は ORG_PLAN_NOT_ALLOWED (42501) で拒む)。
--   PUT /api/org/settings の 400 (アプリの側) は残る。
-- データは戻さない (この migration はデータを変えていない)。
-- 順序: 20261021110000_org_plan_ai_daily_limits.down.sql より先に流す (新しい migration から順に戻す)。
-- 冪等: CREATE OR REPLACE FUNCTION と COMMENT ON FUNCTION のため、2 回続けて流してもエラーにならない。

SET LOCAL lock_timeout = '10s';

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
