-- rollback: 20261007073232_storage_owner_folder_policies.sql
-- ⚠️ 権限が広がる: 戻すと 2026-10-06 時点の本番の状態に戻り、ログインユーザーが他人のフォルダを含む任意のパスに
--    アップロードでき、fridge-images はログインユーザーなら全員分、meal_photos は未ログインでも全件を一覧できる。
--    明示的な承認を得た場合に限って使う。
--
-- 内容: 本人のフォルダ用の 2 本を削除し、本番にだけあった 4 本 (supabase/baseline/prod_storage.sql と同じ定義) を戻す。
--       バケット (fridge-images / meal_photos) は保存済みのファイルがあるため削除しない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "fridge_images_insert_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "fridge_images_select_own_folder" ON storage.objects;

DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage."objects";
CREATE POLICY "Allow authenticated uploads" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK ((bucket_id = 'meal_photos'::text));

DROP POLICY IF EXISTS "Allow authenticated users to upload 17k8aio_0" ON storage."objects";
CREATE POLICY "Allow authenticated users to upload 17k8aio_0" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (((bucket_id = 'fridge-images'::text) AND (auth.role() = 'authenticated'::text)));

DROP POLICY IF EXISTS "Allow public to read 17k8aio_0" ON storage."objects";
CREATE POLICY "Allow public to read 17k8aio_0" ON storage."objects" AS PERMISSIVE FOR SELECT TO "anon", "authenticated"
  USING (((bucket_id = 'fridge-images'::text) AND (auth.role() = 'authenticated'::text)));

DROP POLICY IF EXISTS "Allow public viewing" ON storage."objects";
CREATE POLICY "Allow public viewing" ON storage."objects" AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((bucket_id = 'meal_photos'::text));
