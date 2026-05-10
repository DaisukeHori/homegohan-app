-- migration: 20260511000114_membership_family_rls.sql
-- (設計書 01-data-model.md §3.5)
-- 番号: 設計書指定 000014 → 000114 にシフト

ALTER TABLE family_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_invites ENABLE ROW LEVEL SECURITY;

-- family_groups
DROP POLICY IF EXISTS family_groups_select_member ON family_groups;
CREATE POLICY family_groups_select_member ON family_groups
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_groups.id AND fm.user_id = auth.uid() AND fm.status = 'active'
    )
  );

DROP POLICY IF EXISTS family_groups_update_adult ON family_groups;
CREATE POLICY family_groups_update_adult ON family_groups
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_groups.id AND fm.user_id = auth.uid()
        AND fm.role IN ('representative','adult') AND fm.status = 'active'
    )
  );

DROP POLICY IF EXISTS family_groups_delete_representative ON family_groups;
CREATE POLICY family_groups_delete_representative ON family_groups
  FOR DELETE USING (family_groups.representative_id = auth.uid());

-- family_members
DROP POLICY IF EXISTS family_members_select_self_or_family ON family_members;
CREATE POLICY family_members_select_self_or_family ON family_members
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_members.family_id AND fm.user_id = auth.uid() AND fm.status = 'active'
    )
  );

DROP POLICY IF EXISTS family_members_update_self_or_adult ON family_members;
CREATE POLICY family_members_update_self_or_adult ON family_members
  FOR UPDATE USING (
    user_id = auth.uid()  -- 自身の share_* / display_name 等更新
    OR EXISTS (  -- adult/representative は他メンバの role/tags 更新可
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_members.family_id AND fm.user_id = auth.uid()
        AND fm.role IN ('representative','adult') AND fm.status = 'active'
    )
  );

-- family_invites
DROP POLICY IF EXISTS family_invites_select_adult ON family_invites;
CREATE POLICY family_invites_select_adult ON family_invites
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_invites.family_id AND fm.user_id = auth.uid()
        AND fm.role IN ('representative','adult') AND fm.status = 'active'
    )
  );

-- P0 Critical Fix F10: INSERT/UPDATE policy 追加 (欠如により RLS 有効時に招待発行不可)
DROP POLICY IF EXISTS family_invites_insert_adult ON family_invites;
CREATE POLICY family_invites_insert_adult ON family_invites
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_invites.family_id AND fm.user_id = auth.uid()
        AND fm.role IN ('representative','adult') AND fm.status = 'active'
    )
  );

DROP POLICY IF EXISTS family_invites_update_adult ON family_invites;
CREATE POLICY family_invites_update_adult ON family_invites
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_invites.family_id AND fm.user_id = auth.uid()
        AND fm.role IN ('representative','adult') AND fm.status = 'active'
    )
  );
