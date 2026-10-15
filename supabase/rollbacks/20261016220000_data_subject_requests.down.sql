-- rollback: 20261016220000_data_subject_requests.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。
-- 先に Web のデプロイ (/api/account/data-requests・/api/admin/data-requests・画面) を戻すこと。
-- 消えるもの: data_subject_requests の全行 (請求と応答の記録)。監査ログ (admin_audit_logs の admin.dsr.*) は残る。
-- 索引・ポリシー・トリガー・コメントは表と一緒に消える。冪等。
DROP TABLE IF EXISTS public.data_subject_requests;
