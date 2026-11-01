-- migration: 20261101130000_feature_packages_append_flag_rpc.sql
-- 戻し方: supabase/rollbacks/20261101130000_feature_packages_append_flag_rpc.down.sql
-- #2189 W4: 機能パッケージ (feature_packages) のフラグキーの一覧 (feature_flags) にフラグキーを 1 つ足す関数 append_flag_to_feature_package を足す。
--
-- 背景:
--   運営最上位の機能フラグの作成 (POST /api/super-admin/flags。src/app/api/super-admin/flags/route.ts) は、basic のパッケージの
--   feature_flags を select('id, feature_flags') で読み、service_role で `.update({ feature_flags: [...読んだ値, key] })` と書いていた。
--   読んでから書く形なので、運営最上位が 2 人ほぼ同時にフラグを作ると、後から書いた方の一覧だけが残り、先に作ったキーが basic から消えた。
--   消えたキーは、フラグの削除 (DELETE /api/super-admin/flags/[key]) の「使用中か」の検査 (contains('feature_flags', [key])) に引っかからない。
--
-- 変更 (この migration は関数を 1 本足すだけ。表・行・ポリシー・表の権限は変えない):
--   public.append_flag_to_feature_package(p_package_key text, p_flag_key text) RETURNS text
--     - 足すのは 1 文の条件つき UPDATE: feature_flags = array_append(feature_flags, p_flag_key)、updated_at = now()。
--       まだ入っていないとき (NOT (p_flag_key = ANY (feature_flags))) だけ書く。feature_flags は NOT NULL (既定 '{}') なので coalesce は要らない。
--       同時に 2 本が同じ行を書くと、後の方は行のロックを待ち、READ COMMITTED の再評価で相手の書いた後の feature_flags に対して
--       条件を確かめ直して足す (両方残る)。同じキーなら、後の方は条件に合わず書かない (二重に入らない)。
--     - 返す値 (src/lib/super-admin/feature-package-flag-append.ts の FEATURE_PACKAGE_FLAG_APPEND_OUTCOME と同じ):
--         'added'           足した
--         'already_present' このパッケージに既に入っていた (何も書かない)
--         'not_found'       この鍵 (package_key) のパッケージが無い (何も書かない)
--       UPDATE と同じ 1 文の中で、UPDATE が書かなかったときにパッケージがあるかを見て分ける (データを変える CTE + SELECT)。
--     - SECURITY INVOKER: 呼び出した役割の権限で動く。呼ぶのは service_role だけ (運営最上位の確認 requireRole(['super_admin']) を
--       アプリが済ませたあと)。DEFINER にしなくても service_role は表を書けるので、INVOKER で足りる。
--     - STRICT: 引数に NULL があれば何もせず NULL を返す (アプリは失敗として扱う)。
--     - search_path は空にし、表と型は schema つき (型は pg_catalog の character varying) で書く。
--     - EXECUTE は service_role だけ。PUBLIC・anon・authenticated から外す
--       (呼び出し元はサーバーの service_role のクライアントだけ。ログインした利用者に、どのパッケージにもキーを足せる口を開けない)。
--       tests/integration/security/anon-invoker-execute.test.ts の A1 (anon が EXECUTE できる SECURITY INVOKER の関数は許可一覧だけ) を満たす。
--
-- 既存データへの影響: なし (関数を作るだけ)。
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT のため、2 回続けて適用してもエラーにならない。
-- ロック: 表には触れない (関数の作成とカタログの権限だけ)。lock_timeout は他の migration と同じ 10 秒。
-- 型: src/types/database.types.ts と packages/shared/src/database.types.ts の Functions に append_flag_to_feature_package を足す。
-- 確認: tests/integration/rls/feature-packages-append-flag-rpc.test.ts (実 DB)
--       tests/feature-packages-append-flag-rpc-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.append_flag_to_feature_package(p_package_key text, p_flag_key text)
RETURNS text
LANGUAGE sql
VOLATILE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH appended AS (
    UPDATE public.feature_packages AS fp
       SET feature_flags = array_append(fp.feature_flags, p_flag_key::pg_catalog.varchar),
           updated_at = pg_catalog.now()
     WHERE fp.package_key = p_package_key
       AND NOT (p_flag_key::pg_catalog.varchar = ANY (fp.feature_flags))
    RETURNING fp.id
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM appended) THEN 'added'
    WHEN EXISTS (
      SELECT 1 FROM public.feature_packages AS pkg
       WHERE pkg.package_key = p_package_key
    ) THEN 'already_present'
    ELSE 'not_found'
  END;
$$;

COMMENT ON FUNCTION public.append_flag_to_feature_package(text, text) IS
  '#2189 W4: 機能パッケージのフラグキーの一覧に、まだ入っていなければキーを 1 つ足す (1 文の条件つき UPDATE)。added / already_present / not_found を返す。EXECUTE は service_role だけ。';

REVOKE ALL ON FUNCTION public.append_flag_to_feature_package(text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.append_flag_to_feature_package(text, text) TO service_role;
