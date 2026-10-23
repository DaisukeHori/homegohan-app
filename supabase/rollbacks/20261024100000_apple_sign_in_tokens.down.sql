-- rollback: 20261024100000_apple_sign_in_tokens.sql
-- Sign in with Apple の refresh token の表を外す。本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。
-- ⚠️ 先にアプリを戻すこと: src/lib/auth/apple/tokens.ts が表を読み書きする (無ければ保管と失効が失敗のログになるだけで、ログインと退会は止まらない)。
-- 影響: 保管していた refresh token は消え、その利用者の退会では Apple 側の失効を行えなくなる。
-- 何度流しても同じ結果になる (DROP ... IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS public.apple_sign_in_tokens;
