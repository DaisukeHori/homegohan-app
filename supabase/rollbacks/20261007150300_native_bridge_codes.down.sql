-- rollback: 20261007150300_native_bridge_codes.sql
-- 行は最長 60 秒しか生きないので、戻しても失うデータは実質ない。
-- 先に Web のデプロイ (POST /api/auth/native-bridge/code と GET /auth/native-bridge の code 経路) を戻すこと。
-- 先にこのロールバックを当てると、新方式のアプリは「コードの発行に失敗 -> ブリッジなしの直接 URL (ログイン画面)」になる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。
--
-- 何度流しても同じ結果になる (冪等)。ポリシー・インデックス・制約はテーブルと一緒に消えるので、個別には消さない
-- (テーブルが無い状態で DROP POLICY IF EXISTS ... ON <テーブル> を流すとエラーになるため)。

DROP FUNCTION IF EXISTS public.consume_native_bridge_code(TEXT);
DROP FUNCTION IF EXISTS public.issue_native_bridge_code(TEXT, UUID, TEXT, TEXT, INTEGER);
DROP TABLE IF EXISTS public.native_bridge_codes;
