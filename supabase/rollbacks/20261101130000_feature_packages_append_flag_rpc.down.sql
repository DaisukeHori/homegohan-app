-- rollback: 20261101130000_feature_packages_append_flag_rpc.sql
-- #2189 W4 の戻し口 (このファイルは supabase/rollbacks/20261101130000_feature_packages_append_flag_rpc.down.sql。1 行目は対の migration の名前)。
-- 機能パッケージのフラグキーの一覧にキーを 1 つ足す関数 append_flag_to_feature_package(text, text) を消す。
-- 表・行・ポリシー・表の権限には触れていないので、戻すのは関数だけ。
-- 注意: 先にコードを戻す。運営最上位の機能フラグの作成 (POST /api/super-admin/flags。src/app/api/super-admin/flags/route.ts) は、
--   関数が無いと PostgREST の PGRST202 で basic のパッケージへの追加に失敗する (フラグそのものは作られ、201 を返し、失敗はログに残る)。
--   追加できなかったキーは、フラグの削除の「使用中か」の検査に引っかからない。
-- 消える行は無い (この関数で足したキーは feature_flags に残る)。
-- 表の権限 (GRANT) には触れない (20261022190000 より後の戻し口の規律: TRUNCATE / ALL を付け直さない)。
-- 冪等: DROP FUNCTION IF EXISTS。2 回流しても同じ結果になる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.append_flag_to_feature_package(text, text);
