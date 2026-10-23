-- migration: 20261024100000_apple_sign_in_tokens.sql
-- 戻し方: supabase/rollbacks/20261024100000_apple_sign_in_tokens.down.sql
-- Sign in with Apple (docs/design/mobile/08-sign-in-with-apple.md §8): Apple が発行した refresh token を、退会のときに
-- Apple の失効の API (/auth/revoke) へ渡すためだけに保管する表。client_id は token を得た client (iOS の bundle ID か Web の Services ID)
-- で、失効のときの client_secret の sub に使う。
-- 読み書きは service_role の client だけ (src/lib/auth/apple/tokens.ts)。利用者 (anon / authenticated) は読めず書けない。
-- 退会で auth.users の行が消えると CASCADE で消える (失効は src/lib/account-deletion.ts の段階 apple_revoke が delete_user の前に行う)。
-- 権限の定型 (#1039/#1020): 新しい表には既定の権限で anon / authenticated に権限が付くので REVOKE ALL で外す。service_role は既定のまま。
-- 既存データへの影響: なし (表を作るだけ)。冪等: CREATE TABLE IF NOT EXISTS。
-- 確認: tests/apple-sign-in-tokens-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.apple_sign_in_tokens (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  refresh_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, client_id)
);

ALTER TABLE public.apple_sign_in_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.apple_sign_in_tokens FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.apple_sign_in_tokens IS
  'Sign in with Apple の refresh token (退会のときの失効に使う。docs/design/mobile/08-sign-in-with-apple.md §8)。client_id は token を得た client (bundle ID / Services ID)。service_role だけが読み書きする。auth.users の削除で消える';
