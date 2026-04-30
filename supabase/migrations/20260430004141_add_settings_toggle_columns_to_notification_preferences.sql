-- Issue #69: 通知/自動解析/データシェア toggle を永続化するためのカラム追加
CREATE TABLE IF NOT EXISTS notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'notification_preferences' AND policyname = 'own row'
  ) THEN
    CREATE POLICY "own row" ON notification_preferences
      FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS auto_analyze_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS data_share_enabled boolean NOT NULL DEFAULT false;
;
