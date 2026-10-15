-- rollback: 20261016163600_user_push_tokens_install_secret.sql
-- ⚠️ 守りが弱くなる: 戻すと、通知のトークンの値を知っているだけの他人が、claim で持ち主の行を消せる状態 (#1636 の前) に戻る。
--    明示的な承認を得た場合に限って使う。
--
-- 内容:
--   1. 索引 idx_user_push_tokens_expo_push_token を削除する
--   2. CHECK 制約 user_push_tokens_install_secret_hash_format を削除する
--   3. 列 install_secret_hash を削除する (列に入っていたハッシュは消える。端末の保管庫の秘密の値は残るが、使われなくなる)
--
-- 先にアプリの API (POST /api/push-tokens/claim の install_secret の扱いと、POST /api/push-tokens/release) を
-- #1636 の前に戻すこと。先にこのロールバックを当てると、claim と release が 500 になる (列が無いため)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (冪等)。

DROP INDEX IF EXISTS public.idx_user_push_tokens_expo_push_token;

ALTER TABLE public.user_push_tokens
  DROP CONSTRAINT IF EXISTS user_push_tokens_install_secret_hash_format;

ALTER TABLE public.user_push_tokens
  DROP COLUMN IF EXISTS install_secret_hash;
