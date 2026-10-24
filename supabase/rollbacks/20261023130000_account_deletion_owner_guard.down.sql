-- rollback: 20261023130000_account_deletion_owner_guard.sql
-- #1917 の続き (D73) で足した、退会の印 (表 account_deletion_guards・関数 begin_account_deletion_guard) と、
-- 組織の作成のトリガー (trg_organizations_owner_not_deleting・関数 organizations_owner_not_deleting) を外す。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
-- ⚠️ 先に supabase/rollbacks/20261023150000_account_deletion_family_representative_guard.down.sql を流すこと: 20261023150000 の family_groups のトリガーの関数がこの表 account_deletion_guards を読むので、表だけを外すと家族の作成と代表者の変更が失敗する。
-- ⚠️ 先にアプリを戻すこと: 退会の本体 (src/lib/account-deletion.ts の deleteAccount) は findBlocker の前に
--    begin_account_deletion_guard を呼び、失敗したら削除しない (ACCOUNT_DELETE_FAILED)。関数だけを先に外すと、退会がすべて失敗する。
--
-- 影響:
--   - 戻すと、退会の途中の人を運営がオーナーにして組織を作れるようになり、その退会は最後の deleteUser が
--     organizations_owner_id_fkey (RESTRICT) で失敗する穴が再び開く。
--   - 印の行は消える (表ごと外す)。印は退会の途中だけに意味があるので、残す値は無い。
--
-- 何度流しても同じ結果になる (冪等: DROP ... IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS trg_organizations_owner_not_deleting ON public.organizations;
DROP FUNCTION IF EXISTS public.organizations_owner_not_deleting();
DROP FUNCTION IF EXISTS public.begin_account_deletion_guard(uuid);
DROP TABLE IF EXISTS public.account_deletion_guards;
