-- migration: 20261031130000_object_comments_trigger_names.sql
-- 戻し方: supabase/rollbacks/20261031130000_object_comments_trigger_names.down.sql
-- #2144 S4: 本番 DB のコメント (COMMENT) のうち、トリガーが呼ぶ関数の名前を「トリガー」と呼んでいる 6 つを、実際のトリガーの名前に直す。
--
-- 背景:
--   20261016243000_auth_history_sessions.sql の COMMENT ON COLUMN public.user_sessions_metadata.alert_status は、
--   pending の行を作る書き手を、トリガーが呼ぶ関数の名前で「トリガー」と呼んでいた。実際のトリガーの名前は、同じ migration の
--   CREATE TRIGGER が作る on_auth_session_created (auth.sessions の AFTER INSERT。関数 auth_session_created) で、
--   DB でトリガーを探す人 (pg_trigger の tgname) が見つけられない。設計書 docs/design/cross/16-auth-history-sessions.md §11.1 の写しは
--   新しい文 (トリガーの名前を書き、関数の名前は「関数 …」と書く) になっており、本番のコメントと食い違っていた。
--   #2141 (20261031120000) は同じ migration の user_profiles.last_login_at の列のコメントだけを出し直した。
--   ほかの既存の migration にも、同じ書き方の本番のコメントが 5 つ残っていた (tests/plan-stripe-product-id-guard-trigger-naming.test.ts の
--   FROZEN_MIGRATION_HITS に数えていたもののうち、COMMENT ON の文の中のもの):
--     - 関数 membership_audit_hash_email_in_metadata(jsonb) (20261016190000_deletion_record_and_invite_email_hash.sql)
--       → トリガー trg_membership_audit_hash_invite_email (関数 membership_audit_hash_invite_email)
--     - 表 account_deletion_guards (20261023130000_account_deletion_owner_guard.sql)
--       → トリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting)
--     - 関数 personal_subscription_hold_plan_key_share()・family_group_hold_plan_key_share()・organization_hold_plan_key_share()
--       (20261024130000_plan_deprecate_lock_and_price_change_reservation.sql)
--       → トリガー trg_guard_plan_deprecate_subscribers (関数 guard_plan_deprecate_subscribers)
--   既存の migration は編集しない (CLAUDE.md) ので、新しい migration でコメントを出し直す。各文は前の文の「トリガー <関数>」を
--   「トリガー <トリガー> (関数 <関数>)」に置き換えただけで、ほかの文字は変えない。
--   関数の本文の中の -- のコメント (20261019120000_self_dissolve.sql の family_dissolve_apply・
--   20261023130000_account_deletion_owner_guard.sql の begin_account_deletion_guard) は COMMENT では直せない (関数を作り直す) ので、ここでは扱わない。
--
-- 変更: COMMENT ON の 6 文だけ。表・列・行・関数・トリガー・ポリシー・権限は変えない。
-- 既存データへの影響: なし (カタログのコメントだけ)。
-- 冪等: COMMENT ON は上書きなので、2 回続けて適用してもエラーにならず同じ結果になる。
-- ロック: COMMENT ON COLUMN / TABLE は user_sessions_metadata・account_deletion_guards に SHARE UPDATE EXCLUSIVE を取る (読み書きは止めない)。
--   待ちが長引かないよう lock_timeout を付ける。
-- 確かめるテスト: tests/object-comments-trigger-names-migration-contract.test.ts (文面)・
--   tests/plan-stripe-product-id-guard-trigger-naming.test.ts (関数の名前を「トリガー」と呼ぶ所が無い・本番に最後に効くコメントにも無い)
-- ロールバック: supabase/rollbacks/20261031130000_object_comments_trigger_names.down.sql

SET LOCAL lock_timeout = '10s';

COMMENT ON COLUMN public.user_sessions_metadata.alert_status IS '不審なログインの通知の進み (pending → processing → done)。pending で作るのはトリガー on_auth_session_created (関数 auth_session_created) だけ。既定の done は、列を足した時点の行 (ロールバックの後にもう一度流したときに残っていた行) とトリガー以外が作る行を、通知の対象にしないため。cross/16 §10・§11.4';

COMMENT ON FUNCTION public.membership_audit_hash_email_in_metadata(jsonb) IS
  '#1562: membership_audit.metadata の email (招待先の生のアドレス) を取り除き、email_hash (membership_invite_email_hash) を入れる。トリガー trg_membership_audit_hash_invite_email (関数 membership_audit_hash_invite_email) と、既存の行の置き換えが使う。誰にも EXECUTE を付けない';

COMMENT ON TABLE public.account_deletion_guards IS
  '#1917 の続き (D73): 退会の印。begin_account_deletion_guard が退会の始め (findBlocker の前) に付け、トリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting) が組織の作成で読む。退会が済むと auth.users の CASCADE で消える。直接は誰も読み書きしない';

COMMENT ON FUNCTION public.personal_subscription_hold_plan_key_share() IS
  '#1917: 個人契約が数えられる行 (live 5 値) になる INSERT / UPDATE (書く前は live でない・plan_key を変えた) で、プランの行を FOR KEY SHARE でロックする。廃止のトリガー trg_guard_plan_deprecate_subscribers (関数 guard_plan_deprecate_subscribers) の FOR UPDATE と待ち合い、数えてから書くまでの間の契約を見落とさない (plan_key を変えない UPDATE は外部キーの確認でロックを取らないため)';

COMMENT ON FUNCTION public.family_group_hold_plan_key_share() IS
  '#1917: 家族のグループが数えられる行 (active) になる INSERT / UPDATE (書く前は active でない・plan_key を変えた) で、プランの行を FOR KEY SHARE でロックする。廃止のトリガー trg_guard_plan_deprecate_subscribers (関数 guard_plan_deprecate_subscribers) の FOR UPDATE と待ち合う';

COMMENT ON FUNCTION public.organization_hold_plan_key_share() IS
  '#1917: 組織が数えられる行 (active) になる INSERT / UPDATE (書く前は active でない・plan を変えた) で、plan と同じ plan_key のプランの行を FOR KEY SHARE でロックする (行が無ければ何もしない)。廃止のトリガー trg_guard_plan_deprecate_subscribers (関数 guard_plan_deprecate_subscribers) の FOR UPDATE と待ち合う';
