-- storage バケット設定と storage.objects のポリシー (本番カタログから生成)
-- storage スキーマは supabase db dump の対象外のため、カタログ (pg_policies /
-- storage.buckets) から再構成している。

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('fridge-images', 'fridge-images', true, NULL, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('health-checkups', 'health-checkups', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('meal_photos', 'meal_photos', true, NULL, NULL) ON CONFLICT (id) DO NOTHING;

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

DROP POLICY IF EXISTS "Users can delete own checkup images" ON storage."objects";
CREATE POLICY "Users can delete own checkup images" ON storage."objects" AS PERMISSIVE FOR DELETE TO "authenticated"
  USING (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can upload own checkup images" ON storage."objects";
CREATE POLICY "Users can upload own checkup images" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can view own checkup images" ON storage."objects";
CREATE POLICY "Users can view own checkup images" ON storage."objects" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

