-- #264: health_checkups に (user_id, checkup_date) の UNIQUE 制約を追加
-- 同一ユーザーの同一日の重複登録を DB レベルで防ぐ

ALTER TABLE health_checkups
  ADD CONSTRAINT health_checkups_user_date_unique
  UNIQUE (user_id, checkup_date);
