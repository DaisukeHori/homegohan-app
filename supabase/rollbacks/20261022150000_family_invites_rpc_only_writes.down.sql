-- rollback: 20261022150000_family_invites_rpc_only_writes.sql
-- #1912 (C36) で外した、family_invites への利用者 (anon / authenticated) からの書き込みのポリシーと権限を、元に戻す。
-- ポリシーの名前・種類・対象のロール・式は、本番のベースライン (20251126124224_create_meal_planner_tables.sql:10367・:10375) と同じ。
-- 権限は、同じベースラインの :13592-13593 が anon / authenticated に付けていた書き込みの権限 (INSERT・UPDATE・DELETE・TRUNCATE) を付け直す。
-- (tests/family-invites-rpc-only-writes-migration-contract.test.ts が、ベースラインの行との一致を見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、家族の代表者・大人が招待の行を直接 INSERT / UPDATE できるようになり、create_family_invite の門
--     (家族プランの門・人数上限・24 時間の作成上限・作成の監査ログ) を通らない穴が再び開く。
--   - アプリ (招待の作成・取り消しは RPC、一覧は SELECT) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する。GRANT は何度流しても同じ)。

SET LOCAL lock_timeout = '10s';

GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.family_invites TO anon, authenticated;

DROP POLICY IF EXISTS family_invites_insert_adult ON public.family_invites;
CREATE POLICY "family_invites_insert_adult" ON "public"."family_invites" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_active_family_adult"("family_id"));

DROP POLICY IF EXISTS family_invites_update_adult ON public.family_invites;
CREATE POLICY "family_invites_update_adult" ON "public"."family_invites" FOR UPDATE TO "authenticated" USING ("public"."is_active_family_adult"("family_id"));
