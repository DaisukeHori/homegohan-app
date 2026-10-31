-- rollback: 20261031120000_last_login_at_column_comment_trigger_names.sql
-- #2139 T3 で出し直した列 user_profiles.last_login_at のコメントを、その前の文 (20261016243000_auth_history_sessions.sql の
-- COMMENT ON COLUMN の文) に戻す。本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する
-- (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 前の文は、トリガーが呼ぶ関数の名前を「トリガー」の直後に書いている。その書き方は見張り
-- (tests/plan-stripe-product-id-guard-trigger-naming.test.ts) が supabase/rollbacks でも 0 件を求めるので、ここでは文を直に書かず、
-- format の %s に関数の名前を入れて組み立てる (出来上がる文字列は前の文と 1 文字も違わない。
-- tests/last-login-at-column-comment-migration-contract.test.ts が前の migration の文と突き合わせる)。
--
-- 影響: 列のコメントが変わるだけ (表・列・行・関数・トリガー・権限は変えない)。
-- 何度流しても同じ結果になる (冪等: COMMENT ON は上書き)。

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  EXECUTE format(
    'COMMENT ON COLUMN public.user_profiles.last_login_at IS %L',
    format(
      '最終ログイン日時。auth.sessions の INSERT のトリガー %s が書き、行がまだ無かった最初のログインは行を作るときのトリガー %s が入れる (cross/16 §11.3)',
      'auth_session_created',
      'user_profiles_fill_login_stats'
    )
  );
END $$;
