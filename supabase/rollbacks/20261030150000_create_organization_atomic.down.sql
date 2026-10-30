-- rollback: 20261030150000_create_organization_atomic.sql
-- #2107 Y4 で足した、運営の組織の作成を 1 つのトランザクションで書く関数 admin_create_organization(text, text, uuid) を消す。
-- 表・トリガー・ポリシー・既存の関数・行には触れていないので、戻すのは関数だけ。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、運営の組織の作成 API (src/app/api/admin/organizations/route.ts の POST) は関数が無いので失敗する
--     (PostgREST の PGRST202 → 500 「組織の作成に失敗しました」)。先にアプリを、表に直接書く版 (#2107 より前) に戻してから流す。
--   - 消える行は無い (この関数で作った組織・席の行・所属はそのまま残る)。
--
-- 何度流しても同じ結果になる (冪等: DROP FUNCTION IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.admin_create_organization(text, text, uuid);
