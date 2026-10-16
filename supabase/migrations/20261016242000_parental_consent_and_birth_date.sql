-- migration: 20261016242000_parental_consent_and_birth_date.sql
-- Issue #1173 (実装 #1713 段 A): 未成年の年齢確認と保護者の同意 (設計書 docs/design/cross/14-parental-consent.md §6.4)
--
-- 背景:
--   サインアップにも同意画面にも生年月日・年齢の確認が無く、誰でも年齢の申告なしにアカウントを作れる。
--   要件 (docs/requirements/03-operator-admin.md §17.10) が定める parental_consents (保護者の電子署名同意) の表も無く、
--   子供の追加 (add_family_child) と昇格 (request_child_promotion / accept_child_promotion) は年齢も同意も見ない。
--
-- 変更 (番号は設計書 §6.4 の 1〜12):
--   1. user_profiles.birth_date (write-once の特権列)。accept_legal_documents だけが書く (昇格の承諾は子供の行の値で上書き)。
--   2. family_members.birth_date と CHECK family_members_child_birth_date_required (アカウント無しの子供は必須)・索引。
--   3. age_years_jst(date): JST の暦日で数える満年齢 (誕生日の当日に増える。@homegohan/shared の calculateAgeYears と同じ規則)。
--   4. parental_consents (RLS: その家族の active な大人・署名した本人・運営が SELECT だけ。書けるのは DEFINER の関数と service_role)。
--   5. parental_consent_active(uuid)・legal_minor_has_guardian_path() (呼び出した本人の「保護者の同意とのつながり」)。
--   6. 取り消しのトリガー 2 本 (メンバーの行が active でなくなったとき・行が消えるときに有効な同意を取り消し、監査に残す)。
--   7. membership_audit.action に parental_consent_recorded / parental_consent_revoked を足す (既存の 26 値はそのまま)。
--   8. 特権列ガード 3 本に birth_date を足す (本文は各関数を最後に定義した migration の定義 + 1 行)。
--   9. add_family_child: 生年月日を必須にし、18 歳未満は同じトランザクションで parental_consents に署名を記録する (旧 3 引数は DROP)。
--  10. accept_legal_documents: p_birth_date を足し、生年月日を 1 回だけ記録する。18 歳未満の自己登録は何も書かずに断る (旧 4 引数は DROP)。
--  11. request_child_promotion / accept_child_promotion: 13 歳未満を断り、18 歳未満は有効な同意を求める。承諾で生年月日を写す。
--  12. caller_is_minor_jst() と、本人に家族の行・代表者・組織のオーナーを付ける 4 関数の先頭の判定 (MINOR_ACCOUNT_NOT_ALLOWED)。
--
-- 設計上の判断:
--   - 年齢の境 (18 / 13)・生年月日の範囲 (120 年)・署名の長さ (100)・版の形 (1〜20 文字)・UA の切り詰め (512) は、
--     @homegohan/shared の定数 (ADULT_AGE_YEARS / COPPA_AGE_YEARS / BIRTH_DATE_MAX_AGE_YEARS / SIGNED_NAME_MAX_LENGTH /
--     PARENTAL_CONSENT_VERSION_PATTERN) と accept_legal_documents の既存の値と同じ。tests/parental-consent-migration-contract.test.ts が突き合わせる。
--   - 作り直す関数 (8・11・12) は、土台の定義の本文に文を足すだけで、signature・戻り値・SECURITY DEFINER・search_path・ロックの順・ACL は変えない。
--     土台: guard_user_profiles_privileged / _on_insert = 20261016210000_billing_core.sql、guard_family_members_privileged =
--     20261008090000_family_members_status_guard.sql、request_child_promotion = 20261008100000_membership_daily_send_cap.sql、
--     accept_child_promotion / accept_family_invite = 20261015170000_accept_copies_profile_name.sql、create_family_group =
--     20261016200000_rpc_profile_name_placeholder.sql (normalize_profile_name の式はそのまま)、accept_family_representative_transfer =
--     20261008090100_family_lock_order.sql、accept_org_owner_transfer = 20251126124224_create_meal_planner_tables.sql。
--   - 同意の記録は、子供を外したあと・子供の行が消えたあと・署名者の退会のあとも残す (紐づけだけ外す)。家族の行の削除で消える。
--   - 既存の行のバックフィルはしない (推測で年齢を入れない)。既存の利用者は次に画面を開いたとき同意画面で生年月日を聞かれる。
--
-- 本番への影響:
--   - ADD COLUMN (NULL 可・既定値なし) はテーブルの書き換えを伴わない。family_members の CHECK は VALID で足す
--     (本番の family_members は 2026-10-15 時点で 0 行。子供の行が残っている開発用の DB では適用が失敗する = 生年月日の無い子供を存在させない)。
--   - add_family_child と accept_legal_documents は signature が変わる。Web の route (POST /api/family/members/child・POST /api/legal/accept) が
--     新しい引数を送る形 (段 B) と同時に反映すること (段 A だけを先に本番へ入れると、子供の追加と、生年月日の無い利用者の同意の記録が失敗する)。
--
-- 冪等: ADD COLUMN IF NOT EXISTS・CREATE TABLE / INDEX IF NOT EXISTS・DROP ... IF EXISTS の後に作る・CREATE OR REPLACE FUNCTION。
-- ロールバック: supabase/rollbacks/20261016242000_parental_consent_and_birth_date.down.sql
--   (戻すと生年月日と同意の記録が消える。先に Web のデプロイを戻すこと)
-- 確かめるテスト:
--   tests/integration/security/parental-consent.test.ts・tests/integration/security/legal-documents-acceptance.test.ts (実 DB)
--   tests/parental-consent-migration-contract.test.ts (ファイルの文面。DB なし)

-- ─────────────────────────────────────────────────────────
-- 1. user_profiles.birth_date (write-once の特権列)
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS birth_date date;
COMMENT ON COLUMN public.user_profiles.birth_date IS
  '#1173: 本人の生年月日 (年齢の確認)。同意画面で 1 回だけ聞き、accept_legal_documents だけが書く (write-once。昇格の承諾 accept_child_promotion は子供の行の値で上書き)。本人は直接変更できない (guard_user_profiles_privileged)。NULL = 未入力 (同意ゲートが同意画面へ回す)。';

