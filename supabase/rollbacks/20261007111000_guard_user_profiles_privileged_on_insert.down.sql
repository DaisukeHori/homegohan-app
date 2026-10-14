-- rollback: 20261007111000_guard_user_profiles_privileged_on_insert.sql
-- INSERT のガードを外す。戻すと、プロフィールの行をまだ持っていない本人が、自分の行を作るときに
-- roles などの特権列へ任意の値を入れられる状態に戻る (UPDATE のガードはそのまま残る)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。

DROP TRIGGER IF EXISTS trg_guard_user_profiles_privileged_on_insert ON public.user_profiles;
DROP FUNCTION IF EXISTS public.guard_user_profiles_privileged_on_insert();
