-- migration: 20261022190000_db_privilege_hardening.sql
-- 戻し方: supabase/rollbacks/20261022190000_db_privilege_hardening.down.sql
-- #1917 の整合ゲート (wf_73452862-26e) の候補で、仕分け (wf_ab67cabd-bbe) が製品の欠陥と判定した 2 件を直す。
--
-- 背景:
--   (A) 組織の owner / admin が、契約の状態と期限の列 (subscription_status / subscription_expires_at) と解散の時刻
--       (dissolved_at) を PostgREST の直接の UPDATE で書けた。
--       RLS organizations_update_admin (20251126124224_create_meal_planner_tables.sql:10702) は owner / admin に列を限らない
--       UPDATE を許し、トリガー関数 guard_organizations_privileged (同 :1826-1837。後の migration での置き換えは無い) は
--       owner_id と status だけ、guard_organizations_plan_value (20261022170000) は plan だけを止めていた
--       (20261022180000_org_tables_rpc_only_writes.sql:74-77 の「同じ型の全域の探索」に書いた残り)。
--       これらの列は表示用で (組織の設定の画面 src/app/(org)/org/settings/page.tsx の契約の状態・期限)、利用者が書く理由が無い。
--   (B) ベースラインの GRANT ALL (と Supabase の既定の権限) で、public のほとんどの表に anon / authenticated の TRUNCATE が残っている。
--       PostgREST からは TRUNCATE を出せず、届く経路は見当たらないが、TRUNCATE は RLS の効かない書き込み (全行の削除) で、
--       どの表でも利用者に要らない。個別に外したのは weekly_menu_requests・meal_image_jobs (20261011010000)・family_invites
--       (20261022150000)・org_license_pools・organization_invites (20261022180000) だけだった。
--
-- 変更:
--   1. guard_organizations_privileged の本文に、subscription_status・subscription_expires_at・dissolved_at を足す。
--      ログインユーザー (current_user が authenticated / anon) がこれらを変えると、既存と同じ
--      CANNOT_MODIFY_PRIVILEGED_COLUMN (42501) で拒む。値を変えない UPDATE (組織名の変更など。同じ値を書く UPDATE も) は止めない。
--      service_role と SECURITY DEFINER の関数の中 (current_user が関数の所有者 postgres になる) は今までどおり通る。
--      20261019120000_self_dissolve.sql の 6 (guard_family_groups_privileged に status / dissolved_at を足した) と同じ形:
--      SECURITY INVOKER のまま・search_path の指定なしのまま・トリガー trg_guard_organizations_privileged と RLS と GRANT は変えない
--      (CREATE OR REPLACE は所有者と EXECUTE の権限を引き継ぐ)。
--      これらの列を書く既存の経路 (origin/main で git grep した):
--        - dissolved_at (と status): 後始末の関数 org_dissolve_apply (20261019120000。SECURITY INVOKER だが EXECUTE は service_role
--          だけ) を、SECURITY DEFINER の dissolve_org_by_owner / operator_force_dissolve_org (どちらも最新の定義は
--          20261022140000_org_transfer_toctou.sql) が所有者の権限で呼ぶ。どちらも current_user は postgres。
--        - subscription_status / subscription_expires_at: 書く経路は無い (アプリ・Edge Function・cron・migration のどれにも無い。
--          src/lib/org-plans.ts の ORG_SUBSCRIPTION_STATUS_VALUES の説明)。運営が直すときは service_role。
--        - 組織の設定 PUT /api/org/settings (owner / admin の JWT) は、本文を OrgSettingsUpdateSchema で name・industry・
--          employee_count・連絡先などに限り、3 列を送らない。
--      tests/db-privilege-hardening-migration-contract.test.ts が、3 列を書く関数の最新の定義がどれも SECURITY DEFINER か
--      利用者が実行できない関数であることを、migration の文面から機械で確かめる。
--   2. public スキーマの全部の表・ビュー (relkind r / p / v / m / f) について、anon と authenticated から TRUNCATE を外す。
--      SELECT・INSERT・UPDATE・DELETE・REFERENCES・TRIGGER・MAINTAIN と service_role の権限は変えない。
--      持っていない表には REVOKE を出さない (has_table_privilege で確かめてから)。外したあと、1 つでも残っていれば
--      例外で止める (表の所有者が postgres でないなどで外せなかったときに、黙って穴を残さない)。
--   3. 今後 postgres が public に作る表に TRUNCATE が付かないよう、既定の権限 (ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public)
--      から anon と authenticated の TRUNCATE を外す (ベースライン :13069-13072 の GRANT ALL ON TABLES を、TRUNCATE だけ削る)。
--      ほかの権限の既定 (SELECT・INSERT・UPDATE・DELETE・REFERENCES・TRIGGER・MAINTAIN) と、関数・シーケンスの既定は変えない。
--      migration は postgres で流れるので、表の既定は postgres の分だけで足りる。Supabase が持つ supabase_admin の既定の権限は、
--      postgres から変えられない (そのロールのメンバーでない) ので触らない (migration が作る表の所有者は postgres で、使われない)。
--
-- 既存データへの影響: なし (関数の本文・権限・既定の権限の置き換えだけ)。
-- 冪等: CREATE OR REPLACE FUNCTION・持っている表だけへの REVOKE・ALTER DEFAULT PRIVILEGES ... REVOKE のため、2 回続けて流してもエラーにならない。
-- ロック: 表のデータには触れない (関数の本文とカタログの権限 (pg_class.relacl・pg_default_acl) を書き換えるだけ)。
-- 確認: tests/integration/security/db-privilege-hardening.test.ts (実 DB)
--       tests/db-privilege-hardening-migration-contract.test.ts (静的)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261022180000 と同じ)
SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. 組織の行の特権列のガードに subscription_status / subscription_expires_at / dissolved_at を足す
--    (土台 = 20251126124224_create_meal_planner_tables.sql:1826-1837)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_organizations_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    -- 契約の状態と期限・解散の時刻は表示用で、ログインユーザーは直接変更できない。解散は後始末の関数 org_dissolve_apply
    -- (呼ぶのは SECURITY DEFINER の dissolve_org_by_owner / operator_force_dissolve_org) か service_role だけが行う。
    -- RLS organizations_update_admin は owner / admin に列を限らない UPDATE を許すので、ここで止める。
    IF NEW.owner_id                IS DISTINCT FROM OLD.owner_id
       OR NEW.status                  IS DISTINCT FROM OLD.status
       OR NEW.subscription_status     IS DISTINCT FROM OLD.subscription_status
       OR NEW.subscription_expires_at IS DISTINCT FROM OLD.subscription_expires_at
       OR NEW.dissolved_at            IS DISTINCT FROM OLD.dissolved_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ----------------------------------------------------------------
-- 2. public の全部の表・ビューから、anon / authenticated の TRUNCATE を外す
-- ----------------------------------------------------------------
DO $$
DECLARE
  v_rel regclass;
  v_left text;
BEGIN
  FOR v_rel IN
    SELECT c.oid::regclass
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND (pg_catalog.has_table_privilege('anon', c.oid, 'TRUNCATE')
            OR pg_catalog.has_table_privilege('authenticated', c.oid, 'TRUNCATE'))
     ORDER BY c.relname
  LOOP
    EXECUTE pg_catalog.format('REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated', v_rel);
  END LOOP;

  -- 外せなかった表が 1 つでもあれば止める (黙って穴を残さない)
  SELECT pg_catalog.string_agg(c.relname::text, ', ' ORDER BY c.relname)
    INTO v_left
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (pg_catalog.has_table_privilege('anon', c.oid, 'TRUNCATE')
          OR pg_catalog.has_table_privilege('authenticated', c.oid, 'TRUNCATE'));
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'anon / authenticated の TRUNCATE を外せなかった表: %', v_left;
  END IF;
END $$;

-- ----------------------------------------------------------------
-- 3. 今後 postgres が public に作る表の既定の権限から、anon / authenticated の TRUNCATE を外す
-- ----------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
