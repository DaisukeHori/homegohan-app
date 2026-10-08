-- rollback: 20261007160800_admin_user_email_lookup.sql
-- 管理画面のメールアドレス表示・メール検索用の 2 関数を削除する。データは一切変わらない (関数を消すだけ)。
-- 先に管理 API のデプロイ (メールを引くコード) を戻すこと。
-- 先にこのロールバックを当てても API は落ちない (メールが null になり、検索がメールを無視するだけ。失敗はログに残る)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。
--
-- 何度流しても同じ結果になる (冪等)。

DROP FUNCTION IF EXISTS public.admin_find_user_ids_by_email(text, integer);
DROP FUNCTION IF EXISTS public.admin_user_emails(uuid[]);
