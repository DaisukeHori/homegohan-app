-- rollback: 20261022200000_family_groups_no_direct_delete.sql
-- #1917 で外した、family_groups への利用者 (anon / authenticated) からの DELETE のポリシーと権限を、元に戻す。
-- ポリシーの名前・種類・対象のロール・式は、本番のベースライン (20251126124224_create_meal_planner_tables.sql:10352) と同じ。
-- 権限は、同じベースラインの :13588-13589 が anon / authenticated に付けていた DELETE・TRUNCATE の権限を付け直す。
-- (tests/family-groups-no-direct-delete-migration-contract.test.ts が、ベースラインの行との一致を見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、家族の代表者が家族の行を直接 DELETE できるようになり、保護者の同意の記録 (parental_consents) が CASCADE で消え、
--     解散の RPC (通知・監査) を通らない穴が再び開く。
--   - アプリ (家族の削除は解散の RPC だけ) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する。GRANT は何度流しても同じ)。

SET LOCAL lock_timeout = '10s';

GRANT DELETE, TRUNCATE ON TABLE public.family_groups TO anon, authenticated;

DROP POLICY IF EXISTS family_groups_delete_representative ON public.family_groups;
CREATE POLICY "family_groups_delete_representative" ON "public"."family_groups" FOR DELETE USING (("representative_id" = "auth"."uid"()));
