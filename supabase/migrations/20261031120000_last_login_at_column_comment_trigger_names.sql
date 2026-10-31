-- migration: 20261031120000_last_login_at_column_comment_trigger_names.sql
-- 戻し方: supabase/rollbacks/20261031120000_last_login_at_column_comment_trigger_names.down.sql
-- #2139 T3: 列 user_profiles.last_login_at のコメント (本番 DB の COMMENT) の「トリガー」の呼び方を、実際のトリガーの名前に直す。
--
-- 背景:
--   20261016243000_auth_history_sessions.sql の COMMENT ON COLUMN public.user_profiles.last_login_at は、この列の書き手を
--   トリガーが呼ぶ関数の名前で「トリガー」と呼んでいた。実際のトリガーの名前は、同じ migration の CREATE TRIGGER が作る
--   on_auth_session_created (auth.sessions の AFTER INSERT。関数 auth_session_created) と
--   trg_user_profiles_fill_login_stats (user_profiles の BEFORE INSERT。関数 user_profiles_fill_login_stats) で、
--   DB でトリガーを探す人 (pg_trigger の tgname) が見つけられない。設計書 docs/design/cross/16-auth-history-sessions.md §11.3 の写しは
--   新しい文 (トリガーの名前を書き、関数の名前は「関数 …」と書く) になっており、本番のコメントと食い違っていた。
--   既存の migration は編集しない (CLAUDE.md) ので、新しい migration で列のコメントを出し直す。
--
-- 変更: COMMENT ON COLUMN の 1 文だけ。表・列・行・関数・トリガー・ポリシー・権限は変えない。
-- 既存データへの影響: なし (カタログの列のコメントだけ)。
-- 冪等: COMMENT ON は上書きなので、2 回続けて適用してもエラーにならず同じ結果になる。
-- ロック: COMMENT ON COLUMN は user_profiles に SHARE UPDATE EXCLUSIVE を取る (読み書きは止めない)。待ちが長引かないよう lock_timeout を付ける。
-- 確かめるテスト: tests/last-login-at-column-comment-migration-contract.test.ts (文面)・
--   tests/plan-stripe-product-id-guard-trigger-naming.test.ts (関数の名前を「トリガー」と呼ぶ所が無い)
-- ロールバック: supabase/rollbacks/20261031120000_last_login_at_column_comment_trigger_names.down.sql

SET LOCAL lock_timeout = '10s';

COMMENT ON COLUMN public.user_profiles.last_login_at IS '最終ログイン日時。auth.sessions の INSERT のトリガー on_auth_session_created (関数 auth_session_created) が書き、行がまだ無かった最初のログインは行を作るときのトリガー trg_user_profiles_fill_login_stats (関数 user_profiles_fill_login_stats) が入れる (cross/16 §11.3)';
