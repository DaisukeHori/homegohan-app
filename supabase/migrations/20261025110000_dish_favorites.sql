-- migration: 20261025110000_dish_favorites.sql
-- 戻し方: supabase/rollbacks/20261025110000_dish_favorites.down.sql
-- 献立の料理のお気に入り (docs/design/cross/22-dish-favorites.md §7.1。Issue #2011)。
-- 献立の料理は recipes の行を持たないので、♥ を押した時点の料理そのもの (名前・役割・kcal・栄養・材料・作り方) の写しを
-- 本人だけの表に置く。1 行 = 本人 × 正規化した料理名 (dish_name_key)。同じ名前は 1 件 (UNIQUE)。
-- 写し (dish) の形は src/modules/dish-favorites/core.ts の DishSnapshotSchema が決め、route が検証してから入れる。
-- source_planned_meal_id は保存したときの食事 (planned_meals.id) の参照だけで、外部キーは張らない (献立を作り直しても・消しても写しを残す)。
-- RLS は本人の行だけ (cross/02 §4.1 の self-ownership)。anon は権限ごと外す。service_role は既定のまま。
-- 権限の定型 (#1039/#1020・cross/02 §3.4): 既定の権限を REVOKE ALL で外してから、authenticated に SELECT / INSERT / UPDATE / DELETE だけを付ける (TRUNCATE と ALL は付けない)。
-- 退会で auth.users の行が消えると CASCADE で消える (tests/integration/security/auth-users-fk-on-delete.test.ts の EXPECTED_ACTIONS)。
-- 個人データの書き出しは src/lib/account-export-tables.ts の ACCOUNT_EXPORT_TABLES (self('user_id'))。
-- 既存データへの影響: なし (表を作るだけ)。冪等: CREATE TABLE IF NOT EXISTS・CREATE INDEX IF NOT EXISTS・DROP ... IF EXISTS のあとの CREATE。
-- 確認: tests/dish-favorites-migration-contract.test.ts (静的)・tests/integration/rls/dish-favorites.test.ts (実 DB)

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.dish_favorites (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dish_name text NOT NULL,
  dish_name_key text NOT NULL,
  dish jsonb NOT NULL,
  source_planned_meal_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT dish_favorites_pkey PRIMARY KEY (id),
  CONSTRAINT dish_favorites_user_dish_name_key UNIQUE (user_id, dish_name_key),
  -- 名前と鍵の長さの上限は core.ts の DISH_FAVORITE_NAME_MAX_CHARS (100) と同じ値 (本番の料理名の最大は 24 文字。§3.4 F-30)。
  -- route は DishNameSchema で表示名と鍵の両方を 100 以下 (UTF-16 の長さ。char_length の数え方 (コードポイント) 以上) に絞ってから入れるので、ここには当たらない (安全弁)
  CONSTRAINT dish_favorites_dish_name_length CHECK (pg_catalog.char_length(dish_name) BETWEEN 1 AND 100),
  CONSTRAINT dish_favorites_dish_name_key_length CHECK (pg_catalog.char_length(dish_name_key) BETWEEN 1 AND 100),
  CONSTRAINT dish_favorites_dish_object CHECK (pg_catalog.jsonb_typeof(dish) = 'object'),
  -- 写しの大きさの安全弁は core.ts の DISH_FAVORITE_DISH_DB_MAX_BYTES (65536) と同じ値。route が先に見る上限
  -- DISH_FAVORITE_DISH_MAX_BYTES (32768。JSON.stringify の UTF-8 の長さ) より、jsonb の文字列で長くなる分
  -- (区切りの後の空白と、数を全桁で書く分) の上限 DISH_FAVORITE_DISH_JSONB_TEXT_EXTRA_MAX_BYTES (32768) だけ緩い (§13)。
  -- route が通した写しはここに当たらない (本番の 1 料理の最大は 3,904 バイト。§3.4 F-30)
  CONSTRAINT dish_favorites_dish_size CHECK (pg_catalog.octet_length(dish::text) <= 65536)
);

-- 一覧の既定の並び (本人の行を created_at の降順)
CREATE INDEX IF NOT EXISTS idx_dish_favorites_user_created_at ON public.dish_favorites (user_id, created_at DESC);

-- updated_at はベースラインの update_updated_at_column() (recipes などと同じ) で入れる
DROP TRIGGER IF EXISTS trg_dish_favorites_updated_at ON public.dish_favorites;
CREATE TRIGGER trg_dish_favorites_updated_at
  BEFORE UPDATE ON public.dish_favorites
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.dish_favorites ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.dish_favorites FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dish_favorites TO authenticated;

DROP POLICY IF EXISTS dish_favorites_self_select ON public.dish_favorites;
CREATE POLICY dish_favorites_self_select ON public.dish_favorites
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS dish_favorites_self_insert ON public.dish_favorites;
CREATE POLICY dish_favorites_self_insert ON public.dish_favorites
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS dish_favorites_self_update ON public.dish_favorites;
CREATE POLICY dish_favorites_self_update ON public.dish_favorites
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS dish_favorites_self_delete ON public.dish_favorites;
CREATE POLICY dish_favorites_self_delete ON public.dish_favorites
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

COMMENT ON TABLE public.dish_favorites IS
  '献立の料理のお気に入り (docs/design/cross/22-dish-favorites.md)。1 行 = 本人 × 正規化した料理名。dish に ♥ を押した時点の料理の写し (名前・役割・kcal・栄養・材料・作り方) を持つ。本人だけが読み書きする。退会で消える';
COMMENT ON COLUMN public.dish_favorites.dish_name IS '料理の表示名 (空白を 1 つにまとめ前後を除いたもの)。一覧の検索 (ilike) に使う';
COMMENT ON COLUMN public.dish_favorites.dish_name_key IS '同じ料理の判定の鍵 (表示名を NFKC に正規化し小文字にしたもの。src/modules/dish-favorites/core.ts の dishNameKeyOf)。本人ごとに一意';
COMMENT ON COLUMN public.dish_favorites.dish IS '料理の写し (src/modules/dish-favorites/core.ts の DishSnapshotSchema の形。画像は持たない)';
COMMENT ON COLUMN public.dish_favorites.source_planned_meal_id IS '保存したときの食事 (planned_meals.id) の参照。外部キーは張らない (献立が消えても写しを残す)。画面は読まない';
