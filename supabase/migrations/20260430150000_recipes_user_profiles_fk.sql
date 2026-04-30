-- Issue #211: /api/recipes が全ユーザーに 500 を返す問題を修正
-- 原因: recipes.user_id は auth.users(id) を参照しているが、
--       Supabase クエリで user_profiles(nickname) の JOIN を使う際に
--       recipes → user_profiles の FK がスキーマキャッシュに存在せず 500 になる。
--
-- 解決策: recipes.user_id → user_profiles(id) の FK を追加する。
-- user_profiles が存在しないユーザーのレシピを守るため NOT VALID で追加し、
-- 既存データへのバックフィルは不要（プロファイル未作成ユーザーは authorName が '匿名' にフォールバック）。

ALTER TABLE recipes
  ADD CONSTRAINT recipes_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES user_profiles(id)
  ON DELETE SET NULL
  NOT VALID;

-- スキーマキャッシュへ即時反映させるため VALIDATE は省略（NOT VALID のまま）。
-- Supabase の PostgREST はスキーマキャッシュをリロードすることで FK を認識し、
-- recipes (..., user_profiles (...)) の JOIN が正常に動作するようになる。
