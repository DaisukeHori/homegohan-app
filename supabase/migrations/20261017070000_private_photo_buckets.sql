-- migration: 20261017070000_private_photo_buckets.sql
-- #1365 段 2: 食事写真・冷蔵庫写真のバケット (meal_photos / fridge-images) を非公開にする。
--
-- 背景: 2 つのバケットは公開 (public = true) で、保存されたオブジェクトは URL を知っていれば誰でも読めた
--   (supabase/baseline/prod_storage.sql:5,7)。段 1 (PR #1681) で、画面 (SignedPhotoImage → POST /api/storage/signed-urls)・
--   AI の読み出し (resolvePhotoUrlForOwnerRead)・運営の審査 (signPhotoUrlsForAuthorizedViewer) は、保存された URL を
--   そのまま使わず、service_role が本人の写真だけに署名した URL (createSignedUrls) を使うようになった。
--   アプリに公開 URL を読む経路は残っていないので、非公開にしても表示は途切れない (設計書 docs/design/cross/19-private-photo-buckets.md §3.3・§8)。
--
-- 内容: storage.buckets の 2 行を public = false にする (1 文)。storage.objects のポリシーは変えない
--   (fridge_images_insert_own_folder / fridge_images_select_own_folder は本人のフォルダだけのまま。meal_photos にポリシーは無い)。
--   health-checkups (もとから非公開) には触れない。DB の列に保存された URL の文字列は書き換えない (読むときに bucket/path に戻す)。
--
-- 本番のデータへの影響: 行には触れない。適用の直後から、保存された公開 URL (…/storage/v1/object/public/<bucket>/<path>) は
--   誰が開いても 4xx になる。本人の表示・AI・運営の審査は署名付き URL のまま変わらない。
--   公開バケットのときに CDN に乗った応答は、最長 1 時間 (オブジェクトの cacheControl) 残ることがある (設計書 §7)。
--
-- 冪等: UPDATE は同じ値を書くだけなので、何度流しても同じ結果になる。
-- 確認: tests/integration/security/photo-buckets-private.test.ts (匿名の公開 URL は 4xx・本人は署名付き URL で 200・他人は null)、
--   tests/private-photo-buckets-migration-contract.test.ts (この migration と PHOTO_STORAGE_BUCKETS・戻しの突き合わせ)。
-- ロールバック: supabase/rollbacks/20261017070000_private_photo_buckets.down.sql (public = true に戻す。権限が広がる)。
-- マージ順: migration は version の順にマージすること。

DO $$
DECLARE
  -- 非公開にするバケット。packages/shared/src/signed-photo-url.ts の PHOTO_STORAGE_BUCKETS と同じ 2 つ
  -- (tests/private-photo-buckets-migration-contract.test.ts が突き合わせる)
  c_buckets CONSTANT text[] := ARRAY['meal_photos', 'fridge-images'];
BEGIN
  UPDATE storage.buckets
  SET public = false
  WHERE id = ANY (c_buckets);

  -- 2 つとも非公開になったことを確かめる (バケットが無い環境で黙って何もしないままにしない)
  IF (SELECT count(*) FROM storage.buckets WHERE id = ANY (c_buckets) AND public = false) <> array_length(c_buckets, 1) THEN
    RAISE EXCEPTION 'private_photo_buckets: expected every photo bucket (%) to exist and be private', array_to_string(c_buckets, ', ');
  END IF;
END
$$;
