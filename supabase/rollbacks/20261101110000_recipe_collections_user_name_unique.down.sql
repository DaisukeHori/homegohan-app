-- rollback: 20261101110000_recipe_collections_user_name_unique.sql
-- #2178 Y3-b の戻し口 (このファイルは supabase/rollbacks/20261101110000_recipe_collections_user_name_unique.down.sql。1 行目は対の migration の名前)。
-- 一意の索引 recipe_collections_user_id_name_key を消し、この migration の直前の形 (主キーと idx_recipe_collections_user_id だけ) に戻す。
-- 注意: 先にコードを戻す。add_recipe_to_collection の upsert (on_conflict=user_id,name) は、索引が無いと PostgREST が 42P10
--   (ON CONFLICT の指定に合う一意の制約・索引が無い) で失敗し、コレクションを作れなくなる。
-- 戻すと、同じ利用者が同じ名前のコレクションを再び何件でも作れる (X4 の古い方へ足す形で運用する状態)。
-- 表の権限 (GRANT) には触れない (本冊の migration も触れていない。20261022190000 より後の戻し口の規律: TRUNCATE / ALL を付け直さない)。
-- 冪等: DROP INDEX IF EXISTS。2 回流しても同じ結果になる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS public.recipe_collections_user_id_name_key;
