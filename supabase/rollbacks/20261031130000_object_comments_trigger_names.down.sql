-- rollback: 20261031130000_object_comments_trigger_names.sql
-- #2144 S4 で出し直した 6 つのコメント (列 user_sessions_metadata.alert_status・関数 membership_audit_hash_email_in_metadata(jsonb)・
-- 表 account_deletion_guards・関数 personal_subscription_hold_plan_key_share() / family_group_hold_plan_key_share() /
-- organization_hold_plan_key_share()) を、その前の文 (それぞれを出した既存の migration の COMMENT ON の文) に戻す。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 前の文は、トリガーが呼ぶ関数の名前を「トリガー」の直後に書いている。その書き方は見張り
-- (tests/plan-stripe-product-id-guard-trigger-naming.test.ts) が supabase/rollbacks でも 0 件を求めるので、ここでは文を直に書かず、
-- format の %s に関数の名前を入れて組み立てる (出来上がる文字列は前の文と 1 文字も違わない。
-- tests/object-comments-trigger-names-migration-contract.test.ts が前の migration の文と突き合わせる)。
--
-- 影響: コメントが変わるだけ (表・列・行・関数・トリガー・権限は変えない)。
-- 何度流しても同じ結果になる (冪等: COMMENT ON は上書き)。

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  EXECUTE format(
    'COMMENT ON COLUMN public.user_sessions_metadata.alert_status IS %L',
    format(
      '不審なログインの通知の進み (pending → processing → done)。pending で作るのはトリガー %s だけ。既定の done は、列を足した時点の行 (ロールバックの後にもう一度流したときに残っていた行) とトリガー以外が作る行を、通知の対象にしないため。cross/16 §10・§11.4',
      'auth_session_created'
    )
  );
  EXECUTE format(
    'COMMENT ON FUNCTION public.membership_audit_hash_email_in_metadata(jsonb) IS %L',
    format(
      '#1562: membership_audit.metadata の email (招待先の生のアドレス) を取り除き、email_hash (membership_invite_email_hash) を入れる。トリガー %s と、既存の行の置き換えが使う。誰にも EXECUTE を付けない',
      'membership_audit_hash_invite_email'
    )
  );
  EXECUTE format(
    'COMMENT ON TABLE public.account_deletion_guards IS %L',
    format(
      '#1917 の続き (D73): 退会の印。begin_account_deletion_guard が退会の始め (findBlocker の前) に付け、トリガー %s が組織の作成で読む。退会が済むと auth.users の CASCADE で消える。直接は誰も読み書きしない',
      'organizations_owner_not_deleting'
    )
  );
  EXECUTE format(
    'COMMENT ON FUNCTION public.personal_subscription_hold_plan_key_share() IS %L',
    format(
      '#1917: 個人契約が数えられる行 (live 5 値) になる INSERT / UPDATE (書く前は live でない・plan_key を変えた) で、プランの行を FOR KEY SHARE でロックする。廃止のトリガー %s の FOR UPDATE と待ち合い、数えてから書くまでの間の契約を見落とさない (plan_key を変えない UPDATE は外部キーの確認でロックを取らないため)',
      'guard_plan_deprecate_subscribers'
    )
  );
  EXECUTE format(
    'COMMENT ON FUNCTION public.family_group_hold_plan_key_share() IS %L',
    format(
      '#1917: 家族のグループが数えられる行 (active) になる INSERT / UPDATE (書く前は active でない・plan_key を変えた) で、プランの行を FOR KEY SHARE でロックする。廃止のトリガー %s の FOR UPDATE と待ち合う',
      'guard_plan_deprecate_subscribers'
    )
  );
  EXECUTE format(
    'COMMENT ON FUNCTION public.organization_hold_plan_key_share() IS %L',
    format(
      '#1917: 組織が数えられる行 (active) になる INSERT / UPDATE (書く前は active でない・plan を変えた) で、plan と同じ plan_key のプランの行を FOR KEY SHARE でロックする (行が無ければ何もしない)。廃止のトリガー %s の FOR UPDATE と待ち合う',
      'guard_plan_deprecate_subscribers'
    )
  );
END $$;
