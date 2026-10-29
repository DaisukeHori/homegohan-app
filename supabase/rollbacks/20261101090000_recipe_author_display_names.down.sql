-- rollback: 20261101090000_recipe_author_display_names.sql
-- cross/21 の戻し口 (このファイルは supabase/rollbacks/20261101090000_recipe_author_display_names.down.sql。1 行目は対の migration の名前)。関数 → 索引 → 列 の順に消す。
-- 注意: 先にコードを戻す (viewer-lookups.ts が rpc を呼んだまま関数を消すと、レシピの API が PGRST202 の 500 になる)。
-- 列を消すと、本人の「名前を出さない」の選択は失われる (戻したあとに再適用しても既定の true に戻る)。
-- anon / authenticated への GRANT は何も付け直さない (TRUNCATE / ALL を含む。20261022190000 より後の戻し口の規律)。

DROP FUNCTION IF EXISTS public.recipe_author_display_names(uuid[]);
DROP INDEX IF EXISTS public.idx_recipe_comments_user_id;
ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS show_recipe_author_name;
