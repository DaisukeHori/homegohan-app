-- storage バケット設定と storage.objects のポリシー (本番カタログから生成)
-- storage スキーマは supabase db dump の対象外のため、カタログ (pg_policies /
-- storage.buckets) から再構成している。

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('fridge-images', 'fridge-images', true, NULL, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('health-checkups', 'health-checkups', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('meal_photos', 'meal_photos', true, NULL, NULL) ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users can delete own checkup images" ON storage."objects";
CREATE POLICY "Users can delete own checkup images" ON storage."objects" AS PERMISSIVE FOR DELETE TO "authenticated"
  USING (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can upload own checkup images" ON storage."objects";
CREATE POLICY "Users can upload own checkup images" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can view own checkup images" ON storage."objects";
CREATE POLICY "Users can view own checkup images" ON storage."objects" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "fridge_images_insert_own_folder" ON storage."objects";
CREATE POLICY "fridge_images_insert_own_folder" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (((bucket_id = 'fridge-images'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));

DROP POLICY IF EXISTS "fridge_images_select_own_folder" ON storage."objects";
CREATE POLICY "fridge_images_select_own_folder" ON storage."objects" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (((bucket_id = 'fridge-images'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));

