-- rollback: 20261017070000_private_photo_buckets.sql
-- ⚠️ 権限が広がる: 戻すと 2 つのバケットが公開に戻り、保存されたオブジェクトは URL を知っていれば誰でも
--    (ログインしていなくても) 読めるようになる (#1365 の報告の状態)。明示的な承認を得た場合に限って使う。
--
-- 内容: storage.buckets の meal_photos / fridge-images を public = true に戻す。
--       storage.objects のポリシー・オブジェクト・DB の列には触れない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DO $$
DECLARE
  c_buckets CONSTANT text[] := ARRAY['meal_photos', 'fridge-images'];
BEGIN
  UPDATE storage.buckets
  SET public = true
  WHERE id = ANY (c_buckets);
END
$$;
