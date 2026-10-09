-- migration: 20261008200400_auth_users_fk_on_delete.sql
-- 退会 (auth.admin.deleteUser) が外部キーで失敗しないようにし、残す記録からは個人を特定できないようにする (#1175)
--
-- 背景:
--   auth.users を参照する外部キーのうち 33 本は ON DELETE の指定が無く (= NO ACTION)、参照している行が 1 つでも残っていると
--   auth.users の行を消せない (外部キー違反 23503)。退会 API (POST /api/account/delete) は 11 テーブルだけを事前に掃除していて、
--   support_tickets / support_ticket_messages / email_delivery_logs / coupon_redemptions / referral_rewards / nps_surveys /
--   csat_feedbacks / experiment_assignments / gdpr_deletion_requests / sales_lead_activities / infra_alerts などは対象外だった。
--   その利用者・運営者が 1 件でも書き込んでいると、削除は 500 で失敗する (消去権の行使が黙って失敗する)。
--   実際に使われている経路もある: 運営がチケットを起票する (support_tickets)、チケットに返信してメールを送る (email_delivery_logs)。
--   さらに admin_audit_logs には、同じ actor_id 列を指す外部キーが 2 本あった:
--     admin_audit_logs_actor_id_fkey (ON DELETE SET NULL) と、古い名前の admin_audit_logs_admin_id_fkey (NO ACTION)。
--   古い方が残っているため、SET NULL の方があっても削除は止まる。
--   退会 API が「admin_audit_logs.admin_id を NULL にする」更新を送っていたが、その列は存在しない (actor_id に改名済み) ので何もしていなかった。
--
-- 決めたルール (オーナー判断 2026-10-08、#1175):
--   1. 本人だけの記録は、本人と一緒に消す (CASCADE):
--        nps_surveys / csat_feedbacks / experiment_assignments / ai_content_logs (AI へ送った文面と応答を含む)
--   2. 運営者・作成者・承認者を指す列は、退会しても記録そのものを残す (SET NULL):
--        誰がやったかの紐づけだけが外れる。作成日時・内容は残る。
--   3. サポート・会計のために残す記録は、行を残して本人との紐づけだけを外す (列を NULL を許す形にして SET NULL):
--        support_tickets / support_ticket_messages / coupon_redemptions / referral_rewards
--        (どれも、誰の記録かが分からなくなるだけ。何年残すかは税理士の確認待ちで、この migration は消去の期限を決めない)
--      同じ考えで、gdpr_deletion_requests (削除要求の記録) と email_delivery_logs (メール配信ログ) も行を残す。
--   4. admin_audit_logs の重複した外部キー (admin_audit_logs_admin_id_fkey) は外す。
--   5. 組織のオーナー (organizations.owner_id) と家族の代表者 (family_groups.representative_id) の ON DELETE RESTRICT は
--      そのまま残す。譲渡か解散をしないと退会できないという仕様で、退会 API は先に 409 を返してこの状態で止める。
--
-- 変更:
--   A. NOT NULL を外す列 (SET NULL にするため。外すだけなので既存の行は変わらない) 10 列
--        support_tickets.user_id / support_ticket_messages.sender_id / referral_rewards.referrer_id / referral_rewards.referred_id /
--        gdpr_deletion_requests.user_id / coupons.created_by / experiments.created_by / help_articles.created_by /
--        plan_price_history.changed_by / sales_lead_activities.actor_id
--   B. coupon_redemptions: 匿名化の印 anonymized_at を足し、CHECK 制約 coupon_redemptions_user_or_org を
--      「user_id か organization_id のどちらかがある、または anonymized_at がある」に緩める。
--        本人宛 (user_id だけが入っていて organization_id が NULL) の償還記録で user_id が NULL になると、元の CHECK に違反して
--        退会が失敗する。外部キーの SET NULL は他の列を同時に書けないので、user_id が NOT NULL → NULL に変わる更新だけを
--        拾う BEFORE UPDATE OF user_id トリガーで anonymized_at を自動で入れる (どの経路で退会しても同じ結果になる)。
--        CHECK は受け入れる範囲を広げるだけなので、既存の行は必ず通る。ほかの CHECK は足さない。
--   C. NO ACTION だった外部キー 33 本のうち、32 本の ON DELETE を張り直し (DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT を
--      1 つの ALTER TABLE で)、重複していた 1 本 (admin_audit_logs_admin_id_fkey) を外す。
--      対象の表・列・旧→新の一覧は、各 ALTER TABLE の直前のコメントと PR の説明を参照。
--   D. prepare_account_deletion(p_user_id uuid) を新設する (SECURITY DEFINER、EXECUTE は service_role だけ)。
--        退会の直前に呼び、本人の生のメールアドレスを残す記録を、削除の前に伏せる。件数だけの jsonb を返す (メールアドレスは返さない)。
--          - email_delivery_logs.email   本人宛のログ (user_id が本人、または宛先が本人のアドレス)
--          - inquiries.email             本人の問い合わせ (user_id が本人、または同じアドレス)。※ inquiries に name 列は無い
--          - organization_invites / family_invites   本人のアドレス宛の招待、または本人が受諾した招待。まだ pending のものは revoked にする
--          - family_promotion_requests   本人のアドレス宛の昇格リクエスト。まだ pending のものは revoked にする
--        伏せる値は固定の 'redacted@redacted.invalid' (RFC 2606 の予約ドメインなので、実在するアドレスにならない)。
--        もうひとつ、アドレスの話ではないが同じ「退会で個人の記録が公開されてしまう」問題として、本人の非公開レシピを消す:
--          - recipes.user_id は ON DELETE SET NULL (この migration では変えない) で、user_id が NULL の行は RLS
--            ("Users can view public recipes": user_id IS NULL OR is_public OR 本人) で全員に見える。
--            退会で user_id が外れると、非公開 (is_public が false / NULL) のレシピまで全員に読めるようになる。
--            そのため、退会の直前に本人の非公開レシピだけを消す (recipes を指す外部キーはすべて ON DELETE CASCADE)。
--            公開レシピは、他の利用者のコレクション・いいね・コメントが付いていることがあるので残す (user_id だけが外れる)。
--        伏せないもの (理由つき):
--          - email_blacklist (宛先停止リスト): 苦情・バウンスのあったアドレスへ二度と送らないための記録で、消すと再び送ってしまう。
--          - membership_audit.metadata の招待先アドレス: #1163 の 24 時間の送信上限 (20261008100000) がこの値を数えている。
--            伏せると、退会した人のアドレスへの上限が戻ってしまう。ハッシュに置き換える案を含め、扱いは別途決める (PR の説明を参照)。
--          - admin_audit_logs.actor_email_snapshot: 運営者の操作を監査のために残す記録。
--
-- 設計上の判断:
--   - CHECK 制約は新しく足さない (足すと、本番に違反した既存行があるとその行がどの列の更新でも失敗するため)。
--     足すのは、受け入れる範囲を広げる coupon_redemptions_user_or_org の置き換えだけ。
--   - NOT NULL を外した列を読むコードは、NULL を「退会した利用者 / 退会した運営者」として扱う。管理 API は値をそのまま返すだけで、
--     NULL で落ちる箇所は無かった。support_tickets.user_id を宛先・監査の対象に使う 2 か所 (チケット返信メール、チケット閲覧の
--     監査記録) だけ、NULL のときの扱いを足した (PR の説明を参照)。
--   - 家族の招待・昇格リクエストを書き換える前に、関係する family_groups の行を FOR NO KEY UPDATE でロックする
--     (CLAUDE.md の「家族 (family_*) を変える関数のロック順」。解散・強制解散と逆順にならないようにする)。
--   - SECURITY DEFINER、SET search_path = ''、関数内の参照はすべて完全修飾。
--     関数の中では呼び出し元を確認しない: EXECUTE 権限 (service_role だけ) が唯一の境界。
--     呼ぶのは、ログイン済みの本人を確認した退会 API (src/lib/account-deletion.ts) だけ。
--   - 新しい関数は Supabase の既定権限で anon / authenticated / service_role に EXECUTE が自動付与され、PUBLIC にも付く。
--     引数の型まで含めた完全形で REVOKE する (20261007160800 と同じ理屈)。prepare_account_deletion は service_role にだけ GRANT し直し、
--     トリガー関数 coupon_redemptions_mark_anonymized は誰にも GRANT しない (トリガーとして動くときは EXECUTE を確認されない)。
--
-- 既存データへの影響:
--   - 既存の行を書き換える UPDATE / DELETE 文は無い (データの修復はしない)。外部キーを張り直すときに既存の行を検証するだけで、
--     今までも同じ参照が成立していたので、必ず通る。
--   - prepare_account_deletion は、退会のときに呼ばれて初めて、その人の行を書き換える・消す (この migration では呼ばない)。
--     消すのは、退会する本人の非公開レシピだけ。他の人の行は変えない。
--   - 外部キーの張り直しは、各表と auth.users に SHARE ROW EXCLUSIVE ロック (読み取りは待たされない。書き込みが待たされる) を、
--     この migration のトランザクションが終わるまで取る。対象の表は小さい (ほとんどが空) ので、ロックは一瞬で終わる。
--     ロックが取れずに待ち続けると、後ろに並んだ書き込み (ログインによる auth.users の更新など) まで待たされるので、
--     待ちに上限を付ける (SET LOCAL lock_timeout = '10s')。失敗しても migration 全体が巻き戻るだけで、再実行すれば直る。
--
-- 冪等: ADD COLUMN IF NOT EXISTS / DROP NOT NULL / DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT / CREATE OR REPLACE FUNCTION /
--   DROP TRIGGER IF EXISTS + CREATE TRIGGER。2 回続けて流しても同じ結果になる。
-- 適用順: migration は version 順にマージする (この version: 20261008200400)。退会 API のコードと同じ PR。
--   コードが migration より先に出ると、prepare_account_deletion が無いため退会は ACCOUNT_DELETE_FAILED (500) で止まる
--   (何も消えない。migration が入れば再試行できる)。
-- ロールバック: supabase/rollbacks/20261008200400_auth_users_fk_on_delete.down.sql
-- 確認: tests/integration/security/auth-users-fk-on-delete.test.ts / tests/integration/security/account-deletion.test.ts /
--       tests/integration/security/account-delete-route.test.ts

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- A. NOT NULL を外す (SET NULL にする列)
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.support_tickets         ALTER COLUMN user_id      DROP NOT NULL;
ALTER TABLE public.support_ticket_messages ALTER COLUMN sender_id    DROP NOT NULL;
ALTER TABLE public.referral_rewards        ALTER COLUMN referrer_id  DROP NOT NULL;
ALTER TABLE public.referral_rewards        ALTER COLUMN referred_id  DROP NOT NULL;
ALTER TABLE public.gdpr_deletion_requests  ALTER COLUMN user_id      DROP NOT NULL;
ALTER TABLE public.coupons                 ALTER COLUMN created_by   DROP NOT NULL;
ALTER TABLE public.experiments             ALTER COLUMN created_by   DROP NOT NULL;
ALTER TABLE public.help_articles           ALTER COLUMN created_by   DROP NOT NULL;
ALTER TABLE public.plan_price_history      ALTER COLUMN changed_by   DROP NOT NULL;
ALTER TABLE public.sales_lead_activities   ALTER COLUMN actor_id     DROP NOT NULL;

-- ─────────────────────────────────────────────────────────
-- B. coupon_redemptions: 匿名化の印と、緩めた CHECK 制約
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.coupon_redemptions
  ADD COLUMN IF NOT EXISTS anonymized_at timestamp with time zone;

COMMENT ON COLUMN public.coupon_redemptions.anonymized_at IS
  '#1175: 退会などで user_id が外れた (NULL にされた) 日時。NULL = 外れていない。user_id も organization_id も無い償還記録を CHECK 制約に通すための印';

ALTER TABLE public.coupon_redemptions
  DROP CONSTRAINT IF EXISTS coupon_redemptions_user_or_org,
  ADD CONSTRAINT coupon_redemptions_user_or_org
    CHECK (user_id IS NOT NULL OR organization_id IS NOT NULL OR anonymized_at IS NOT NULL);

-- user_id が NOT NULL → NULL に変わる更新 (外部キーの ON DELETE SET NULL が行う更新) で、anonymized_at を自動で入れる。
-- 関数は SECURITY INVOKER (他の表を読まない)。
-- トリガーとして動くときは EXECUTE 権限を確認されない (確認されるのは CREATE TRIGGER の時だけ) ので、
-- 新しい関数に Supabase の既定で付く EXECUTE (PUBLIC / anon / authenticated / service_role) は外しておく
-- (membership_audit のトリガー関数 audit_organization_invite_created と同じ扱い。関数を直接呼ぶ口を作らない)。
CREATE OR REPLACE FUNCTION public.coupon_redemptions_mark_anonymized()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL AND NEW.anonymized_at IS NULL THEN
    NEW.anonymized_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.coupon_redemptions_mark_anonymized() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_coupon_redemptions_mark_anonymized ON public.coupon_redemptions;
CREATE TRIGGER trg_coupon_redemptions_mark_anonymized
  BEFORE UPDATE OF user_id ON public.coupon_redemptions
  FOR EACH ROW
  EXECUTE FUNCTION public.coupon_redemptions_mark_anonymized();

-- ─────────────────────────────────────────────────────────
-- C. auth.users を指す外部キーの ON DELETE を張り直す (33 本)
--    表.列 : 旧 → 新   (理由)
-- ─────────────────────────────────────────────────────────

-- C-1. 本人だけの記録: 本人と一緒に消す (CASCADE)
-- nps_surveys.user_id : NO ACTION → CASCADE (NPS アンケートの回答。本人の意見と自由記述)
ALTER TABLE public.nps_surveys
  DROP CONSTRAINT IF EXISTS nps_surveys_user_id_fkey,
  ADD CONSTRAINT nps_surveys_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

-- csat_feedbacks.user_id : NO ACTION → CASCADE (CSAT の回答。本人の自由記述を含む)
ALTER TABLE public.csat_feedbacks
  DROP CONSTRAINT IF EXISTS csat_feedbacks_user_id_fkey,
  ADD CONSTRAINT csat_feedbacks_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

-- experiment_assignments.user_id : NO ACTION → CASCADE (A/B テストの割り当て。本人にだけ意味がある)
ALTER TABLE public.experiment_assignments
  DROP CONSTRAINT IF EXISTS experiment_assignments_user_id_fkey,
  ADD CONSTRAINT experiment_assignments_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

-- ai_content_logs.user_id : NO ACTION → CASCADE (AI へ送った文面と応答。従来は退会 API が先に DELETE していた)
ALTER TABLE public.ai_content_logs
  DROP CONSTRAINT IF EXISTS ai_content_logs_user_id_fkey,
  ADD CONSTRAINT ai_content_logs_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

-- C-2. サポート・会計のために残す記録: 行は残し、本人との紐づけだけ外す (SET NULL)
-- support_tickets.user_id : NO ACTION → SET NULL (チケットの起票者。件名・本文は残る。NOT NULL は A で外した)
ALTER TABLE public.support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_user_id_fkey,
  ADD CONSTRAINT support_tickets_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- support_ticket_messages.sender_id : NO ACTION → SET NULL (メッセージの送信者。本人でも運営でも、消えた人の分だけ NULL になる)
ALTER TABLE public.support_ticket_messages
  DROP CONSTRAINT IF EXISTS support_ticket_messages_sender_id_fkey,
  ADD CONSTRAINT support_ticket_messages_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- coupon_redemptions.user_id : NO ACTION → SET NULL (クーポンの償還記録。B のトリガーが anonymized_at を入れる)
ALTER TABLE public.coupon_redemptions
  DROP CONSTRAINT IF EXISTS coupon_redemptions_user_id_fkey,
  ADD CONSTRAINT coupon_redemptions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- referral_rewards.referrer_id / referred_id : NO ACTION → SET NULL (紹介報酬。紹介した人・された人のどちらが消えても行は残す)
ALTER TABLE public.referral_rewards
  DROP CONSTRAINT IF EXISTS referral_rewards_referrer_id_fkey,
  ADD CONSTRAINT referral_rewards_referrer_id_fkey
    FOREIGN KEY (referrer_id) REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.referral_rewards
  DROP CONSTRAINT IF EXISTS referral_rewards_referred_id_fkey,
  ADD CONSTRAINT referral_rewards_referred_id_fkey
    FOREIGN KEY (referred_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- gdpr_deletion_requests.user_id : NO ACTION → SET NULL (削除要求の記録。誰の要求かが分からなくなるだけで、要求と実行の日時は残る)
ALTER TABLE public.gdpr_deletion_requests
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_user_id_fkey,
  ADD CONSTRAINT gdpr_deletion_requests_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- email_delivery_logs.user_id : NO ACTION → SET NULL (メール配信ログ。生のメールアドレスは prepare_account_deletion が伏せる)
ALTER TABLE public.email_delivery_logs
  DROP CONSTRAINT IF EXISTS email_delivery_logs_user_id_fkey,
  ADD CONSTRAINT email_delivery_logs_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- C-3. 運営者・作成者・承認者などの参照: 記録は残し、誰がやったかの紐づけだけ外す (SET NULL)
-- admin_audit_logs : 古い名前の重複した外部キー admin_audit_logs_admin_id_fkey (actor_id、NO ACTION) を外す
--   (同じ列には admin_audit_logs_actor_id_fkey (ON DELETE SET NULL) が既にある)
ALTER TABLE public.admin_audit_logs
  DROP CONSTRAINT IF EXISTS admin_audit_logs_admin_id_fkey;

-- admin_user_notes.admin_id : NO ACTION → SET NULL (運営メモを書いた人)
ALTER TABLE public.admin_user_notes
  DROP CONSTRAINT IF EXISTS admin_user_notes_admin_id_fkey,
  ADD CONSTRAINT admin_user_notes_admin_id_fkey
    FOREIGN KEY (admin_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- announcements.created_by : NO ACTION → SET NULL (お知らせを作った人)
ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_created_by_fkey,
  ADD CONSTRAINT announcements_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- coupon_redemptions.approved_by : NO ACTION → SET NULL (償還を承認した運営者)
ALTER TABLE public.coupon_redemptions
  DROP CONSTRAINT IF EXISTS coupon_redemptions_approved_by_fkey,
  ADD CONSTRAINT coupon_redemptions_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- coupons.created_by : NO ACTION → SET NULL (クーポンを作った運営者。NOT NULL は A で外した)
ALTER TABLE public.coupons
  DROP CONSTRAINT IF EXISTS coupons_created_by_fkey,
  ADD CONSTRAINT coupons_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- departments.manager_id : NO ACTION → SET NULL (部署の責任者)
ALTER TABLE public.departments
  DROP CONSTRAINT IF EXISTS departments_manager_id_fkey,
  ADD CONSTRAINT departments_manager_id_fkey
    FOREIGN KEY (manager_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- email_blacklist.added_by : NO ACTION → SET NULL (宛先停止リストに登録した運営者)
ALTER TABLE public.email_blacklist
  DROP CONSTRAINT IF EXISTS email_blacklist_added_by_fkey,
  ADD CONSTRAINT email_blacklist_added_by_fkey
    FOREIGN KEY (added_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- experiments.created_by : NO ACTION → SET NULL (実験を作った運営者。NOT NULL は A で外した)
ALTER TABLE public.experiments
  DROP CONSTRAINT IF EXISTS experiments_created_by_fkey,
  ADD CONSTRAINT experiments_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- gdpr_deletion_requests.executed_by : NO ACTION → SET NULL (削除を実行した運営者)
ALTER TABLE public.gdpr_deletion_requests
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_executed_by_fkey,
  ADD CONSTRAINT gdpr_deletion_requests_executed_by_fkey
    FOREIGN KEY (executed_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- help_articles.created_by : NO ACTION → SET NULL (ヘルプ記事を書いた運営者。NOT NULL は A で外した)
ALTER TABLE public.help_articles
  DROP CONSTRAINT IF EXISTS help_articles_created_by_fkey,
  ADD CONSTRAINT help_articles_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- infra_alerts.ack_by : NO ACTION → SET NULL (アラートを確認した運営者)
ALTER TABLE public.infra_alerts
  DROP CONSTRAINT IF EXISTS infra_alerts_ack_by_fkey,
  ADD CONSTRAINT infra_alerts_ack_by_fkey
    FOREIGN KEY (ack_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- moderation_flags.resolved_by : NO ACTION → SET NULL (通報を処理した運営者)
ALTER TABLE public.moderation_flags
  DROP CONSTRAINT IF EXISTS moderation_flags_resolved_by_fkey,
  ADD CONSTRAINT moderation_flags_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- organization_challenges.created_by : NO ACTION → SET NULL (チャレンジを作った人)
ALTER TABLE public.organization_challenges
  DROP CONSTRAINT IF EXISTS organization_challenges_created_by_fkey,
  ADD CONSTRAINT organization_challenges_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- organization_invites.created_by : NO ACTION → SET NULL (招待を作った人。invited_by と同じ意味の古い列)
ALTER TABLE public.organization_invites
  DROP CONSTRAINT IF EXISTS organization_invites_created_by_fkey,
  ADD CONSTRAINT organization_invites_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- plan_price_history.changed_by : NO ACTION → SET NULL (価格を変更した運営者。NOT NULL は A で外した)
--   この表は UPDATE / DELETE を RLS で禁止している (不可逆の履歴)。外部キーの SET NULL は表の所有者の権限で動き
--   RLS を通らない (admin_audit_logs.actor_id の既存の SET NULL と同じ)。
ALTER TABLE public.plan_price_history
  DROP CONSTRAINT IF EXISTS plan_price_history_changed_by_fkey,
  ADD CONSTRAINT plan_price_history_changed_by_fkey
    FOREIGN KEY (changed_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- recipe_flags.reporter_id / reviewed_by : NO ACTION → SET NULL (レシピの通報者と、確認した運営者)
ALTER TABLE public.recipe_flags
  DROP CONSTRAINT IF EXISTS recipe_flags_reporter_id_fkey,
  ADD CONSTRAINT recipe_flags_reporter_id_fkey
    FOREIGN KEY (reporter_id) REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.recipe_flags
  DROP CONSTRAINT IF EXISTS recipe_flags_reviewed_by_fkey,
  ADD CONSTRAINT recipe_flags_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- sales_lead_activities.actor_id : NO ACTION → SET NULL (営業活動を記録した運営者。NOT NULL は A で外した)
ALTER TABLE public.sales_lead_activities
  DROP CONSTRAINT IF EXISTS sales_lead_activities_actor_id_fkey,
  ADD CONSTRAINT sales_lead_activities_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- sales_leads.assigned_to : NO ACTION → SET NULL (リードの担当者)
ALTER TABLE public.sales_leads
  DROP CONSTRAINT IF EXISTS sales_leads_assigned_to_fkey,
  ADD CONSTRAINT sales_leads_assigned_to_fkey
    FOREIGN KEY (assigned_to) REFERENCES auth.users (id) ON DELETE SET NULL;

-- support_tickets.assignee_id : NO ACTION → SET NULL (チケットの担当者)
ALTER TABLE public.support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_assignee_id_fkey,
  ADD CONSTRAINT support_tickets_assignee_id_fkey
    FOREIGN KEY (assignee_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- system_settings.updated_by : NO ACTION → SET NULL (設定を更新した運営者)
ALTER TABLE public.system_settings
  DROP CONSTRAINT IF EXISTS system_settings_updated_by_fkey,
  ADD CONSTRAINT system_settings_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- user_profiles.frozen_by : NO ACTION → SET NULL (凍結した運営者。凍結の状態 frozen_at / frozen_reason は残る)
--   guard_user_profiles_privileged は current_user が authenticated / anon のときだけ特権列の変更を拒否する。
--   外部キーの SET NULL は表の所有者 (postgres) の権限で動くので、拒否されない。
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_frozen_by_fkey,
  ADD CONSTRAINT user_profiles_frozen_by_fkey
    FOREIGN KEY (frozen_by) REFERENCES auth.users (id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────
-- D. 退会の直前に呼ぶ: 本人の生のメールアドレスを残す記録を伏せる
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- 生のメールアドレスの代わりに入れる固定の文字列。.invalid は RFC 2606 の予約済みで、実在するアドレスにならない
  c_masked_email   CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  v_emails         pg_catalog.text[];
  v_delivery_logs  pg_catalog.int4 := 0;
  v_inquiries      pg_catalog.int4 := 0;
  v_org_invites    pg_catalog.int4 := 0;
  v_family_invites pg_catalog.int4 := 0;
  v_promotions     pg_catalog.int4 := 0;
  v_private_recipes pg_catalog.int4 := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'prepare_account_deletion: p_user_id is required' USING ERRCODE = '22023';
  END IF;

  -- 本人のメールアドレス (小文字)。ログイン用のメールと、外部ログイン (Google など) の identity に入っているメール
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT s.email), ARRAY[]::pg_catalog.text[])
    INTO v_emails
    FROM (
      SELECT pg_catalog.lower(u.email) AS email
        FROM auth.users AS u
       WHERE u.id = p_user_id
      UNION
      SELECT pg_catalog.lower(i.identity_data ->> 'email')
        FROM auth.identities AS i
       WHERE i.user_id = p_user_id
    ) AS s
   WHERE s.email IS NOT NULL AND s.email <> '';

  -- 1) メール配信ログ: 本人宛のログの宛先を伏せる (行は残す)
  UPDATE public.email_delivery_logs AS l
     SET email = c_masked_email
   WHERE (l.user_id = p_user_id OR pg_catalog.lower(l.email) = ANY (v_emails))
     AND l.email <> c_masked_email;
  GET DIAGNOSTICS v_delivery_logs = ROW_COUNT;

  -- 2) 問い合わせ: 本人の問い合わせの連絡先メールを伏せる (本文は残す。ログイン前に同じアドレスで送った分も含む)
  UPDATE public.inquiries AS q
     SET email = c_masked_email
   WHERE (q.user_id = p_user_id OR pg_catalog.lower(q.email) = ANY (v_emails))
     AND q.email <> c_masked_email;
  GET DIAGNOSTICS v_inquiries = ROW_COUNT;

  -- 3) 組織の招待: 本人のアドレス宛、または本人が受諾した招待の宛先を伏せ、まだ pending のものは revoked にする
  --    (伏せたアドレスは誰も受諾できない。revoked にしないと、受諾できない pending の招待が残り続ける)
  UPDATE public.organization_invites AS oi
     SET email      = c_masked_email,
         status     = CASE WHEN oi.status = 'pending' THEN 'revoked' ELSE oi.status END,
         revoked_at = CASE WHEN oi.status = 'pending' THEN pg_catalog.now() ELSE oi.revoked_at END
   WHERE (pg_catalog.lower(oi.email) = ANY (v_emails) OR oi.accepted_by = p_user_id)
     AND oi.email <> c_masked_email;
  GET DIAGNOSTICS v_org_invites = ROW_COUNT;

  -- 4) 家族の招待・昇格リクエスト: 同じく伏せる。先に関係する家族グループの行をロックする
  --    (CLAUDE.md「家族 (family_*) を変える関数のロック順」: 最初に family_groups、そのあとで子の行)
  PERFORM 1
     FROM public.family_groups AS g
    WHERE g.id IN (
            SELECT fi.family_id
              FROM public.family_invites AS fi
             WHERE (pg_catalog.lower(fi.email) = ANY (v_emails) OR fi.accepted_by = p_user_id)
               AND fi.email <> c_masked_email
            UNION
            SELECT fp.family_id
              FROM public.family_promotion_requests AS fp
             WHERE pg_catalog.lower(fp.email) = ANY (v_emails)
               AND fp.email <> c_masked_email
          )
    ORDER BY g.id
      FOR NO KEY UPDATE;

  UPDATE public.family_invites AS fi
     SET email      = c_masked_email,
         status     = CASE WHEN fi.status = 'pending' THEN 'revoked' ELSE fi.status END,
         revoked_at = CASE WHEN fi.status = 'pending' THEN pg_catalog.now() ELSE fi.revoked_at END
   WHERE (pg_catalog.lower(fi.email) = ANY (v_emails) OR fi.accepted_by = p_user_id)
     AND fi.email <> c_masked_email;
  GET DIAGNOSTICS v_family_invites = ROW_COUNT;

  UPDATE public.family_promotion_requests AS fp
     SET email       = c_masked_email,
         status      = CASE WHEN fp.status = 'pending' THEN 'revoked' ELSE fp.status END,
         resolved_at = CASE WHEN fp.status = 'pending' THEN pg_catalog.now() ELSE fp.resolved_at END
   WHERE pg_catalog.lower(fp.email) = ANY (v_emails)
     AND fp.email <> c_masked_email;
  GET DIAGNOSTICS v_promotions = ROW_COUNT;

  -- 5) 非公開のレシピ: 本人のものを消す。
  --    recipes.user_id は ON DELETE SET NULL で、user_id が NULL の行は RLS ("Users can view public recipes":
  --    user_id IS NULL OR is_public OR 本人) で全員に見える。退会で user_id が外れると、非公開のレシピまで全員に公開されてしまう。
  --    公開レシピ (is_public = true) は、本人が公開したもので、他の利用者のコレクション・いいね・コメントが付いていることがあるので
  --    残す (user_id だけが外れる)。recipes を指す外部キーはすべて ON DELETE CASCADE なので、消して詰まることは無い。
  DELETE FROM public.recipes AS r
   WHERE r.user_id = p_user_id
     AND r.is_public IS NOT TRUE;
  GET DIAGNOSTICS v_private_recipes = ROW_COUNT;

  -- 件数だけを返す (メールアドレスは返さない)
  RETURN pg_catalog.jsonb_build_object(
    'email_delivery_logs', v_delivery_logs,
    'inquiries', v_inquiries,
    'organization_invites', v_org_invites,
    'family_invites', v_family_invites,
    'family_promotion_requests', v_promotions,
    'private_recipes', v_private_recipes
  );
END
$function$;

REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid) TO service_role;

COMMENT ON FUNCTION public.prepare_account_deletion(uuid) IS
  '#1175: 退会の直前に呼ぶ。本人の生のメールアドレスを残す記録 (email_delivery_logs / inquiries / 組織・家族の招待 / 家族の昇格リクエスト) の宛先を伏せ、pending の招待を revoked にする。本人の非公開レシピを消す (user_id が NULL の行は全員に見えるため)。件数だけの jsonb を返す。service_role のみ。';

-- 退会後も行を残す列の意味 (NULL = 退会済み)
COMMENT ON COLUMN public.support_tickets.user_id IS
  '#1175: チケットの起票者。NULL = 起票者が退会した (行は残す)';
COMMENT ON COLUMN public.support_ticket_messages.sender_id IS
  '#1175: メッセージの送信者。NULL = 送信者が退会した (行は残す)';
COMMENT ON COLUMN public.referral_rewards.referrer_id IS
  '#1175: 紹介した人。NULL = 退会した (行は会計のために残す)';
COMMENT ON COLUMN public.referral_rewards.referred_id IS
  '#1175: 紹介された人。NULL = 退会した (行は会計のために残す)';
COMMENT ON COLUMN public.gdpr_deletion_requests.user_id IS
  '#1175: 削除要求をした人。NULL = 退会が済んで紐づけを外した (要求と実行の日時の記録は残す)';
COMMENT ON COLUMN public.email_delivery_logs.user_id IS
  '#1175: 宛先の利用者。NULL = 退会した。宛先の email は prepare_account_deletion が伏せる (行は残す)';
COMMENT ON COLUMN public.coupon_redemptions.user_id IS
  '#1175: 償還した利用者。NULL = 退会した (anonymized_at に日時が入る。行は会計のために残す)';
