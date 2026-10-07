-- =====================================================================
-- 本番 Supabase のカタログ snapshot (読み取り専用)
-- =====================================================================
-- .github/workflows/prod-schema-snapshot.yml から psql で実行する。
-- 全クエリを READ ONLY トランザクション内で実行し、最後は ROLLBACK する
-- (書き込み系の文は一切含めない)。出力は作業ディレクトリ直下の CSV。
--
-- 用途:
--   - supabase/baseline/ の素材 (storage バケット設定・storage ポリシー)
--   - docs/operations/rls-drift-*.md (#1243) の本番側データ
--     (pg_policies / 関数の権限 / テーブルの RLS 有効状態 / storage ポリシー)
--
-- 注意: ユーザーデータ (行) は取得しない。storage.buckets は設定値のみ
--       (owner 列は取得しない)。
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

-- RLS ポリシー (内部スキーマを除く全スキーマ。storage.objects 等を含む)
\copy (SELECT schemaname, tablename, policyname, permissive, array_to_string(roles, ',') AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename, policyname) TO 'catalog_policies.csv' WITH (FORMAT csv, HEADER true)

-- 関数 (public スキーマ): SECURITY DEFINER / search_path 設定 / 所有者 / EXECUTE 権限
\copy (SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS identity_args, p.prosecdef AS security_definer, p.provolatile AS volatile, coalesce(array_to_string(p.proconfig, ';'), '') AS config, pg_get_userbyid(p.proowner) AS owner, coalesce(p.proacl::text, '') AS acl, p.prokind AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1, 2, 3) TO 'catalog_functions.csv' WITH (FORMAT csv, HEADER true)

-- テーブル / ビュー (public, storage): RLS 有効状態と GRANT
\copy (SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced, coalesce(c.relacl::text, '') AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 1, 2) TO 'catalog_tables.csv' WITH (FORMAT csv, HEADER true)

-- storage バケット設定 (owner 等のユーザー情報は取得しない)
\copy (SELECT id, name, public, file_size_limit, coalesce(array_to_string(allowed_mime_types, ','), '') AS allowed_mime_types FROM storage.buckets ORDER BY id) TO 'storage_buckets.csv' WITH (FORMAT csv, HEADER true)

-- 拡張機能
\copy (SELECT e.extname, e.extversion, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1) TO 'catalog_extensions.csv' WITH (FORMAT csv, HEADER true)

-- Realtime publication の対象テーブル
\copy (SELECT pubname, schemaname, tablename FROM pg_publication_tables ORDER BY 1, 2, 3) TO 'catalog_publication.csv' WITH (FORMAT csv, HEADER true)

-- auth / storage スキーマのテーブルに付いたトリガー (アプリ独自のものの検出用)
\copy (SELECT n.nspname AS schema, c.relname AS table_name, t.tgname AS trigger_name, pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('auth', 'storage') ORDER BY 1, 2, 3) TO 'catalog_auth_storage_triggers.csv' WITH (FORMAT csv, HEADER true)

ROLLBACK;
