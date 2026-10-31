-- rollback: 20261031140000_account_deletion_guards_comment_family_representative.sql
-- #2150 Q4 で出し直した表 account_deletion_guards のコメントを、その前の文
-- (20261031130000_object_comments_trigger_names.sql の COMMENT ON TABLE の文) に戻す。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 前の文はトリガーの名前を書き、関数の名前は「関数 …」と書いている (見張り tests/plan-stripe-product-id-guard-trigger-naming.test.ts が
-- supabase/rollbacks でも 0 件を求める書き方ではない) ので、20261031130000 の戻し口のように format で組み立てず、文を直に書く。
-- 出し直す文は前の文と 1 文字も違わない
-- (tests/account-deletion-guards-comment-family-representative-migration-contract.test.ts が前の migration の文と突き合わせる)。
--
-- 影響: コメントが変わるだけ (表・列・行・関数・トリガー・権限は変えない)。
-- 何度流しても同じ結果になる (冪等: COMMENT ON は上書き)。

SET LOCAL lock_timeout = '10s';

COMMENT ON TABLE public.account_deletion_guards IS
  '#1917 の続き (D73): 退会の印。begin_account_deletion_guard が退会の始め (findBlocker の前) に付け、トリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting) が組織の作成で読む。退会が済むと auth.users の CASCADE で消える。直接は誰も読み書きしない';
