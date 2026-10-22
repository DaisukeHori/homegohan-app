-- rollback: 20261022190000_db_privilege_hardening.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの:
--   1. トリガー関数 guard_organizations_privileged を、この migration より前の最新の定義
--      (20251126124224_create_meal_planner_tables.sql:1826-1837。owner_id と status だけを守る) に逐語で戻す
--      (tests/db-privilege-hardening-migration-contract.test.ts が、その行との逐語の一致を見る)。
--      トリガー・SECURITY INVOKER・search_path の指定なし・所有者・EXECUTE の権限は、戻す前後で変わらない (CREATE OR REPLACE)。
--   2. 既定の権限 (ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public) の anon / authenticated の TRUNCATE を付け直す
--      (ベースライン :13070-13071 の GRANT ALL ON TABLES と同じ状態)。
--   3. public の表・ビューの anon / authenticated の TRUNCATE を付け直す。この migration の前に TRUNCATE を持っていた表だけに付けるため、
--      次の 3 つを満たす (表, ロール) にだけ GRANT する:
--        a. そのロールが REFERENCES と TRIGGER の両方を持つ。ベースラインの GRANT ALL (と既定の権限) は 2 つを TRUNCATE と一緒に付け、
--           後の migration で REVOKE ALL のあとに付け直す権限 (SELECT / INSERT / UPDATE / DELETE の組み合わせ) は 2 つを含まない
--           (= REVOKE ALL で TRUNCATE ごと外した表は対象にならない)。
--        b. この migration より前に TRUNCATE だけを個別に外した表 (REVOKE ... TRUNCATE。REFERENCES と TRIGGER は残っている) ではない:
--           weekly_menu_requests・meal_image_jobs (20261011010000)・family_invites (20261022150000)・
--           org_license_pools・organization_invites (20261022180000)。
--        c. 後の 20261022200000_family_groups_no_direct_delete.sql が DELETE と TRUNCATE を外した family_groups は、
--           そのロールが family_groups の DELETE を持たない間 (= 200000 が残っている間) は付けない。
--           200000 の戻し口は DELETE だけを付け直し TRUNCATE は付けない (200000 の適用の直前には、この migration が外していて無い) ので、
--           新しい順 (200000 → この migration) に戻したときは、ここで family_groups にも TRUNCATE が付き、この migration の
--           直前の状態 (ベースラインの DELETE・TRUNCATE) に戻る。200000 を戻さずにこの migration だけを先に戻したとき (順序外の戻し) は、
--           family_groups に TRUNCATE を付けない (200000 が外した TRUNCATE を、200000 が残ったまま付け直さない)。
--      (tests/db-privilege-hardening-migration-contract.test.ts が、b の一覧が migration の REVOKE ... TRUNCATE の対象と一致すること、
--       a の前提 (REVOKE ALL のあとに REFERENCES / TRIGGER / ALL を利用者へ付け直す migration が無いこと)・c の条件を文面で見る)
--   戻す順: 戻し口は新しい順に流す。b の 5 表の TRUNCATE は、それぞれの migration の戻し口 (20261011010000・20261022150000・
--   20261022180000) が付け直す。a で対象にならない表 (この migration より前に REVOKE ALL で TRUNCATE ごと外した表) のうち、
--   20261010090000・20261016190000・20261016243000 の戻し口は、権限を GRANT ALL で戻すので TRUNCATE ごと付け直す。
--   この migration を戻さずにそれらの戻し口を先に流すと、その表に TRUNCATE が付く (この migration の不変条件を破る)。
--   それらの戻し口の冒頭にも同じことを書いてある。
--   (tests/db-privilege-hardening-migration-contract.test.ts が、この migration より後の戻し口が利用者へ表の TRUNCATE を付けないこと、
--    前の戻し口のうち利用者へ表の TRUNCATE (ALL を含む) を付けるものが、この 6 本だけであることを文面で見る)
-- ⚠️ 戻すと、組織の owner / admin がまた自分の組織の subscription_status / subscription_expires_at / dissolved_at を
--   PostgREST の直接の UPDATE で書けるようになり、anon / authenticated に RLS の効かない TRUNCATE の権限が戻る。緊急時の切り戻し専用。
-- データは戻さない (この migration はデータを変えていない)。
-- 冪等: CREATE OR REPLACE FUNCTION・ALTER DEFAULT PRIVILEGES ... GRANT・持っていない表だけへの GRANT のため、何度流しても同じ結果になる。

SET LOCAL lock_timeout = '10s';

-- 1. guard_organizations_privileged: 20251126124224_create_meal_planner_tables.sql:1826-1837 を逐語で戻す
CREATE OR REPLACE FUNCTION "public"."guard_organizations_privileged"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.status  IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 2. 既定の権限
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE ON TABLES TO anon, authenticated;

-- 3. 表・ビューの TRUNCATE
DO $$
DECLARE
  v_role text;
  v_rel regclass;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOR v_rel IN
      SELECT c.oid::regclass
        FROM pg_catalog.pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND c.relname <> ALL (ARRAY['weekly_menu_requests', 'meal_image_jobs', 'family_invites', 'org_license_pools', 'organization_invites'])
         -- c. family_groups は、200000 が残っている間 (そのロールが DELETE を持たない間) は付けない
         AND NOT (c.relname = 'family_groups' AND NOT pg_catalog.has_table_privilege(v_role, c.oid, 'DELETE'))
         AND pg_catalog.has_table_privilege(v_role, c.oid, 'REFERENCES')
         AND pg_catalog.has_table_privilege(v_role, c.oid, 'TRIGGER')
         AND NOT pg_catalog.has_table_privilege(v_role, c.oid, 'TRUNCATE')
       ORDER BY c.relname
    LOOP
      EXECUTE pg_catalog.format('GRANT TRUNCATE ON TABLE %s TO %I', v_rel, v_role);
    END LOOP;
  END LOOP;
END $$;
