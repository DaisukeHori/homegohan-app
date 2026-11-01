-- migration: 20261101120000_recipe_collections_append_recipe_rpc.sql
-- 戻し方: supabase/rollbacks/20261101120000_recipe_collections_append_recipe_rpc.down.sql
-- #2183 Z3: レシピのコレクション (recipe_collections) にレシピを 1 つ足す関数 append_recipe_to_collection を足す。
--
-- 背景:
--   AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) は、recipe_ids を読み直してから
--   `.update({ recipe_ids: [...読んだ値, recipeId] })` で書いていた (#2178 Y3-a で読み直しの失敗では書かない形にした)。
--   読んでから書く形なので、同じ利用者が同じコレクションへほぼ同時に 2 つのレシピを足すと、後から書いた方が
--   先の追加を上書きし、レシピが 1 つ消えた。
--
-- 変更 (この migration は関数を 1 本足すだけ。表・行・ポリシー・表の権限は変えない):
--   public.append_recipe_to_collection(p_collection_id uuid, p_recipe_id uuid) RETURNS text
--     - 足すのは 1 文の条件つき UPDATE: recipe_ids = array_append(coalesce(recipe_ids, '{}'), p_recipe_id)。
--       まだ入っていないとき (NOT (p_recipe_id = ANY (coalesce(recipe_ids, '{}')))) だけ書く。
--       同時に 2 本が同じ行を書くと、後の方は行のロックを待ち、READ COMMITTED の再評価で相手の書いた後の recipe_ids に対して
--       条件を確かめ直して足す (両方残る)。同じレシピなら、後の方は条件に合わず書かない (二重に入らない)。
--     - 返す値 (src/lib/recipes/collection-append.ts の RECIPE_COLLECTION_APPEND_OUTCOME と同じ):
--         'added'           足した
--         'already_present' 本人の行に既に入っていた (何も書かない)
--         'not_found'       本人の行 (user_id = auth.uid()) にこの id が無い
--       UPDATE と同じ 1 文の中で、UPDATE が書かなかったときに本人の行があるかを見て分ける (データを変える CTE + SELECT)。
--     - SECURITY INVOKER: 呼び出した利用者の権限と RLS で動く。UPDATE は "Users can manage own collections" (本人の行だけ) に従う。
--       公開のコレクション (is_public) は他人も SELECT できる (ポリシー "Anyone can view public collections") ので、
--       'already_present' と 'not_found' の判定は user_id = auth.uid() で本人の行に絞る。
--     - STRICT: 引数に NULL があれば何もせず NULL を返す (アプリは失敗として扱う)。
--     - search_path は空にし、表と関数は schema つきで書く。
--     - EXECUTE は authenticated だけ。PUBLIC・anon・service_role から外す
--       (呼び出し元は利用者のセッションのクライアントだけ。service_role は RLS を通らないので、本人の行に絞る守りが無くなる)。
--       tests/integration/security/anon-invoker-execute.test.ts の A1 (anon が EXECUTE できる SECURITY INVOKER の関数は許可一覧だけ) を満たす。
--
-- 既存データへの影響: なし (関数を作るだけ。2026-11-01 の本番の読み取りで recipe_collections は 0 行)。
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT のため、2 回続けて適用してもエラーにならない。
-- ロック: 表には触れない (関数の作成とカタログの権限だけ)。lock_timeout は他の migration と同じ 10 秒。
-- 型: src/types/database.types.ts と packages/shared/src/database.types.ts の Functions に append_recipe_to_collection を足す。
-- 確認: tests/integration/rls/recipe-collections-append-recipe-rpc.test.ts (実 DB)
--       tests/recipe-collections-append-recipe-rpc-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.append_recipe_to_collection(p_collection_id uuid, p_recipe_id uuid)
RETURNS text
LANGUAGE sql
VOLATILE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH appended AS (
    UPDATE public.recipe_collections AS rc
       SET recipe_ids = array_append(coalesce(rc.recipe_ids, '{}'::uuid[]), p_recipe_id)
     WHERE rc.id = p_collection_id
       AND NOT (p_recipe_id = ANY (coalesce(rc.recipe_ids, '{}'::uuid[])))
    RETURNING rc.id
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM appended) THEN 'added'
    WHEN EXISTS (
      SELECT 1 FROM public.recipe_collections AS own
       WHERE own.id = p_collection_id AND own.user_id = auth.uid()
    ) THEN 'already_present'
    ELSE 'not_found'
  END;
$$;

COMMENT ON FUNCTION public.append_recipe_to_collection(uuid, uuid) IS
  '#2183 Z3: 本人のレシピのコレクションに、まだ入っていなければレシピを 1 つ足す (1 文の条件つき UPDATE)。added / already_present / not_found を返す。SECURITY INVOKER (RLS で本人の行だけ)。';

REVOKE ALL ON FUNCTION public.append_recipe_to_collection(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.append_recipe_to_collection(uuid, uuid) TO authenticated;
