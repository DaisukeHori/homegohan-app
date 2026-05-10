-- migration: 20260511000111_membership_family_members.sql
-- (設計書 01-data-model.md §3.2)
-- 番号: 設計書指定 000011 → 000111 にシフト
-- P0 Critical Fix F15: CREATE TYPE は DO block、CREATE TABLE/INDEX は IF NOT EXISTS

-- CREATE TYPE は冪等にするため DO block でラップ
DO $$ BEGIN
  CREATE TYPE family_role_enum AS ENUM ('representative','adult','child');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS family_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL は子供の auth account なし
  role family_role_enum NOT NULL,
  display_name TEXT,                           -- family 内での呼称 (例: 「お母さん」「長男」)
  relationship TEXT,                            -- 'spouse','child','parent','grandparent','sibling','partner','roommate','other'
  tags TEXT[] NOT NULL DEFAULT '{}',           -- ['cooks_main','has_allergy','diet_restricted','needs_proxy_care','lives_apart','pet']
  -- 共有設定 (本メンバの記録を他家族メンバに見せるか)
  share_meals BOOLEAN NOT NULL DEFAULT TRUE,
  share_health BOOLEAN NOT NULL DEFAULT FALSE,
  share_menu BOOLEAN NOT NULL DEFAULT TRUE,
  -- 子供 (auth account なし) のプロフィール
  child_profile JSONB,
  -- avatar 表示用色 (#RRGGBB)
  avatar_color TEXT NOT NULL DEFAULT '#FF6B6B' CHECK (avatar_color ~ '^#[0-9A-Fa-f]{6}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ
);

-- 1 user は 1 family のみ (NULL の子供は除外)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_family_members_user
  ON family_members(user_id)
  WHERE user_id IS NOT NULL AND status = 'active';

-- 1 family につき representative は 1 名のみ
CREATE UNIQUE INDEX IF NOT EXISTS uniq_family_representative
  ON family_members(family_id)
  WHERE role = 'representative' AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_family_members_family ON family_members(family_id);
CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_members(user_id) WHERE user_id IS NOT NULL;

-- 整合性: child_profile は role='child' AND user_id IS NULL のときのみ
-- ★ Warning 3: DROP IF EXISTS で冪等に
ALTER TABLE family_members
  DROP CONSTRAINT IF EXISTS family_members_child_profile_consistency;
ALTER TABLE family_members
  ADD CONSTRAINT family_members_child_profile_consistency CHECK (
    (role = 'child' AND user_id IS NULL AND child_profile IS NOT NULL)
    OR (user_id IS NOT NULL AND child_profile IS NULL)
  );
