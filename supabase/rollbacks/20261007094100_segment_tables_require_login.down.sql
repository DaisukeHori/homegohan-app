-- rollback: 20261007094100_segment_tables_require_login.sql
-- ⚠️ 権限が広がる: 戻すと 2026-10-06 時点の本番の状態に戻り、未ログイン (anon) でも
--    segment_stats / segment_definitions / metric_definitions を公開キーだけで読める。
--    明示的な承認を得た場合に限って使う。
--
-- 内容: 3 本の SELECT ポリシーを、本番の定義 (supabase/baseline/catalog/catalog_policies.csv と同じ:
--       FOR SELECT, roles=public, USING (true)) に戻す。GRANT はもともと変えていないため触らない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "metric_definitions_select" ON "public"."metric_definitions";
CREATE POLICY "metric_definitions_select" ON "public"."metric_definitions"
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "segment_definitions_select" ON "public"."segment_definitions";
CREATE POLICY "segment_definitions_select" ON "public"."segment_definitions"
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "segment_stats_select" ON "public"."segment_stats";
CREATE POLICY "segment_stats_select" ON "public"."segment_stats"
  FOR SELECT TO public USING (true);
