-- #348: user_profiles.roles カラムを追加
-- middleware の resolveOnboardingRedirect が roles を SELECT しているが
-- migration で未定義だったため、新規 DB 環境でクエリ失敗 → data=null →
-- not_started 扱いで /onboarding/welcome へ誤 redirect が発生していた。
-- embedding_jobs の RLS ポリシーでも参照されており、本来必須のカラム。

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS roles TEXT[] DEFAULT '{}'::text[];