-- ─────────────────────────────────────────────────────────
-- 2. family_members.birth_date (子供は必須)
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS birth_date date;
-- 子供 (アカウント無しのメンバー: role = 'child' ∧ user_id IS NULL) は生年月日が必須。
-- user_id のある行は対象にしない: 既存の CHECK family_members_child_profile_consistency は user_id ありで role = 'child' の行を許し
-- (製品の経路では作らない。結合テストは service_role で作る: membership-transfer-accept の E2)、その人の生年月日は user_profiles.birth_date にある。
-- VALID で足す: 本番は 2026-10-15 時点で family_members 0 行。
-- ローカルスタック・結合テスト・E2E は migration を空の DB に流すので、適用の時点で子供の行は無い。
-- 適用のあとにテストが作る子供の行は、生年月日を入れる形に直す (直接 INSERT するフィクスチャも含めて)。
-- 子供の行が残っている環境 (手で作った開発用の DB など) では適用が失敗する (= 本 migration より前の「生年月日の無い子供」を存在させない)。
-- その環境の行は本番のデータではないので、消してから適用し直す。
ALTER TABLE public.family_members DROP CONSTRAINT IF EXISTS family_members_child_birth_date_required;
ALTER TABLE public.family_members ADD CONSTRAINT family_members_child_birth_date_required
  CHECK (role <> 'child' OR user_id IS NOT NULL OR birth_date IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_family_members_child_birth_date
  ON public.family_members (birth_date) WHERE role = 'child' AND user_id IS NULL;
COMMENT ON COLUMN public.family_members.birth_date IS
  '#1173: 子供 (アカウント無しのメンバー) の生年月日。add_family_child だけが書く (家族の大人も直接変更できない: guard_family_members_privileged)。大人 (user_id あり) の行は NULL (本人の生年月日は user_profiles.birth_date)。';

-- ─────────────────────────────────────────────────────────
-- 3. 年齢 (JST の暦日。誕生日の当日に 1 つ増える)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.age_years_jst(p_birth_date date) RETURNS integer
LANGUAGE sql STABLE SET search_path = '' AS $$
  -- @homegohan/shared の calculateAgeYears(birth, todayLocal()) と同じ規則 (誕生日の当日に増える。todayLocal は JST の今日)。
  SELECT date_part('year', age((now() AT TIME ZONE 'Asia/Tokyo')::date, p_birth_date))::integer
$$;
-- RPC の本文 (所有者 postgres) からだけ呼ぶ。クライアントには開けない
REVOKE ALL ON FUNCTION public.age_years_jst(date) FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────
-- 4. parental_consents
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.parental_consents (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_member_id     uuid        REFERENCES public.family_members(id) ON DELETE SET NULL,  -- 子供の行。行が消えても (昇格した本人の退会の CASCADE など) 同意の記録は残し、紐づけだけ外す (有効な同意は BEFORE DELETE のトリガーが先に取り消す。6)
  family_id            uuid        NOT NULL REFERENCES public.family_groups(id)  ON DELETE CASCADE,  -- RLS を結合なしで書くための複製
  parent_user_id       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,  -- 署名者。退会で紐づけだけ外す (20261010000100 の方針 2)
  signed_name          text        NOT NULL,   -- 電子署名 (保護者が入力した氏名。前後の空白を除いた値)
  guardian_attested    boolean     NOT NULL,   -- 「親権者または法定保護者である」の確認
  consent_version      varchar(20) NOT NULL,   -- 同意文書の版 (@homegohan/shared の PARENTAL_CONSENT_DOCUMENT.version)
  child_birth_date     date        NOT NULL,   -- 署名時点の子供の生年月日の写し (子供の行が消えても判断の根拠が残る)
  child_age_at_signing integer     NOT NULL,   -- 署名時点の年齢 (0〜17)。13 未満 = COPPA の区分
  signed_at            timestamptz NOT NULL DEFAULT now(),
  ip_address           inet,
  user_agent           text,                   -- 512 文字で切る (accept_legal_documents と同じ)
  revoked_at           timestamptz,            -- 取り消し (子供を家族から外した・子供の行が消えた) 日時。NULL = 有効
  revoked_reason       text,
  CONSTRAINT parental_consents_signed_name_length CHECK (length(signed_name) BETWEEN 1 AND 100),  -- SIGNED_NAME_MAX_LENGTH
  CONSTRAINT parental_consents_guardian_attested  CHECK (guardian_attested),
  CONSTRAINT parental_consents_version_format     CHECK (consent_version ~ '^[0-9A-Za-z._-]{1,20}$'),  -- LEGAL_VERSION_PATTERN と同じ
  CONSTRAINT parental_consents_child_age          CHECK (child_age_at_signing BETWEEN 0 AND 17),     -- ADULT_AGE_YEARS - 1
  CONSTRAINT parental_consents_revoked_pair       CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT parental_consents_revoked_reason     CHECK (revoked_reason IS NULL OR revoked_reason IN ('member_removed', 'member_left', 'member_deleted')),
  -- 有効な同意は必ず子供の行を指す (子供の行が消えるときは、外部キーの SET NULL より先に BEFORE DELETE のトリガーが取り消す)
  CONSTRAINT parental_consents_member_or_revoked  CHECK (family_member_id IS NOT NULL OR revoked_at IS NOT NULL)
);
-- 有効な同意は子供 1 人につき 1 行
CREATE UNIQUE INDEX IF NOT EXISTS uniq_parental_consents_active_member
  ON public.parental_consents (family_member_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_parental_consents_family ON public.parental_consents (family_id);
CREATE INDEX IF NOT EXISTS idx_parental_consents_parent ON public.parental_consents (parent_user_id) WHERE parent_user_id IS NOT NULL;

ALTER TABLE public.parental_consents ENABLE ROW LEVEL SECURITY;
-- 権限: 読めるのはその家族の active な大人・署名した本人 (家族を抜けたあとも。アカウントのデータ書き出しが本人のセッションで読む)・運営。
-- 書けるのは SECURITY DEFINER の関数 (所有者 postgres) と service_role だけ。
-- Supabase の default privileges を完全形で剥がしてから付け直す (20261007150300 と同じ理屈)。
REVOKE ALL ON public.parental_consents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.parental_consents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.parental_consents TO service_role;
DROP POLICY IF EXISTS parental_consents_select_signer_family_adult_or_operator ON public.parental_consents;
CREATE POLICY parental_consents_select_signer_family_adult_or_operator ON public.parental_consents
  FOR SELECT TO authenticated
  USING (
    parent_user_id = (SELECT auth.uid())
    OR public.is_active_family_adult(family_id)
    OR EXISTS (SELECT 1 FROM public.user_profiles up
                WHERE up.id = auth.uid() AND up.roles && ARRAY['admin', 'super_admin']::text[])
  );
-- INSERT / UPDATE / DELETE のポリシーは作らない (= authenticated は書けない。RLS の既定の拒否 + GRANT なし)
COMMENT ON TABLE public.parental_consents IS
  '#1173: 18 歳未満の子供メンバーへの保護者の電子署名同意。add_family_child が子供の行と同じトランザクションで 1 行入れる。取り消しは子供を家族から外すこと (トリガーが revoked_at を入れる)。クライアントは SELECT のみ (家族の大人・署名した本人・運営)。署名した本人のアカウントのデータ書き出しに入る (src/lib/account-export-tables.ts)。保持: 取り消し (子供を外す) のあとも行を残す (revoked_at)。署名者の退会では parent_user_id だけ NULL。子供の行が消えるとき (昇格した本人の退会の CASCADE・service_role の削除) は、有効な同意を member_deleted で取り消してから family_member_id だけ NULL (行は残す)。家族の行の DELETE で CASCADE で消える。同意書の第 5 段落 (@homegohan/shared の PARENTAL_CONSENT_DOCUMENT_COPY) と同じ。';

-- ─────────────────────────────────────────────────────────
-- 5. 同意の有効判定・昇格の経路の未成年
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.parental_consent_active(p_member_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.parental_consents pc
                  WHERE pc.family_member_id = p_member_id AND pc.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION public.parental_consent_active(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 18 歳未満の本人に「保護者の同意とのつながり」があるか (呼び出した本人 auth.uid() についてだけ答える。引数は取らない):
-- ① 既に自分の行 (昇格済み) が active で、有効な同意がある、または
-- ② 自分のメールアドレス宛の pending (期限内) の昇格依頼があり、その子供に有効な同意がある (S11)。
-- 使う所は 2 つ: accept_legal_documents (13〜17 歳の自己登録を断るか。13 歳未満はこの関数を呼ぶ前に断る) と、同意ゲート (18 歳未満の本人のリクエストごとに
-- lib/legal-consent-minor.ts の withMinorGuardianStatus が rpc で呼ぶ。依頼を断る・取り消す・期限切れ・脱退・除名で false になる)。
-- 答えは本人のことだけなので authenticated に開ける (anon / service_role には開けない。auth.uid() が無いと false)。
-- 年齢 (13 歳未満) の条件はここに足さない: ② の子供は request_child_promotion が 13 歳未満を断るので 13 歳以上 (生年月日は guard で変えられない)、
-- ① の行は accept_child_promotion が 13 歳未満を断るので 13 歳以上、呼び出した本人が 13 歳未満の生年月日を入れたときは accept_legal_documents がこの関数を呼ぶ前に断る。
CREATE OR REPLACE FUNCTION public.legal_minor_has_guardian_path() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL AND (
         EXISTS (
           SELECT 1 FROM public.family_members fm
            WHERE fm.user_id = (SELECT auth.uid()) AND fm.status = 'active' AND public.parental_consent_active(fm.id)
         )
      OR EXISTS (
           SELECT 1
             FROM public.family_promotion_requests r
             JOIN public.family_members fm ON fm.id = r.member_id AND fm.status = 'active'
             JOIN auth.users u ON u.id = (SELECT auth.uid())
            WHERE r.status = 'pending' AND r.expires_at > now()
              AND lower(r.email) = lower(u.email)
              AND public.parental_consent_active(fm.id)
         ))
$$;
REVOKE ALL ON FUNCTION public.legal_minor_has_guardian_path() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.legal_minor_has_guardian_path() TO authenticated;

-- ─────────────────────────────────────────────────────────
-- 6. 取り消しのトリガー 2 本 (メンバーの行が active でなくなったとき・行そのものが消えるときに同意を失効させる)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_parental_consent_on_member_inactive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_consent_id uuid;
  v_reason text := CASE WHEN NEW.status = 'left' THEN 'member_left' ELSE 'member_removed' END;
BEGIN
  UPDATE public.parental_consents
     SET revoked_at = now(), revoked_reason = v_reason
   WHERE family_member_id = NEW.id AND revoked_at IS NULL
   RETURNING id INTO v_consent_id;  -- 有効な同意は最大 1 行 (uniq_parental_consents_active_member)
  IF v_consent_id IS NOT NULL THEN
    INSERT INTO public.membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
    VALUES ('family', NEW.family_id, 'parental_consent_revoked', auth.uid(), NULL,
            jsonb_build_object('member_id', NEW.id, 'consent_id', v_consent_id, 'reason', v_reason));
  END IF;
  RETURN NULL;
END $$;
-- トリガーからだけ動く。クライアントからは呼ばせない (anon-definer-execute の A1。先例 audit_organization_invite_created と同じ完全形)。
-- トリガーの発火は関数の EXECUTE 権限を見ない (権限を見るのは CREATE TRIGGER の時点で、作る所有者 postgres は持っている) ので、剥がしても失効は動く。
REVOKE ALL ON FUNCTION public.revoke_parental_consent_on_member_inactive() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_family_members_revoke_parental_consent ON public.family_members;
-- role は条件にしない: 昇格した本人の行 (role = adult。同意の行は残っている) が脱退・除名されたときも失効させる。
-- 同意の行が無いメンバー (大人・18 歳以上の子供) では UPDATE が 0 行で終わり、監査も書かない。
-- left になるのは leave_family (本人の行) と operator_force_dissolve_family (家族の全員)、removed は remove_family_member。
CREATE TRIGGER trg_family_members_revoke_parental_consent
  AFTER UPDATE OF status ON public.family_members
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION public.revoke_parental_consent_on_member_inactive();

-- メンバーの行そのものが消えるとき (昇格した本人の退会: auth.users の DELETE → family_members_user_id_fkey1 の CASCADE、
-- service_role の手作業の削除、家族の行の DELETE の CASCADE) も、有効な同意を取り消してから消す。
-- 外部キー parental_consents.family_member_id は ON DELETE SET NULL なので、同意の行は取り消し済みとして残る
-- (家族の行の DELETE のときは parental_consents.family_id の CASCADE で同意の行も消える)。
-- BEFORE で動かす: 外部キーの SET NULL (内部の AFTER トリガー) より先に family_member_id で有効な同意を探すため。
-- 先に取り消すので CHECK parental_consents_member_or_revoked (有効な同意は子供の行を指す) を破らない。
CREATE OR REPLACE FUNCTION public.revoke_parental_consent_on_member_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_consent_id uuid;
BEGIN
  UPDATE public.parental_consents
     SET revoked_at = now(), revoked_reason = 'member_deleted'
   WHERE family_member_id = OLD.id AND revoked_at IS NULL
   RETURNING id INTO v_consent_id;  -- 有効な同意は最大 1 行 (uniq_parental_consents_active_member)。取り消し済みの行は変えない
  IF v_consent_id IS NOT NULL THEN
    -- 消える本人を actor にしない: 退会 (auth.users の DELETE の CASCADE) の中で auth.uid() が消える本人だと、
    -- membership_audit.actor_id の外部キーが同じ文で消える auth.users の行を指して 23503 になる
    -- (製品の退会は service_role の auth.admin.deleteUser なので auth.uid() は NULL。手前の保険)。子供の行 (user_id NULL) では auth.uid() のまま
    INSERT INTO public.membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
    VALUES ('family', OLD.family_id, 'parental_consent_revoked', NULLIF(auth.uid(), OLD.user_id), NULL,
            jsonb_build_object('member_id', OLD.id, 'consent_id', v_consent_id, 'reason', 'member_deleted'));
  END IF;
  RETURN OLD;  -- BEFORE DELETE の行トリガーは OLD を返す (NULL を返すと削除そのものが取り消される)
END $$;
-- トリガーからだけ動く。クライアントからは呼ばせない (上の関数と同じ完全形)
REVOKE ALL ON FUNCTION public.revoke_parental_consent_on_member_delete() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_family_members_revoke_parental_consent_on_delete ON public.family_members;
-- role・status は条件にしない: 子供の行も、昇格した本人の行 (role = adult) も、外したあとの行 (removed / left) も対象。
-- 有効な同意の無い行 (大人・18 歳以上の子供・取り消し済み) では UPDATE が 0 行で終わり、監査も書かない (外部キーの SET NULL だけが掛かる)
CREATE TRIGGER trg_family_members_revoke_parental_consent_on_delete
  BEFORE DELETE ON public.family_members
  FOR EACH ROW
  EXECUTE FUNCTION public.revoke_parental_consent_on_member_delete();

-- ─────────────────────────────────────────────────────────
-- 7. membership_audit.action に 2 値を足す (既存の 26 値は 20251126124224 の配列を逐語で写す)
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.membership_audit DROP CONSTRAINT IF EXISTS membership_audit_action_check;
ALTER TABLE public.membership_audit ADD CONSTRAINT membership_audit_action_check CHECK (action = ANY (ARRAY[
  'group_created', 'group_dissolved', 'invite_created', 'invite_accepted', 'invite_rejected', 'invite_revoked',
  'invite_expired', 'member_added', 'member_removed', 'member_left', 'child_added', 'child_promoted', 'role_changed',
  'owner_transfer_proposed', 'owner_transferred', 'owner_transfer_declined', 'representative_transfer_proposed',
  'representative_transferred', 'representative_transfer_declined', 'operator_force_owner_transfer',
  'operator_force_representative_transfer', 'operator_force_dissolve', 'paste_executed', 'child_promotion_requested',
  'child_promotion_rejected', 'child_promotion_revoked',
  'parental_consent_recorded', 'parental_consent_revoked'
]::text[]));

-- ─────────────────────────────────────────────────────────
-- 8. 特権列ガード 3 本に birth_date を足す (本文は最後に定義した migration の定義 + 1 行ずつ。ACL は変わらない)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.roles            IS DISTINCT FROM OLD.roles
       OR NEW.org_role         IS DISTINCT FROM OLD.org_role
       OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
       OR NEW.family_id        IS DISTINCT FROM OLD.family_id
       OR NEW.is_active_in_org IS DISTINCT FROM OLD.is_active_in_org
       OR NEW.joined_org_at    IS DISTINCT FROM OLD.joined_org_at
       OR NEW.frozen_at        IS DISTINCT FROM OLD.frozen_at
       OR NEW.frozen_by        IS DISTINCT FROM OLD.frozen_by
       OR NEW.frozen_reason    IS DISTINCT FROM OLD.frozen_reason
       OR NEW.unban_at         IS DISTINCT FROM OLD.unban_at
       OR NEW.department_id    IS DISTINCT FROM OLD.department_id
       OR NEW.terms_version_accepted   IS DISTINCT FROM OLD.terms_version_accepted
       OR NEW.privacy_version_accepted IS DISTINCT FROM OLD.privacy_version_accepted
       OR NEW.legal_accepted_at        IS DISTINCT FROM OLD.legal_accepted_at
       OR NEW.birth_date               IS DISTINCT FROM OLD.birth_date
       OR NEW.plan_key_cached          IS DISTINCT FROM OLD.plan_key_cached THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF (NEW.roles IS NOT NULL AND NEW.roles IS DISTINCT FROM ARRAY['user']::text[])
       OR NEW.org_role         IS NOT NULL
       OR NEW.organization_id  IS NOT NULL
       OR NEW.family_id        IS NOT NULL
       OR NEW.is_active_in_org IS DISTINCT FROM false
       OR NEW.joined_org_at    IS NOT NULL
       OR NEW.frozen_at        IS NOT NULL
       OR NEW.frozen_by        IS NOT NULL
       OR NEW.frozen_reason    IS NOT NULL
       OR NEW.unban_at         IS NOT NULL
       OR NEW.department_id    IS NOT NULL
       OR NEW.terms_version_accepted   IS NOT NULL
       OR NEW.privacy_version_accepted IS NOT NULL
       OR NEW.legal_accepted_at        IS NOT NULL
       OR NEW.birth_date               IS NOT NULL
       OR NEW.plan_key_cached          IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_family_members_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    -- #1309: status / removed_at もログインユーザーは直接変更できない。退出・除名・解散は
    -- DEFINER RPC (leave_family / remove_family_member / operator_force_dissolve_family) か service_role だけが行う。
    -- 退出・除名済みの本人が自分の行を active に戻すと、招待の承諾も人数の上限の確認も通らずに家族へ戻れてしまう。
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.family_id IS DISTINCT FROM OLD.family_id
       OR NEW.user_id   IS DISTINCT FROM OLD.user_id
       OR NEW.status     IS DISTINCT FROM OLD.status
       OR NEW.removed_at IS DISTINCT FROM OLD.removed_at
       -- #1173: 子供の生年月日は add_family_child だけが書く (家族の大人も直接変更できない)
       OR NEW.birth_date IS DISTINCT FROM OLD.birth_date THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;

    -- #1015: 共有設定 (share_meals/share_health/share_menu) は本人のみ直接 UPDATE 可。
    -- 子供メンバー等 (OLD.user_id IS NULL) は「本人」が存在しないため常に拒否され、
    -- 変更が必要な場合は DEFINER RPC 経由での対応が必要。
    IF auth.uid() IS DISTINCT FROM OLD.user_id THEN
      IF NEW.share_meals  IS DISTINCT FROM OLD.share_meals
         OR NEW.share_health IS DISTINCT FROM OLD.share_health
         OR NEW.share_menu   IS DISTINCT FROM OLD.share_menu THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────
-- 9. add_family_child (旧 signature を DROP し、新 signature で作る)
-- ─────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.add_family_child(uuid, text, jsonb);
CREATE OR REPLACE FUNCTION public.add_family_child(
  p_family_id        uuid,
  p_display_name     text,
  p_child_profile    jsonb,
  p_birth_date       date,
  p_consent_version  text    DEFAULT NULL,
  p_signed_name      text    DEFAULT NULL,
  p_guardian_attested boolean DEFAULT false,
  p_ip               inet    DEFAULT NULL,
  p_user_agent       text    DEFAULT NULL
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role family_role_enum; v_member family_members; v_count INT; v_limit INT; v_family_status TEXT;
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_age INT; v_signed_name TEXT; v_consent_id uuid; v_signer_birth date;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- #1173 生年月日は必須。未来・120 年超 (要件 01: 過去 120 年以内。BIRTH_DATE_MAX_AGE_YEARS) は不正。ロックを取る前に検査する (無駄に待たせない)
  IF p_birth_date IS NULL THEN
    RAISE EXCEPTION 'CHILD_BIRTH_DATE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_birth_date > v_today OR p_birth_date < (v_today - INTERVAL '120 years')::date THEN
    RAISE EXCEPTION 'CHILD_BIRTH_DATE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  v_age := public.age_years_jst(p_birth_date);
  v_signed_name := NULLIF(btrim(p_signed_name), '');
  -- 18 歳未満 (要件 03 §17.10。ADULT_AGE_YEARS) は、版・署名 (氏名 1〜100 文字。SIGNED_NAME_MAX_LENGTH)・親権者の確認が揃わなければ子供の行も作らない
  IF v_age < 18 AND (
       p_consent_version IS NULL OR p_consent_version !~ '^[0-9A-Za-z._-]{1,20}$'
       OR v_signed_name IS NULL OR length(v_signed_name) > 100
       OR NOT COALESCE(p_guardian_attested, false)
     ) THEN
    RAISE EXCEPTION 'PARENTAL_CONSENT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- 署名者 (呼び出し者) は、自分の生年月日で 18 歳以上と確かめられる大人だけ (昇格した 18 歳未満の本人・生年月日の無い人は署名できない)
  IF v_age < 18 THEN
    SELECT birth_date INTO v_signer_birth FROM user_profiles WHERE id = auth.uid();
    IF v_signer_birth IS NULL OR public.age_years_jst(v_signer_birth) < 18 THEN
      RAISE EXCEPTION 'PARENTAL_CONSENT_SIGNER_NOT_ADULT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- (#1213 のまま) 家族の行をロックしてから人数を数える
  SELECT member_limit, status INTO v_limit, v_family_status
    FROM family_groups WHERE id = p_family_id FOR UPDATE;
  IF NOT FOUND OR v_family_status <> 'active' THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- 生年月日は列に入れる。jsonb に同じ値を持たせない (読む側が 2 か所を見ないため)
  INSERT INTO family_members (family_id, user_id, role, display_name, child_profile, birth_date)
  VALUES (p_family_id, NULL, 'child', p_display_name, COALESCE(p_child_profile, '{}'::jsonb) - 'birth_date', p_birth_date)
  RETURNING * INTO v_member;

  IF v_age < 18 THEN
    INSERT INTO parental_consents (family_member_id, family_id, parent_user_id, signed_name, guardian_attested,
                                   consent_version, child_birth_date, child_age_at_signing, ip_address, user_agent)
    VALUES (v_member.id, p_family_id, auth.uid(), v_signed_name, true,
            p_consent_version, p_birth_date, v_age, p_ip, left(p_user_agent, 512))
    RETURNING id INTO v_consent_id;
    INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
    VALUES ('family', p_family_id, 'parental_consent_recorded', auth.uid(), NULL,
            jsonb_build_object('member_id', v_member.id, 'consent_id', v_consent_id,
                               'consent_version', p_consent_version, 'child_age', v_age));
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'child_added', auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'display_name', p_display_name, 'consent_id', v_consent_id));

  RETURN v_member;
END $$;
REVOKE ALL ON FUNCTION public.add_family_child(uuid, text, jsonb, date, text, text, boolean, inet, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_family_child(uuid, text, jsonb, date, text, text, boolean, inet, text)
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────
-- 10. accept_legal_documents (旧 signature を DROP し、p_birth_date を足す)
-- ─────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.accept_legal_documents(text, text, inet, text);
CREATE OR REPLACE FUNCTION public.accept_legal_documents(
  p_terms_version   text,
  p_privacy_version text,
  p_ip              inet DEFAULT NULL,
  p_user_agent      text DEFAULT NULL,
  p_birth_date      date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_existing_birth date;
  v_birth date;
  v_age integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  IF p_terms_version IS NULL OR p_terms_version !~ '^[0-9A-Za-z._-]{1,20}$'
     OR p_privacy_version IS NULL OR p_privacy_version !~ '^[0-9A-Za-z._-]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_LEGAL_VERSION' USING ERRCODE = '22023';
  END IF;

  -- #1173 生年月日 (write-once)。行に既にあれば p_birth_date は見ない。無ければ必須で、未成年の自己登録は断る (何も書かない)
  SELECT birth_date INTO v_existing_birth FROM public.user_profiles WHERE id = v_uid;
  v_birth := COALESCE(v_existing_birth, p_birth_date);
  IF v_birth IS NULL THEN
    RAISE EXCEPTION 'LEGAL_BIRTH_DATE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_existing_birth IS NULL THEN
    -- 未来・120 年超 (BIRTH_DATE_MAX_AGE_YEARS) は不正
    IF p_birth_date > v_today OR p_birth_date < (v_today - INTERVAL '120 years')::date THEN
      RAISE EXCEPTION 'LEGAL_BIRTH_DATE_INVALID' USING ERRCODE = '22023';
    END IF;
    v_age := public.age_years_jst(p_birth_date);
    -- 13 歳未満 (COPPA_AGE_YEARS。要件 03 §17.10) は本人のアカウントを作らない (同意書の第 3 段落)。昇格の経路があっても断る。
    -- 経路を DB に聞く前に別の IF で断る (P4b)
    IF v_age < 13 THEN
      RAISE EXCEPTION 'LEGAL_MINOR_SELF_SIGNUP_REFUSED' USING ERRCODE = 'P0001';
    END IF;
    -- 13〜17 歳 (ADULT_AGE_YEARS 未満。要件 03 §17.10) は、保護者の同意済みの子供としてつなぐ経路 (S11) の人だけ通す
    IF v_age < 18 AND NOT public.legal_minor_has_guardian_path() THEN  -- v_uid (= auth.uid()) について答える
      RAISE EXCEPTION 'LEGAL_MINOR_SELF_SIGNUP_REFUSED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.user_profiles AS p (
    id, nickname, age_group, gender,
    terms_version_accepted, privacy_version_accepted, legal_accepted_at, birth_date
  ) VALUES (
    v_uid, 'Guest', 'unspecified', 'unspecified',
    p_terms_version, p_privacy_version, v_now, v_birth
  )
  ON CONFLICT (id) DO UPDATE
     SET terms_version_accepted   = EXCLUDED.terms_version_accepted,
         privacy_version_accepted = EXCLUDED.privacy_version_accepted,
         -- 版が変わらないときは同意日時を動かさない (生年月日だけを足す S3 でも動かない)
         legal_accepted_at        = CASE WHEN p.terms_version_accepted IS DISTINCT FROM EXCLUDED.terms_version_accepted
                                          OR p.privacy_version_accepted IS DISTINCT FROM EXCLUDED.privacy_version_accepted
                                          OR p.legal_accepted_at IS NULL
                                         THEN EXCLUDED.legal_accepted_at ELSE p.legal_accepted_at END,
         birth_date               = COALESCE(p.birth_date, EXCLUDED.birth_date)
   WHERE p.terms_version_accepted   IS DISTINCT FROM EXCLUDED.terms_version_accepted
      OR p.privacy_version_accepted IS DISTINCT FROM EXCLUDED.privacy_version_accepted
      OR p.legal_accepted_at IS NULL
      OR p.birth_date IS NULL;

  INSERT INTO public.terms_acceptances (user_id, document_type, document_version, accepted_at, ip_address, user_agent)
  SELECT v_uid, d.document_type, d.document_version, v_now, p_ip, left(p_user_agent, 512)
    FROM (VALUES ('terms_of_service', p_terms_version), ('privacy_policy', p_privacy_version)) AS d (document_type, document_version)
   WHERE NOT EXISTS (SELECT 1 FROM public.terms_acceptances AS t
                      WHERE t.user_id = v_uid AND t.document_type = d.document_type AND t.document_version = d.document_version);

  RETURN (SELECT jsonb_build_object(
            'terms_version_accepted',   p.terms_version_accepted,
            'privacy_version_accepted', p.privacy_version_accepted,
            'legal_accepted_at',        p.legal_accepted_at,
            'birth_date',               p.birth_date)
            FROM public.user_profiles AS p WHERE p.id = v_uid);
END $$;
REVOKE ALL ON FUNCTION public.accept_legal_documents(text, text, inet, text, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_legal_documents(text, text, inet, text, date) TO authenticated;

-- ─────────────────────────────────────────────────────────
-- 11. 昇格 RPC 2 本 (CREATE OR REPLACE。signature・戻り値・属性・ACL は現行のまま。本文は土台の定義 + 3 つの IF (+ 承諾の upsert の birth_date))
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_child_promotion(p_member_id UUID, p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role family_role_enum;
  v_member family_members;
  v_request family_promotion_requests;
  v_token TEXT;
  v_family_name TEXT;
  v_requester_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- 認可を先に (email 解決より前 = 列挙オラクルを作らない)。member 不在時も
  -- v_member.family_id = NULL → ロール NULL → NOT_FAMILY_ADULT (存在有無を漏らさない)。
  -- この FOR UPDATE が canonical 順の先頭ロック。同一 member への並行
  -- request/revoke/accept/reject はこの行で完全直列化される。
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id FOR UPDATE;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- 対象は active な子供プレースホルダーであること
  -- (user_id IS NULL ⟺ role='child' は family_members_child_profile_consistency CHECK が保証)
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.status <> 'active' THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- #1173 13 歳未満 (COPPA_AGE_YEARS) は本人のアカウントとつながない (同意書の第 3 段落)。18 歳未満 (ADULT_AGE_YEARS) は有効な保護者の同意が要る
  IF v_member.birth_date IS NULL THEN
    RAISE EXCEPTION 'CHILD_BIRTH_DATE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF public.age_years_jst(v_member.birth_date) < 13 THEN  -- COPPA_AGE_YEARS
    RAISE EXCEPTION 'PROMOTION_UNDER_COPPA_AGE' USING ERRCODE = 'P0001';
  END IF;
  IF public.age_years_jst(v_member.birth_date) < 18 AND NOT public.parental_consent_active(v_member.id) THEN  -- ADULT_AGE_YEARS
    RAISE EXCEPTION 'PARENTAL_CONSENT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- #1163: 24 時間の作成上限 (依頼者ごと 10 / 同じ家族から同じ宛先へ 3)。超過は 'RATE_LIMITED'。ロック順: 上の FOR UPDATE -> 上限の advisory -> 下の request 行
  PERFORM public.enforce_membership_daily_cap('child_promotion', v_member.family_id, p_email);

  -- 既存 pending の失効 (request 行ロックは member 行ロック取得済みの今なら安全)
  UPDATE family_promotion_requests
    SET status = 'revoked', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE member_id = p_member_id AND status = 'pending';

  -- G4: gen_random_bytes は使用禁止 (pgcrypto/search_path 地雷 = 20260511000134 の教訓)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO family_promotion_requests
    (family_id, member_id, email, token, status, requested_by, expires_at)
  VALUES
    (v_member.family_id, p_member_id, lower(p_email), v_token, 'pending', auth.uid(),
     NOW() + INTERVAL '14 days')
  RETURNING * INTO v_request;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promotion_requested', auth.uid(), NULL,
          jsonb_build_object('member_id', p_member_id, 'request_id', v_request.id,
                             'email', lower(p_email)));

  -- メール文面用の表示名 (auth.users 参照は SECURITY DEFINER 関数本体内のみ = 確立パターン)
  SELECT name INTO v_family_name FROM family_groups WHERE id = v_member.family_id;
  SELECT COALESCE(up.nickname, au.email) INTO v_requester_name
    FROM auth.users au
    LEFT JOIN user_profiles up ON up.id = au.id
    WHERE au.id = auth.uid();

  RETURN jsonb_build_object(
    'id',                  v_request.id,
    'family_id',           v_request.family_id,
    'member_id',           v_request.member_id,
    'member_display_name', v_member.display_name,
    'family_name',         v_family_name,
    'email',               v_request.email,
    'token',               v_request.token,
    'status',              v_request.status,
    'expires_at',          v_request.expires_at,
    'requester_name',      v_requester_name
  );
EXCEPTION
  WHEN deadlock_detected THEN
    -- #1232 v3 (G10): 他機能とのロック交差等で 40P01 になっても 500/UNKNOWN を漏らさず
    -- 再試行可能な競合 (409) として返す。副作用はサブトランザクションごと巻き戻り済み。
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;

CREATE OR REPLACE FUNCTION public.accept_child_promotion(
  p_token TEXT,
  p_share_meals BOOLEAN DEFAULT TRUE,
  p_share_health BOOLEAN DEFAULT FALSE,
  p_share_menu BOOLEAN DEFAULT TRUE
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request family_promotion_requests;
  v_member family_members;
  v_caller_email TEXT;
  v_constraint TEXT;
  v_profile_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  --     (#1310: その前に (1b) で family_groups の行をロックする。family_groups -> family_members -> family_promotion_requests)
  -- (1) 非ロック読み: member_id 解決 + 終端 status の早期確定。
  --     終端 status (accepted/rejected/revoked/expired) は不変条件のため
  --     非ロック読みでも確定判定してよい。'pending' だけが遷移しうるので (3) で再検証する。
  --     member_id / family_id / token は全 RPC を通じて UPDATE されない不変列 → (1b) (2) でそのまま使える。
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'expired' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  ELSIF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- (1b) 家族の行を先にロック (#1310)。従来は (2) の member 行が最初のロックで、家族の行は (プロフィールの family_id の
  --      外部キー確認で) 最後に FOR KEY SHARE を取るだけだった。解散・削除と同時だと、家族の行を先に取った側と
  --      member 行を先に取った側で待ち合ってデッドロックした。家族の行が無ければ何もせず、(2) が PROMOTION_MEMBER_UNAVAILABLE になる。
  PERFORM 1 FROM family_groups WHERE id = v_request.family_id FOR NO KEY UPDATE;

  -- (2) member 行を先にロック (家族の行の次。request_child_promotion と同順)
  SELECT * INTO v_member FROM family_members WHERE id = v_request.member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- (3) request 行をロックし、(1) の 'pending' 判定を再検証
  --     ((1)→(3) の間に revoke/再送で遷移した可能性がある。member ロック保持中は
  --      canonical 順に従う他 RPC はもうこの行に触れないため、(3) 以降は安定)
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    IF v_request.status = 'expired' THEN
      RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
    ELSE
      RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- 期限切れ。status を 'expired' に UPDATE しても直後の RAISE で巻き戻るため書かない
  -- (status は 'pending' のまま。期限切れは常に expires_at で判定する)。
  IF v_request.expires_at < NOW() THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 対象者本人であることを「自分のメール」で検証 (呼び出し者自身 = 列挙オラクルにならない)
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_request.email) THEN
    RAISE EXCEPTION 'PROMOTION_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- member の状態検証 ((2) でロック済みの行が権威)
  IF v_member.status <> 'active' THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;

  -- #1173 13 歳未満 (COPPA_AGE_YEARS) は本人のアカウントとつながない (同意書の第 3 段落)。18 歳未満 (ADULT_AGE_YEARS) は有効な保護者の同意が要る
  IF v_member.birth_date IS NULL THEN
    RAISE EXCEPTION 'CHILD_BIRTH_DATE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF public.age_years_jst(v_member.birth_date) < 13 THEN  -- COPPA_AGE_YEARS
    RAISE EXCEPTION 'PROMOTION_UNDER_COPPA_AGE' USING ERRCODE = 'P0001';
  END IF;
  IF public.age_years_jst(v_member.birth_date) < 18 AND NOT public.parental_consent_active(v_member.id) THEN  -- ADULT_AGE_YEARS
    RAISE EXCEPTION 'PARENTAL_CONSENT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 呼び出し者が既にどこかの family に所属していないこと (クリーンパスの事前チェック)
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- #1584: 承諾した本人のプロフィールの名前 (user_profiles.nickname) を、メンバーの行の display_name に写す。
  -- 子供のときの display_name (家族の中での呼び名) が入っていれば上書きしない (空・空白だけのときだけ写す)。
  -- 判定は @homegohan/shared の normalizeProfileName と同じ: 前後の空白 (JavaScript の String.prototype.trim と同じ文字) を除き、
  -- 空なら名前なし、仮置きの 'Guest' (前後の空白を除いて厳密一致) も名前なし。名前なしのときは写さない (NULL のまま)。
  -- プロフィールの行がまだ無い人 (初期設定より前に承諾した人) も名前なしで、写さない。
  SELECT NULLIF(btrim(nickname, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') INTO v_profile_name FROM user_profiles WHERE id = auth.uid();
  IF v_profile_name = 'Guest' THEN
    v_profile_name := NULL;
  END IF;

  -- G3 (v2): 同一本人の 2 token 並行 accept は uniq_family_members_user の 23505 を
  -- ALREADY_IN_FAMILY(409) へ正規化。他の unique violation は再 RAISE。
  BEGIN
    UPDATE family_members
      SET user_id = auth.uid(), child_profile = NULL, role = 'adult',
          share_meals = p_share_meals, share_health = p_share_health, share_menu = p_share_menu,
          display_name = CASE
            WHEN NULLIF(btrim(display_name, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') IS NULL AND v_profile_name IS NOT NULL THEN v_profile_name
            ELSE display_name
          END
      WHERE id = v_member.id
      RETURNING * INTO v_member;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'uniq_family_members_user' THEN
        RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
      END IF;
      RAISE;
  END;

  -- 所属家族を本人のプロフィールに入れる。メールのリンクから新規登録して初期設定 (オンボーディング) より前に
  -- 承認した人は、まだプロフィール行が無い (auth.users → user_profiles を作るトリガーは無く、行は初期設定の
  -- 保存で作られる)。UPDATE だけだと 0 行で終わり、後から初期設定で作られる行の family_id は NULL のままになり、
  -- 家族の画面で「家族なし」扱いになる。行が無ければ、アプリの既定値 (/api/profile・/api/onboarding/progress と同じ
  -- nickname 'Guest'・age_group / gender 'unspecified') で作る。初期設定の日時は入れないため初期設定の流れは変わらない。
  -- (2026-10-07 オーナー判断。設計 v2/v3 からの追加)
  -- #1173: 子供の行の生年月日 (保護者が入れた、同意の対象の値) を本人のプロフィールへ写す (先に入っていた値も上書きする)
  INSERT INTO user_profiles (id, nickname, age_group, gender, family_id, birth_date)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified', v_member.family_id, v_member.birth_date)
  ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id, birth_date = EXCLUDED.birth_date;

  UPDATE family_promotion_requests
    SET status = 'accepted', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE id = v_request.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promoted', auth.uid(), auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'request_id', v_request.id,
                             'requested_by', v_request.requested_by));

  RETURN v_member;
EXCEPTION
  WHEN deadlock_detected THEN
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;

-- ─────────────────────────────────────────────────────────
-- 12. 18 歳未満の本人の家族・組織の役割 (述語 1 本 + 既存の 4 関数の本文に IF を 1 つずつ)
-- ─────────────────────────────────────────────────────────
-- 呼び出した本人 (auth.uid()) の生年月日が分かっていて 18 歳未満 (ADULT_AGE_YEARS。要件 03 §17.10) なら true。
-- 生年月日の無い人・プロフィールの行の無い人・auth.uid() の無い呼び出しは false (年齢が分からない。強制ありでは同意ゲートが生年月日の登録を先に求める)。
-- 使う所は、本人に家族の行・代表者・組織のオーナーを付ける 4 関数の先頭だけ (所有者 postgres の SECURITY DEFINER の本文から呼ぶ)。クライアントには開けない
CREATE OR REPLACE FUNCTION public.caller_is_minor_jst() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE(
    (SELECT public.age_years_jst(up.birth_date) < 18
       FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())),
    false)
$$;
REVOKE ALL ON FUNCTION public.caller_is_minor_jst() FROM PUBLIC, anon, authenticated, service_role;

-- 4 関数の本文は土台の定義 (create_family_group は #1678 の normalize_profile_name の式つき) に上の IF を 1 つ足しただけ。
-- signature・戻り値・既定値・SECURITY DEFINER・search_path・ACL は変えない (CREATE OR REPLACE は ACL を残す)。
CREATE OR REPLACE FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text" DEFAULT 'free'::"text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_group family_groups;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  -- #1173 18 歳未満の本人 (生年月日の分かる人) は、昇格 (accept_child_promotion) 以外で家族に入らず、家族の代表者・組織のオーナーを引き受けない
  -- (保護者の同意とのつながりが切れたときの出口 = 退会を、代表者・オーナーの 409 で塞がない。設計書 cross/14 §6.4 の 12)
  IF public.caller_is_minor_jst() THEN
    RAISE EXCEPTION 'MINOR_ACCOUNT_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_groups (name, representative_id, plan_key)
  VALUES (p_name, auth.uid(), p_plan_key)
  RETURNING * INTO v_group;

  INSERT INTO family_members (family_id, user_id, role, display_name)
  VALUES (v_group.id, auth.uid(), 'representative',
          -- #1678: 仮置きの 'Guest'・空白だけの名前は写さない (NULL)。名前は前後の空白を除いて写す
          (SELECT public.normalize_profile_name(nickname) FROM user_profiles WHERE id = auth.uid()));

  UPDATE user_profiles SET family_id = v_group.id WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_group.id, 'group_created', auth.uid(), auth.uid());

  RETURN v_group;
END $$;

CREATE OR REPLACE FUNCTION public.accept_family_invite(
  p_token TEXT,
  p_share_meals BOOLEAN DEFAULT TRUE,
  p_share_health BOOLEAN DEFAULT FALSE,
  p_share_menu BOOLEAN DEFAULT TRUE
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_member family_members;
  v_caller_email TEXT;
  v_count INT;
  v_limit INT;
  v_family_id UUID;
  v_family_found BOOLEAN;
  v_family_status TEXT;
  v_profile_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  -- #1173 18 歳未満の本人 (生年月日の分かる人) は、昇格 (accept_child_promotion) 以外で家族に入らず、家族の代表者・組織のオーナーを引き受けない
  -- (保護者の同意とのつながりが切れたときの出口 = 退会を、代表者・オーナーの 409 で塞がない。設計書 cross/14 §6.4 の 12)
  IF public.caller_is_minor_jst() THEN
    RAISE EXCEPTION 'MINOR_ACCOUNT_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_invites -> family_members。
  -- 招待の行を FOR UPDATE する前に、招待の宛先の家族の行をロックする。招待の family_id は変わらない列なので、
  -- 家族の id だけロックなしで読む (招待が無ければここで INVITE_NOT_FOUND)。
  SELECT family_id INTO v_family_id FROM family_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 人数を数える前に、家族の行をロックする (#1213)。別の招待を持つ人の承諾や子供の追加が同時に走っても、
  -- この行を取り合って 1 件ずつ処理されるので、下の人数確認と INSERT の間に他のメンバーが入り込めない。
  -- 解散・削除と同時でも、ここで終わりまで待ってから最新の status / member_limit を読む。
  -- 家族の行が無い場合 (代表者が家族ごと削除した直後など) と status の確認は、従来の順番どおり下で行う。
  -- FOR NO KEY UPDATE: 外部キーの確認 (FOR KEY SHARE) と衝突しない最も強いロック。
  SELECT member_limit, status INTO v_limit, v_family_status
    FROM family_groups WHERE id = v_family_id FOR NO KEY UPDATE;
  v_family_found := FOUND;

  -- ★ Warning 2: SELECT FOR UPDATE で二重受諾防止 (家族の行のロックのあと)
  SELECT * INTO v_invite FROM family_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  -- 防御: ロックなしで読んだ家族と違う家族の招待になっていたら、ロックしていない家族に INSERT しないよう止める
  IF v_invite.family_id <> v_family_id THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE family_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- ロックした家族の status も確認する。解散済み (status <> 'active') の家族には参加させない。家族の行が無い場合も同じ。
  IF NOT v_family_found OR v_family_status <> 'active' THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = v_invite.family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- #1584: 承諾した本人のプロフィールの名前 (user_profiles.nickname) を、メンバーの行の display_name に写す。
  -- 判定は @homegohan/shared の normalizeProfileName と同じ: 前後の空白 (JavaScript の String.prototype.trim と同じ文字) を除き、
  -- 空なら名前なし、仮置きの 'Guest' (前後の空白を除いて厳密一致) も名前なし。名前なしのときは写さない (NULL のまま)。
  -- プロフィールの行がまだ無い人 (初期設定より前に承諾した人) も名前なしで、写さない。
  SELECT NULLIF(btrim(nickname, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') INTO v_profile_name FROM user_profiles WHERE id = auth.uid();
  IF v_profile_name = 'Guest' THEN
    v_profile_name := NULL;
  END IF;

  INSERT INTO family_members (
    family_id, user_id, role, share_meals, share_health, share_menu, display_name
  ) VALUES (
    v_invite.family_id, auth.uid(), 'adult', p_share_meals, p_share_health, p_share_menu, v_profile_name
  ) RETURNING * INTO v_member;

  -- 所属家族を本人のプロフィールに入れる (#1273)。初期設定より前に承諾した人はまだプロフィール行が無く、
  -- UPDATE だけだと 0 行で終わって family_id が NULL のままになる。行が無ければ既定値 ('Guest' / 'unspecified') で作る。
  -- 初期設定の日時は入れない。accept_child_promotion (20261007112100) と同じ形。
  INSERT INTO user_profiles (id, nickname, age_group, gender, family_id)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified', v_invite.family_id)
  ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id;

  UPDATE family_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_member;
END $$;

CREATE OR REPLACE FUNCTION public.accept_family_representative_transfer(p_proposal_id UUID)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_family_id UUID;
  v_old_rep_id UUID;
  v_result family_groups%ROWTYPE;
BEGIN
  -- #1173 18 歳未満の本人 (生年月日の分かる人) は、昇格 (accept_child_promotion) 以外で家族に入らず、家族の代表者・組織のオーナーを引き受けない
  -- (保護者の同意とのつながりが切れたときの出口 = 退会を、代表者・オーナーの 409 で塞がない。設計書 cross/14 §6.4 の 12)
  IF public.caller_is_minor_jst() THEN
    RAISE EXCEPTION 'MINOR_ACCOUNT_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals
      SET status = 'expired', resolved_at = NOW()
      WHERE id = p_proposal_id AND status = 'pending';
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_family_id := v_proposal.scope_id;
  v_old_rep_id := v_proposal.from_user_id;

  -- LOCK-ORDER (#1310): family_groups -> ownership_transfer_proposals -> family_members。
  -- メンバーの行を書き換える前に家族の行をロックする (従来は メンバー → 家族の行 の順だった)。
  -- 解散・削除と同時でも、その完了を待ってから下の所属の再検証をするので、解散済みの家族の representative_id は書き換わらない。
  -- 家族の行が無ければ何もせず、下の確認が TRANSFER_ACCEPTOR_NOT_IN_FAMILY になる。
  PERFORM 1 FROM family_groups WHERE id = v_family_id FOR NO KEY UPDATE;

  -- ★(A) #1237 Fix: 承諾者が今も対象家族の active adult / representative であることを再検証。
  -- leave_family / remove_family_member は family_members.status を 'left' / 'removed' に、
  -- user_profiles.family_id を NULL に同一トランザクションで設定するため、
  -- status = 'active' 行の存在確認で「今も対象家族に所属」を判定できる。
  -- role IN ('representative','adult') は operator_force_representative_transfer
  -- (20260511000125) と対称の防御多層化。propose 側で child は既に
  -- CANNOT_TRANSFER_TO_CHILD で遮断されるため happy path には無影響。
  IF NOT EXISTS (
    SELECT 1 FROM family_members
      WHERE family_id = v_family_id
        AND user_id = auth.uid()
        AND status = 'active'
        AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TRANSFER_ACCEPTOR_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- ★(B) TOCTOU close
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  -- role swap (現行 20260711120000 と完全同一)
  UPDATE family_members SET role = 'adult'
    WHERE family_id = v_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = v_family_id AND user_id = auth.uid() AND status = 'active';
  UPDATE family_groups SET representative_id = auth.uid() WHERE id = v_family_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_family_id, 'representative_transferred', auth.uid(), v_old_rep_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM family_groups WHERE id = v_family_id;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION "public"."accept_org_owner_transfer"("p_proposal_id" "uuid") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_org_id UUID;
  v_old_owner_id UUID;
  v_result organizations%ROWTYPE;
BEGIN
  -- #1173 18 歳未満の本人 (生年月日の分かる人) は、昇格 (accept_child_promotion) 以外で家族に入らず、家族の代表者・組織のオーナーを引き受けない
  -- (保護者の同意とのつながりが切れたときの出口 = 退会を、代表者・オーナーの 409 で塞がない。設計書 cross/14 §6.4 の 12)
  IF public.caller_is_minor_jst() THEN
    RAISE EXCEPTION 'MINOR_ACCOUNT_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  -- pending かつ宛先が呼び出し元である proposal を取得 (既存挙動不変)
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals
      SET status = 'expired', resolved_at = NOW()
      WHERE id = p_proposal_id AND status = 'pending';
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_proposal.scope_id;
  v_old_owner_id := v_proposal.from_user_id;

  -- ★(A) #1236 Fix: 承諾者が今も対象組織のメンバであることを再検証。
  -- leave_org / remove_org_member / release_user_membership は organization_id を NULL に、
  -- 他組織 accept_org_invite は別 org 値に、いずれもアトミックに設定するため、
  -- organization_id = v_org_id の一致確認だけで「今も対象組織に所属」を判定できる。
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'TRANSFER_ACCEPTOR_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- ★(B) #1236 Fix: status = 'pending' 条件つき UPDATE で二重受諾 / 競合 (TOCTOU) を閉じる。
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  -- role swap (順序・意味は現行 20260711120000 と完全同一)
  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = auth.uid();
  UPDATE organizations SET owner_id = auth.uid() WHERE id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_org_id, 'owner_transferred', auth.uid(), v_old_owner_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM organizations WHERE id = v_org_id;
  RETURN v_result;
END $$;
