-- rollback: 20261022200000_family_groups_no_direct_delete.sql
-- #1917 で外した、family_groups への利用者 (anon / authenticated) からの DELETE のポリシーと権限を、元に戻す。
-- ポリシーの名前・種類・対象のロール・式は、本番のベースライン (20251126124224_create_meal_planner_tables.sql:10352) と同じ。
-- 権限は、本冊の適用の直前の状態に戻す: anon / authenticated に DELETE だけを付け直し、TRUNCATE は付けない。
--   ベースラインの :13588-13589 は anon / authenticated に DELETE と TRUNCATE の両方を付けていたが、本冊の直前の
--   20261022190000_db_privilege_hardening.sql が public の全部の表から anon / authenticated の TRUNCATE を外している
--   (docs/design/cross/02-rls-patterns.md §3.4: public の表・ビューは anon と authenticated に TRUNCATE を持たせない)。本冊の適用の直前の family_groups には TRUNCATE が無いので、
--   ここで TRUNCATE を付け直すと、RLS の効かない TRUNCATE が利用者に戻り、190000 の不変条件 (全表で TRUNCATE なし) を破る。
-- (tests/family-groups-no-direct-delete-migration-contract.test.ts が、ポリシーとベースラインの行との一致・戻した後の権限が
--  本冊の直前の状態 (DELETE はあり・TRUNCATE は無い) と同じこと・TRUNCATE を GRANT しないことを見る。
--  tests/integration/rls/family-groups-no-direct-delete.test.ts が、ローカルの DB で流して確かめる)
--
-- 戻す順: 新しい順 (本冊 → 190000) に戻すと、190000 の戻し口が family_groups の TRUNCATE を付け直し、ベースラインの状態
--   (DELETE・TRUNCATE) に戻る。190000 の戻し口は、family_groups について利用者が DELETE を持たない間 (= 本冊が残っている間) は
--   TRUNCATE を付けないので、本冊を戻さずに 190000 だけを先に戻しても、family_groups に TRUNCATE は付かない。
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

GRANT DELETE ON TABLE public.family_groups TO anon, authenticated;

DROP POLICY IF EXISTS family_groups_delete_representative ON public.family_groups;
CREATE POLICY "family_groups_delete_representative" ON "public"."family_groups" FOR DELETE USING (("representative_id" = "auth"."uid"()));
