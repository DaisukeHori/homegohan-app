-- rollback: 20261007094300_challenge_participants_org_scope.sql
-- ⚠️ 権限が広がる: 戻すと 2026-10-06 時点の本番の状態に戻り、ログインユーザーが他組織のチャレンジに参加でき、
--    自分の参加行の current_value を自由に書き換えられる (#1238)。明示的な承認を得た場合に限って使う。
--
-- 内容: INSERT ポリシーを本番の定義 (WITH CHECK (user_id = auth.uid())) に戻し、
--       削除した UPDATE ポリシー (USING (user_id = auth.uid())) を戻す。
--       定義は supabase/baseline/catalog/catalog_policies.csv と 20260511000137_backfill_oob_remaining.sql のとおり。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "Users can join challenges" ON public.organization_challenge_participants;
CREATE POLICY "Users can join challenges" ON public.organization_challenge_participants
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own participation" ON public.organization_challenge_participants;
CREATE POLICY "Users can update own participation" ON public.organization_challenge_participants
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid());
