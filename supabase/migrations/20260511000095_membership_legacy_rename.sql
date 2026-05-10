-- migration: 20260511000095_membership_legacy_rename.sql
-- P0 Critical Fix F1
-- 旧 family_groups / family_members (食事管理用) を rename して、
-- 000110/000111 の CREATE TABLE との衝突を回避する

DO $$ BEGIN
  -- family_groups: 旧 schema は id/name/owner_id/created_at/updated_at パターン
  -- 新 schema は representative_id カラムを持つ
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'family_groups' AND schemaname = 'public') THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'family_groups' AND column_name = 'name'
        AND table_schema = 'public'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'family_groups' AND column_name = 'representative_id'
        AND table_schema = 'public'
    ) THEN
      ALTER TABLE family_groups RENAME TO legacy_family_groups;
    END IF;
  END IF;

  -- family_members: 旧 schema は relation カラムを持つ
  -- 新 schema は role/status カラムを持つ
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'family_members' AND schemaname = 'public') THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'family_members' AND column_name = 'relation'
        AND table_schema = 'public'
    ) THEN
      ALTER TABLE family_members RENAME TO legacy_family_members;
    END IF;
  END IF;
END $$;
