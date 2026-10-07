-- migration: 20261007094100_segment_tables_require_login.sql
-- #1242: segment_stats / segment_definitions / metric_definitions の SELECT をログインユーザーに限定する
--
-- 背景 (本番の現状: supabase/baseline/catalog/catalog_policies.csv):
--   metric_definitions_select / segment_definitions_select / segment_stats_select の 3 本が
--   FOR SELECT, roles=public, USING (true)。テーブルは anon / authenticated に GRANT ALL 済み
--   (catalog_tables.csv)。そのため公開の anon キーだけで GET /rest/v1/segment_stats?select=* などを直接読めた。
--   アプリの /api/comparison/rankings はログインが必要なのに、DB 層は未ログインでも読める (認可の不一致)。
--   中身はコホート比較の統計とセグメント・指標の定義で、個人情報は含まない。
--   定義の出どころは 20260511000137_backfill_oob_remaining.sql (3 本とも FOR SELECT USING (true))。
--
-- 変更:
--   3 本の SELECT ポリシーを TO authenticated USING (true) で作り直す (ポリシー名は変えない)。
--   書き込み用のポリシーは本番にも無い (service_role だけが書ける) ままで、追加しない。
--   GRANT は変えない (RLS で足りる。anon の SELECT はポリシーが無くなるため 0 件になる)。
--
-- 既存の正当な利用経路への影響: なし。
--   - src/app/api/comparison/rankings/route.ts: createClient() (ログインユーザーのセッション) で読み、
--     未ログインは 401 で先に弾く。user_segment_rankings からの埋め込み (segment_definitions / metric_definitions) も
--     同じセッションなので読める
--   - supabase/functions/calculate-segment-stats: service_role で読み書きする (RLS の対象外)
--   - apps/mobile・scripts・packages に、この 3 テーブルを読み書きする経路は無い (型定義のみ)
--
-- 冪等: DROP POLICY IF EXISTS → CREATE POLICY のため、2 回続けて適用してもエラーにならない。
-- ロールバック: supabase/rollbacks/20261007094100_segment_tables_require_login.down.sql

DROP POLICY IF EXISTS "metric_definitions_select" ON "public"."metric_definitions";
CREATE POLICY "metric_definitions_select" ON "public"."metric_definitions"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "segment_definitions_select" ON "public"."segment_definitions";
CREATE POLICY "segment_definitions_select" ON "public"."segment_definitions"
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "segment_stats_select" ON "public"."segment_stats";
CREATE POLICY "segment_stats_select" ON "public"."segment_stats"
  FOR SELECT TO authenticated USING (true);
