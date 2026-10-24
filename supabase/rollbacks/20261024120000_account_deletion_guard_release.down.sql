-- rollback: 20261024120000_account_deletion_guard_release.sql
-- #1917 の続きで足した、退会の印を消す関数 (end_account_deletion_guard) を外す。印の表 (account_deletion_guards)・
-- 印を付ける関数 (begin_account_deletion_guard)・2 つのトリガーは 20261023130000・20261023150000 のもので、ここでは外さない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- アプリは先に戻さなくてよい: 退会の本体 (src/lib/account-deletion.ts の deleteAccount) は、印を消すのに失敗しても
-- ログに残すだけで、退会の応答 (409・失敗) は変えない。
--
-- 影響:
--   - 戻すと、退会が 409 や途中の失敗で止まったあとも、印が 15 分 (c_guard_window) 効き続ける (20261024120000 より前の動き)。
--     その間、本人の家族の作成・代表者の譲渡の承諾と、運営の組織の作成 (その人をオーナーにする)・家族の代表者の強制譲渡は、退会の手続き中として止まる。
--   - 消える行は無い (関数だけを外す)。
--
-- 何度流しても同じ結果になる (冪等: DROP ... IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.end_account_deletion_guard(uuid);
