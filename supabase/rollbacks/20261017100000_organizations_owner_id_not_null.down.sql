-- rollback: 20261017100000_organizations_owner_id_not_null.sql
-- ⚠️ 消した行は戻せない: migration が消した組織 (owner_id が NULL でメンバーが 0 人だった組織) と、その org_license_pools の行
--    (ON DELETE CASCADE) は、このロールバックでは戻らない。戻すのは organizations.owner_id の NOT NULL だけ。
--    migration が埋めた owner_id (org_role = 'owner' の利用者) もそのまま残す (NULL に戻さない)。
--
-- 内容:
--   1. organizations.owner_id の NOT NULL を外す (本番の元の定義 = nullable に戻す)
--   外部キー organizations_owner_id_fkey・索引・RLS・関数は migration で変えていないので触らない。
-- 先にアプリのデプロイを戻す必要は無い (アプリは組織を作るときに owner_id を必ず入れ、読むときは NULL も扱える)。
-- 本番に戻すときは、この内容を新しい migration として PR 経由で適用する。
-- 何度流しても同じ結果になる (冪等。DROP NOT NULL は付いていなくても成功する)。

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.organizations ALTER COLUMN owner_id DROP NOT NULL;
