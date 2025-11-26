-- 管理機能用スキーマ拡張

-- 1. ユーザーロールの追加
-- 既存テーブルへのカラム追加
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';

-- 2. お知らせ（Announcements）テーブル
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_public BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 管理者操作ログ（Audit Log）
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES auth.users(id),
  action_type TEXT NOT NULL, -- 'delete_post', 'ban_user', 'send_announcement'
  target_id UUID, -- 対象のmeal_idやuser_id
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. RLSポリシー（管理者のみアクセス可能）
-- ※ Supabaseのダッシュボード等で、特定ユーザーの role を 'admin' に設定する必要があります

-- お知らせ: 全員閲覧可（公開のみ）、管理者は全権限
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public announcements are viewable by everyone" ON announcements
  FOR SELECT USING (is_public = true);

CREATE POLICY "Admins can manage announcements" ON announcements
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- 監査ログ: 管理者のみ閲覧・作成
ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view audit logs" ON admin_audit_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Admins can create audit logs" ON admin_audit_logs
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );



