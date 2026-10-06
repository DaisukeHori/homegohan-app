-- =====================================================================
-- #1243 ドリフト調査用: ベースライン DB の「認可まわりの状態」を初期化する (ローカル専用)
-- =====================================================================
-- scripts/baseline/drift_report.sh から、ベースラインだけを適用したローカル DB に対して実行する。
-- 本番には絶対に流さない (ローカルの使い捨て DB 専用)。
--
-- テーブル / 型 / 関数の「構造」は本番のまま残し、migration が定義する認可状態
-- (RLS ポリシー・RLS 有効化・GRANT / REVOKE・SECURITY DEFINER) だけを白紙に戻す。
-- この後に supabase/migrations を全て順に再適用すると、
-- 「migration ファイルが定義する認可状態」を本番と同じテーブル構造の上に再現できる。
-- =====================================================================

DO $$
DECLARE
  r record;
BEGIN
  -- public スキーマの RLS ポリシーを全て削除
  FOR r IN
    SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;

  -- public スキーマのテーブル: RLS を解除し、GRANT を Supabase の新規作成時の既定に戻す
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated, service_role', r.tbl);
    EXECUTE format('GRANT ALL ON TABLE %s TO anon, authenticated, service_role', r.tbl);
  END LOOP;

  -- public スキーマの関数: EXECUTE 権限を新規作成時の既定 (PUBLIC + API ロール) に戻す
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
  LOOP
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO PUBLIC, anon, authenticated, service_role', r.fn);
  END LOOP;
END $$;
