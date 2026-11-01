-- migration: 20261101110000_recipe_collections_user_name_unique.sql
-- 戻し方: supabase/rollbacks/20261101110000_recipe_collections_user_name_unique.down.sql
-- #2178 Y3-b: レシピのコレクション (recipe_collections) を、利用者ごとに同じ名前で 1 件だけにする一意の索引 (user_id, name) を足す。
--
-- 背景:
--   recipe_collections には主キーと user_id の索引しか無く、同じ利用者が同じ名前のコレクションを何件でも持てた。
--   AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) は、名前で引く読み取りが 2 行以上で
--   失敗すると同じ名前のコレクションをもう 1 件作っていた (#2166 X4 で古い方へ足す形に直した)。X4 の後も、既にある重複は残り、
--   AI に渡す一覧 (新しい順に「名前: n件」) と実際の足し先 (古い方) がずれうる。重複を作らせない制約がどこにも無かった。
--   2026-11-01 の本番の読み取りで recipe_collections は 0 行 (同じ名前の重複も 0) だったので、データ移行なしで索引を入れる。
--
-- 変更 (表の行・列・権限 (GRANT)・ポリシーには触れない):
--   1. 一意の索引 recipe_collections_user_id_name_key ON public.recipe_collections (user_id, name) を作る。
--      - user_id は NULL を許す列。NULL どうしは一意の索引で重ならない扱い (PostgreSQL の既定) なので、作者のいない行は制約の外。
--        アプリが作る行は必ず user_id を持つ (RLS "Users can manage own collections" の WITH CHECK (user_id = auth.uid()))。
--      - 部分索引にしない (PostgREST の upsert の on_conflict=user_id,name が ON CONFLICT (user_id, name) で推論できる形にする)。
--   コードの側: add_recipe_to_collection はコレクションを作るとき onConflict = 'user_id,name' の upsert を使い、
--   同じ名前の行があればその行を使う (src/lib/recipes/collections.ts の RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET)。
--
-- 既存データへの影響: 行は書き換えない。適用の時点で同じ利用者・同じ名前の行が 2 件以上あると、索引を作れずに migration が失敗する
--   (黙って重複を消さない)。そのときは重複をまとめるデータ移行 (名指しの承認が要る) を先に別の migration で行う。
-- ロック: CREATE INDEX は recipe_collections に SHARE ロックを取り、作り終えるまで書き込みを待たせる (本番は 0 行なので一瞬)。
--   lock_timeout を 10 秒にし、待ちが長ければ失敗させる (再実行で直る)。migration はトランザクションの中で流れるので CONCURRENTLY は使わない。
-- 冪等: CREATE UNIQUE INDEX IF NOT EXISTS。2 回続けて適用してもエラーにならない。
-- 型 (database.types.ts) は索引を持たないので作り直さない。
-- 確認: tests/integration/rls/recipe-collections-user-name-unique.test.ts (実 DB)
--       tests/recipe-collections-user-name-unique-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE UNIQUE INDEX IF NOT EXISTS recipe_collections_user_id_name_key
  ON public.recipe_collections (user_id, name);
