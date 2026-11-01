-- rollback: 20261101120000_recipe_collections_append_recipe_rpc.sql
-- #2183 Z3 の戻し口 (このファイルは supabase/rollbacks/20261101120000_recipe_collections_append_recipe_rpc.down.sql。1 行目は対の migration の名前)。
-- レシピのコレクションにレシピを 1 つ足す関数 append_recipe_to_collection(uuid, uuid) を消す。
-- 表・行・ポリシー・表の権限には触れていないので、戻すのは関数だけ。
-- 注意: 先にコードを戻す。AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) は、
--   関数が無いと PostgREST の PGRST202 で失敗し、レシピをコレクションに足せなくなる (result に「コレクションへの追加に失敗しました」)。
-- 消える行は無い (この関数で足したレシピは recipe_ids に残る)。
-- 表の権限 (GRANT) には触れない (20261022190000 より後の戻し口の規律: TRUNCATE / ALL を付け直さない)。
-- 冪等: DROP FUNCTION IF EXISTS。2 回流しても同じ結果になる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.append_recipe_to_collection(uuid, uuid);
