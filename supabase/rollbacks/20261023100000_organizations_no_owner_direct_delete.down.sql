-- rollback: 20261023100000_organizations_no_owner_direct_delete.sql
-- #1917 の続きで外した、organizations へのオーナーの直接の DELETE のポリシーと anon の DELETE の権限を、元に戻す。
-- ポリシーの名前・種類・対象のロール・式は、本番のベースライン (20251126124224_create_meal_planner_tables.sql:10686) と同じ。
-- 権限は、同じベースラインの :13770 が anon に付けていた DELETE の権限だけを付け直す。
-- TRUNCATE は付け直さない: 本冊の適用の直前の時点で、20261022190000_db_privilege_hardening.sql が anon / authenticated から
-- 外してある (本冊は TRUNCATE に触れていない)。authenticated の DELETE の権限は本冊が外していないので、触れない。
-- (tests/organizations-no-owner-direct-delete-migration-contract.test.ts が、ベースラインの行との一致と、流した後の状態が
--  本冊の直前の状態と同じことを見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、組織のオーナーが組織の行を直接 DELETE できるようになり (所属の列を持つ人が残っていない組織)、部署・招待・
--     チャレンジ・席数などの子の記録が CASCADE で消え、解散の RPC (知らせ・監査) を通らない穴が再び開く。
--   - アプリ (組織をやめるのは解散の RPC だけ) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する。GRANT は何度流しても同じ)。

SET LOCAL lock_timeout = '10s';

GRANT DELETE ON TABLE public.organizations TO anon;

DROP POLICY IF EXISTS organizations_delete_owner ON public.organizations;
CREATE POLICY "organizations_delete_owner" ON "public"."organizations" FOR DELETE USING (("owner_id" = "auth"."uid"()));
