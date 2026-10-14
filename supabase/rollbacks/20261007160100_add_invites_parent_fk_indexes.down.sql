-- rollback: 20261007160100_add_invites_parent_fk_indexes.sql
-- 権限・データは変わらない。戻すと #1218 の状態 (招待の一覧取得 GET /api/org/invites・GET /api/family/invites と、
--    親 (organizations / family_groups) を消したときの ON DELETE CASCADE が、招待テーブル全体を読む状態) に戻るだけ。
--
-- 内容: 足した索引 2 本を消す。ほかの索引 (uniq_org_invites_pending / uniq_family_invites_pending などの部分ユニーク索引、
--       token / email の索引) には触れない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP INDEX IF EXISTS public.idx_organization_invites_org_created;
DROP INDEX IF EXISTS public.idx_family_invites_family_created;
