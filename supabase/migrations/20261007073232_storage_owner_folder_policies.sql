-- migration: 20261007073232_storage_owner_folder_policies.sql
-- 本番ドリフト P-2〜P-6 (docs/operations/rls-drift-20261006.md): 画像バケット (fridge-images / meal_photos) の
-- アップロードと一覧を本人のフォルダに限定する
--
-- 背景:
--   2 つのバケットと次の 4 本のポリシーは本番にだけあり、migration に定義が無かった (ダッシュボードで作成されたとみられる)。
--     fridge-images  "Allow authenticated users to upload 17k8aio_0"  INSERT  ログインユーザーなら他人のフォルダを含む任意のパスに置ける
--                    "Allow public to read 17k8aio_0"                 SELECT  ログインユーザーなら全員分を一覧できる
--     meal_photos    "Allow authenticated uploads"                    INSERT  ログインユーザーなら任意のパスに置ける
--                    "Allow public viewing"                           SELECT  未ログインでも全件を一覧できる
--   保存パスは #1260 で全経路を <user_id>/… にそろえた (Web の /api/upload・AI 画像生成・献立リクエスト画面、
--   モバイルの冷蔵庫写真、Edge Function analyze-meal-photo)。meal_photos はコードから使われていない。
--
-- 変更 (2026-10-07 のオーナー判断「自分のフォルダに限定」):
--   1. 2 つのバケットを本番の設定のまま明文化する (公開バケット。ON CONFLICT DO NOTHING のため本番は変わらない)
--   2. 上の 4 本を削除する
--   3. fridge-images に、本人のフォルダ ((storage.foldername(name))[1] = auth.uid()) だけを対象にした
--      INSERT / SELECT のポリシーを置く。上書き (UPDATE) と削除 (DELETE) のポリシーは本番と同じく置かない
--      (AI 画像生成の upsert は毎回新しいファイル名のため、INSERT だけで足りる)
--   4. meal_photos にはポリシーを置かない (ログインユーザー・未ログインとも、アップロードと一覧ができなくなる)
--
--   どちらも公開バケットのままのため、保存済みの公開 URL (/storage/v1/object/public/…) での表示は変わらない
--   (公開バケットの読み出しは RLS を通らない)。旧パス (バケット直下や meals/<user_id>/…) に保存済みのファイルも同じ。
--   service_role で保存する Edge Function process-meal-image-jobs は RLS の対象外。
--
-- 権限: storage.objects の所有者は supabase_storage_admin だが、Supabase の supautils.policy_grants により
--   postgres でもポリシーを作成・削除できる (20260511000000_recreate_missing_health_checkups.sql と同じ)。
-- 冪等: INSERT … ON CONFLICT DO NOTHING + DROP POLICY IF EXISTS + CREATE POLICY。
-- ロールバック: supabase/rollbacks/20261007073232_storage_owner_folder_policies.down.sql

-- ---------------------------------------------------------------
-- 1. バケット (本番の設定のまま明文化する)
-- ---------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('fridge-images', 'fridge-images', true),
  ('meal_photos', 'meal_photos', true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------
-- 2. 本番にだけあった、パスを制限しないポリシーを削除する
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Allow authenticated users to upload 17k8aio_0" ON storage.objects;
DROP POLICY IF EXISTS "Allow public to read 17k8aio_0" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow public viewing" ON storage.objects;

-- ---------------------------------------------------------------
-- 3. fridge-images: アップロードと一覧は本人のフォルダ <user_id>/… だけ
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "fridge_images_insert_own_folder" ON storage.objects;
CREATE POLICY "fridge_images_insert_own_folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'fridge-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS "fridge_images_select_own_folder" ON storage.objects;
CREATE POLICY "fridge_images_select_own_folder"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'fridge-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- meal_photos: ポリシーを置かない (アップロードと一覧を止める。公開 URL での表示はそのまま)
