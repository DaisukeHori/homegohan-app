-- migration: 20261022170000_org_plan_operator_only.sql
-- #1912 組織のプランの段階は運営だけが変える
--
-- 背景:
--   オーナーの選択 (2026-10-22・選択式)「運営だけが変える (推奨)」: 「組織の管理者の設定画面では段階を表示だけにし、
--   変更は運営の画面からだけにする (組織の契約は運営が決める)」。
--   それまでは、組織の owner / admin が、組織の設定 (PUT /api/org/settings) と、JWT で PostgREST (/rest/v1/organizations) から
--   直接 UPDATE する経路 (RLS organizations_update_admin) で、自分の組織の organizations.plan を standard / premium / enterprise の
--   どれにでも変えられた。20261021110000_org_plan_ai_daily_limits.sql のトリガー関数 guard_organizations_plan_value は、
--   変えた先をその 3 つに限るだけで、変えること自体は止めなかった。運営が段階ごとに AI の上限 (ai_daily_limits) を変えると、
--   組織の管理者が支払いなしで上の段階を選べる。
--
-- 変えるもの:
--   トリガー関数 guard_organizations_plan_value の本体だけを作り直す (CREATE OR REPLACE。signature・SECURITY INVOKER・
--   search_path・所有者・EXECUTE の権限 (誰にも無い)・トリガー trg_guard_organizations_plan_value は変わらない)。
--   ログインした利用者 (authenticated) と anon が plan を変えるときは、変えた先の値に関わらず ORG_PLAN_OPERATOR_ONLY (42501) で拒む。
--   止めないもの (20261021110000 の定義と同じ):
--     - service_role の書き込み (運営の組織の作成 POST /api/admin/organizations・運営のプランの変更 PATCH /api/admin/organizations/{id}・
--       テストのフィクスチャ) と、SECURITY DEFINER の関数の中の書き込み (current_user が関数の所有者になる)
--     - plan を変えない UPDATE (組織名の変更など。plan に今と同じ値を書く UPDATE も通す)
--   INSERT は止めない: authenticated / anon には organizations の INSERT のポリシーが無く、RLS が拒む。
-- アプリの側: PUT /api/org/settings は本文に plan があれば 400 VALIDATION_ERROR (src/lib/org-settings-api.ts)。
-- データ・テーブル・ほかの関数は変えない。
-- 冪等: CREATE OR REPLACE FUNCTION と COMMENT ON FUNCTION のため、2 回続けて流してもエラーにならない。
-- 確認: tests/org-plan-operator-only-migration-contract.test.ts (最新の定義の本体・戻し口が直前の定義と逐語で同じこと)・
--       tests/integration/rls/ai-plan-feature-caps-rpc.test.ts (owner / admin の JWT の直接の UPDATE が 42501・service_role は変えられる)
-- 戻し方: supabase/rollbacks/20261022170000_org_plan_operator_only.down.sql

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.guard_organizations_plan_value()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  -- 組織のプランの段階は運営だけが変える (#1912)。ログインした利用者と anon は、どの値へも変えられない
  IF current_user IN ('authenticated', 'anon') AND NEW.plan IS DISTINCT FROM OLD.plan THEN
    RAISE EXCEPTION 'ORG_PLAN_OPERATOR_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.guard_organizations_plan_value() IS
  '#1912: 組織のプランの段階は運営だけが変える。ログインした利用者 (authenticated) と anon が organizations.plan を変えると ORG_PLAN_OPERATOR_ONLY (42501)。service_role と SECURITY DEFINER の関数の中の書き込み・plan を変えない UPDATE は止めない';
