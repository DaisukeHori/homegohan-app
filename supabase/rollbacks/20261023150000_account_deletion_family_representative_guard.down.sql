-- rollback: 20261023150000_account_deletion_family_representative_guard.sql
-- #1917 の続きで足した、家族の代表者の作成・変更のトリガー (trg_representative_not_deleting・関数
-- family_groups_representative_not_deleting) を外す。退会の印 (表 account_deletion_guards・関数 begin_account_deletion_guard) と
-- 組織の作成のトリガーは 20261023130000 のもので、ここでは外さない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- アプリは先に戻さなくてよい: route は REPRESENTATIVE_ACCOUNT_DELETING を 409 にするだけで、DB がそれを返さなくなっても
-- 他の応答は変わらない。
--
-- 影響:
--   - 戻すと、退会の途中の人が家族の作成・代表者の譲渡の承諾・運営の強制譲渡で家族の代表者になれるようになり、その退会は最後の
--     deleteUser が family_groups.representative_id の外部キー (RESTRICT) で失敗する穴が再び開く。
--   - 消える行は無い (トリガーと関数だけを外す)。
--
-- 何度流しても同じ結果になる (冪等: DROP ... IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS trg_representative_not_deleting ON public.family_groups;
DROP FUNCTION IF EXISTS public.family_groups_representative_not_deleting();
