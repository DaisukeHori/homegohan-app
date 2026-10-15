-- migration: 20261015120000_deletion_record_and_invite_email_hash.sql
-- #1562 (#1447 の整合ゲートの残り): 退会の「削除の実行記録」と、招待の監査に残る招待先のアドレスのハッシュ化
--
-- 背景:
--   (2)(3) 退会 (src/lib/account-deletion.ts) は、誰がいつ消したかを恒久的な記録に残していなかった
--          (app_logs に 'account deleted' のログを残すだけ)。使われていない gdpr_deletion_requests (旧設計の
--          「削除要求 → 30 日待機 → 月次バッチで削除」の表) を、削除の実行記録に当てる。
--          記録は個人を特定できない形にする: 利用者の id は持たず、id の HMAC (秘密の値つきのハッシュ) だけを持つ。
--          退会の CASCADE / SET NULL で記録が消えたり書き換わったりしないよう、利用者の行を指す外部キーを持たない。
--   (4)    membership_audit.metadata に、招待先 (家族・組織の招待、子供メンバーの昇格リクエスト) の生のメールアドレス
--          ('email') が残っていた。退会しても伏せていなかった (#1163 の 24 時間の送信上限がこの値を数えるため。
--          20261010000100 の「伏せないもの」)。生のアドレスの代わりに HMAC ('email_hash') を残し、上限の判定も
--          HMAC 同士で比べる。既存の行も置き換える。
--
-- 変更:
--   A. 秘密の値 (HMAC の鍵): Supabase Vault (既存の仕組み。app_cron_secret と同じ) に 'pii_hmac_key' として置く。
--      無ければこの migration が乱数で作る (値はファイルにもログにも出さない)。あれば作り直さない (作り直すと既存のハッシュと合わなくなる)。
--   B. public.pii_hmac_hex(p_domain, p_value): HMAC-SHA256 (16 進 64 文字) の計算。鍵は Vault から読む。
--      用途ごとに p_domain を前に付けて計算し、用途の違う値どうしが同じハッシュにならないようにする。
--      public.membership_invite_email_hash(p_email): 招待先のアドレスを正規化 (lower(btrim)) してからハッシュにする。
--      どちらも SECURITY DEFINER (Vault を読むため)、EXECUTE は service_role だけ (テストが期待値を計算するため)。
--   C. membership_audit: BEFORE INSERT OR UPDATE のトリガーで、metadata に 'email' があれば取り除き、'email_hash' を入れる。
--      書く側 (create_family_invite / audit_organization_invite_created / request_child_promotion、これから足すもの) を
--      書き換えなくても、生のアドレスが表に入らない (書く関数の本文とロックを触らない。CLAUDE.md の家族の関数のロック)。
--      既存の行は、同じ関数 (membership_audit_hash_email_in_metadata) で置き換える。
--   D. enforce_membership_daily_cap (#1163) の「同じ宛先へ 3」を、metadata ->> 'email_hash' と、
--      渡された宛先のハッシュとの比較にする。数える行・上限の数・ロックの順は変えない (本文は 20261008100000 の定義のまま、
--      v_email を v_email_hash に置き換えただけ)。
--   E. gdpr_deletion_requests を削除の実行記録に当てる:
--      - 列を足す: subject_hash (利用者の id の HMAC)・executor_type ('self' 本人 / 'operator' 運営)・
--        reason (理由のコード。自由な文は入れない)・request_id (app_logs の request_id。調査用)
--      - user_id の外部キーを外す (列は残す。新しい記録は user_id を書かない)。退会で記録が消えない・書き換わらない形にする。
--        executed_by (運営が実行したときの運営者) の外部キーは ON DELETE SET NULL のまま残す (行は消えない)。
--      - RLS は有効のまま、利用者向けのポリシー (gdpr_insert_self / gdpr_select / gdpr_update) を外し、
--        anon / authenticated の表の権限も外す。読み書きは service_role だけ。
--      - 書く関数: begin_account_deletion_record (削除の直前に呼ぶ。行を作り、id を返す) と
--        complete_account_deletion_record (削除が済んだら呼ぶ。executed_at を入れる)。どちらも service_role だけ。
--
-- 既存のデータへの影響:
--   - membership_audit: metadata に 'email' を持つ行 (招待・昇格リクエストの作成の記録) の 'email' を 'email_hash' に置き換える。
--     ⛔ 元に戻せない (生のアドレスは残らない)。件数: SELECT count(*) FROM public.membership_audit WHERE metadata ? 'email';
--     上限の判定はハッシュ同士で比べるので、置き換えの前後で「同じ宛先へ 3」の数え方は変わらない。
--   - gdpr_deletion_requests: 既存の行には触れない (列を足すだけ。足した列は NULL)。
--
-- 権限の定型 (#1039/#1020): 新しい関数には Supabase の既定権限で anon / authenticated / service_role に EXECUTE が付き、PUBLIC にも
--   付くので、引数の型まで含めた完全形で REVOKE し、必要なロールにだけ GRANT し直す。関数は SET search_path = ''、参照は完全修飾。
--   HMAC は pgcrypto (extensions スキーマ) の extensions.hmac を完全修飾で呼ぶ (search_path に頼らない)。
-- 冪等: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE / 鍵は無いときだけ作る。
--   membership_audit の置き換えは 'email' を持つ行だけが対象なので、2 回目は 0 行。
-- 戻し方: supabase/rollbacks/20261015120000_deletion_record_and_invite_email_hash.down.sql
--   (ハッシュにしたアドレスは戻らない。戻すと、上限の「同じ宛先へ 3」は既存の行を数えなくなる)
-- 確かめるテスト:
--   tests/integration/security/deletion-record-and-invite-email-hash.test.ts (実 DB)
--   tests/integration/security/account-deletion.test.ts / membership-daily-cap.test.ts (実 DB)
--   tests/deletion-record-invite-hash-migration-contract.test.ts (静的)

-- ─────────────────────────────────────────────────────────
-- A. HMAC の鍵 (Vault)
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets AS s WHERE s.name = 'pii_hmac_key') THEN
    -- gen_random_uuid() は強い乱数 (pg_strong_random)。2 つで 244 ビット。
    -- pgcrypto の gen_random_bytes は使わない (20260511000134 の教訓。search_path に頼る呼び方で失敗した)
    PERFORM vault.create_secret(
      pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', '')
        || pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', ''),
      'pii_hmac_key',
      '#1562: 個人を特定しないためのハッシュ (HMAC-SHA256) の鍵。membership_audit の招待先のアドレス・削除の実行記録の利用者の id。作り直すと既存のハッシュと合わなくなる'
    );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────
-- B. ハッシュの関数
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pii_hmac_hex(p_domain text, p_value text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_key pg_catalog.text;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_domain IS NULL OR p_domain = '' THEN
    RAISE EXCEPTION 'pii_hmac_hex: p_domain is required' USING ERRCODE = '22023';
  END IF;

  SELECT s.decrypted_secret INTO v_key
    FROM vault.decrypted_secrets AS s
   WHERE s.name = 'pii_hmac_key';
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'pii_hmac_key not found in Vault' USING ERRCODE = 'P0001';
  END IF;

  RETURN pg_catalog.encode(extensions.hmac(p_domain || ':' || p_value, v_key, 'sha256'), 'hex');
END
$function$;

REVOKE ALL ON FUNCTION public.pii_hmac_hex(text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pii_hmac_hex(text, text) TO service_role;

COMMENT ON FUNCTION public.pii_hmac_hex(text, text) IS
  '#1562: HMAC-SHA256 (16 進 64 文字)。鍵は Vault の pii_hmac_key。p_domain (用途) を前に付けて計算する。p_value が NULL なら NULL。service_role のみ';

CREATE OR REPLACE FUNCTION public.membership_invite_email_hash(p_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN p_email IS NULL OR pg_catalog.btrim(p_email) = '' THEN NULL
    ELSE public.pii_hmac_hex('membership_invite_email', pg_catalog.lower(pg_catalog.btrim(p_email)))
  END
$function$;

REVOKE ALL ON FUNCTION public.membership_invite_email_hash(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.membership_invite_email_hash(text) TO service_role;

COMMENT ON FUNCTION public.membership_invite_email_hash(text) IS
  '#1562: 招待先のアドレスのハッシュ (lower(btrim) で正規化してから pii_hmac_hex)。membership_audit.metadata の email_hash と、上限の判定 (enforce_membership_daily_cap) が使う。空なら NULL。service_role のみ';

-- ─────────────────────────────────────────────────────────
-- C. membership_audit.metadata の 'email' を 'email_hash' に置き換える
-- ─────────────────────────────────────────────────────────
-- metadata を受け取り、'email' を取り除いて 'email_hash' を入れたものを返す ('email' が無ければそのまま)。
-- 'email' が文字列でない・空のときは、取り除くだけ (ハッシュを入れない)。トリガーと既存の行の置き換えが共通で使う
CREATE OR REPLACE FUNCTION public.membership_audit_hash_email_in_metadata(p_metadata jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_hash pg_catalog.text;
BEGIN
  IF p_metadata IS NULL OR NOT (p_metadata ? 'email') THEN
    RETURN p_metadata;
  END IF;
  IF pg_catalog.jsonb_typeof(p_metadata -> 'email') = 'string' THEN
    v_hash := public.membership_invite_email_hash(p_metadata ->> 'email');
  END IF;
  IF v_hash IS NULL THEN
    RETURN p_metadata - 'email';
  END IF;
  RETURN (p_metadata - 'email')
    || pg_catalog.jsonb_build_object('email_hash', v_hash);
END
$function$;

REVOKE ALL ON FUNCTION public.membership_audit_hash_email_in_metadata(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.membership_audit_hash_email_in_metadata(jsonb) IS
  '#1562: membership_audit.metadata の email (招待先の生のアドレス) を取り除き、email_hash (membership_invite_email_hash) を入れる。トリガー membership_audit_hash_invite_email と、既存の行の置き換えが使う。誰にも EXECUTE を付けない';

-- トリガー関数。誰にも EXECUTE を付けない (トリガーとして動くときは EXECUTE を確認されない)
CREATE OR REPLACE FUNCTION public.membership_audit_hash_invite_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  NEW.metadata := public.membership_audit_hash_email_in_metadata(NEW.metadata);
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.membership_audit_hash_invite_email() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.membership_audit_hash_invite_email() IS
  '#1562: membership_audit に生の招待先アドレス (metadata.email) を残さない。BEFORE INSERT OR UPDATE で email を email_hash に置き換える';

DROP TRIGGER IF EXISTS trg_membership_audit_hash_invite_email ON public.membership_audit;
CREATE TRIGGER trg_membership_audit_hash_invite_email
  BEFORE INSERT OR UPDATE OF metadata ON public.membership_audit
  FOR EACH ROW
  WHEN (NEW.metadata ? 'email')
  EXECUTE FUNCTION public.membership_audit_hash_invite_email();

-- 既存の行の置き換え (元に戻せない)。トリガーと同じ関数を使う
UPDATE public.membership_audit AS a
   SET metadata = public.membership_audit_hash_email_in_metadata(a.metadata)
 WHERE a.metadata ? 'email';

-- ─────────────────────────────────────────────────────────
-- D. 24 時間上限の判定 (#1163): 宛先をハッシュ同士で比べる
--    本文は 20261008100000 の定義のまま。v_email (lower(p_email)) と metadata ->> 'email' の比較を、
--    v_email_hash (membership_invite_email_hash(p_email)) と metadata ->> 'email_hash' の比較にしただけ。
--    上限の数・数える行・ロックの順・認可・RAISE の形は変えない。
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_membership_daily_cap(
  p_kind TEXT,
  p_scope_id UUID,
  p_email TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor      UUID := auth.uid();
  v_email_hash TEXT;
  v_since      TIMESTAMPTZ := pg_catalog.now() - INTERVAL '24 hours';
  v_count      BIGINT;
  v_oldest     TIMESTAMPTZ;
  v_rule       TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'family_invite' THEN
    -- 直接呼ばれても他の家族の件数を覗けないよう、create_family_invite と同じ認可をここでも行う
    IF NOT public.is_active_family_adult(p_scope_id) THEN
      RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:family_invite:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:family_invite:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'invite_created' AND a.scope = 'family'
       AND a.created_at > v_since;
    IF v_count >= 20 THEN
      v_rule := 'family_invite:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      v_email_hash := public.membership_invite_email_hash(p_email);
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'family' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since AND (a.metadata ->> 'email_hash') = v_email_hash;
      IF v_count >= 3 THEN
        v_rule := 'family_invite:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'org_invite' THEN
    -- create_org_invite と同じ認可 (所属組織の owner / admin)
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = v_actor AND up.organization_id = p_scope_id
         AND up.org_role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:org_invite:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:org_invite:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'invite_created' AND a.scope = 'organization'
       AND a.created_at > v_since;
    IF v_count >= 200 THEN
      v_rule := 'org_invite:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'organization' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since;
      IF v_count >= 500 THEN
        v_rule := 'org_invite:per_org';
      END IF;
    END IF;

    IF v_rule IS NULL THEN
      v_email_hash := public.membership_invite_email_hash(p_email);
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'organization' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since AND (a.metadata ->> 'email_hash') = v_email_hash;
      IF v_count >= 3 THEN
        v_rule := 'org_invite:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'child_promotion' THEN
    -- 宛先の上限は「同じ家族から同じ宛先へ」で数える (#1232 v2 §10 の family / email 単位)。
    -- アプリ層は RPC 前に member_id の所属を確かめられないため依頼者単位で数えているが、DB では
    -- request_child_promotion が認可済みの family_id を渡すので家族単位で数えられる。
    IF NOT public.is_active_family_adult(p_scope_id) THEN
      RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:child_promotion:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:child_promotion:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'child_promotion_requested'
       AND a.created_at > v_since;
    IF v_count >= 10 THEN
      v_rule := 'child_promotion:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      v_email_hash := public.membership_invite_email_hash(p_email);
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'family' AND a.scope_id = p_scope_id AND a.action = 'child_promotion_requested'
         AND a.created_at > v_since AND (a.metadata ->> 'email_hash') = v_email_hash;
      IF v_count >= 3 THEN
        v_rule := 'child_promotion:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'transfer_propose' THEN
    -- 家族の代表者譲渡と組織のオーナー譲渡は同じ枠 (アプリ層の 'transfer-propose' と同じ)
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:transfer_propose:actor:' || v_actor::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor
       AND a.action IN ('owner_transfer_proposed', 'representative_transfer_proposed')
       AND a.created_at > v_since;
    IF v_count >= 10 THEN
      v_rule := 'transfer_propose:per_actor';
    END IF;

  ELSE
    RAISE EXCEPTION 'INVALID_DAILY_CAP_KIND' USING ERRCODE = '22023';
  END IF;

  IF v_rule IS NOT NULL THEN
    RAISE EXCEPTION 'RATE_LIMITED' USING
      ERRCODE = 'P0001',
      DETAIL = v_rule,
      HINT = 'retry_after_sec=' || GREATEST(1, pg_catalog.ceil(pg_catalog.date_part(
               'epoch', v_oldest + INTERVAL '24 hours' - pg_catalog.now())))::BIGINT::TEXT;
  END IF;
END $$;

-- 権限は 20261008100000 と同じ (create_org_invite が SECURITY INVOKER で呼ぶので authenticated に EXECUTE)
REVOKE ALL ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) IS
  '#1163: 招待・昇格リクエスト・譲渡提案の 24 時間上限 (membership_audit を数える)。宛先は #1562 から metadata.email_hash (membership_invite_email_hash) で比べる。超過は RATE_LIMITED (P0001)、DETAIL に上限名、HINT に retry_after_sec。作成 RPC の認可の後・最初の書き込みの前に PERFORM する。';

-- ─────────────────────────────────────────────────────────
-- E. gdpr_deletion_requests を削除の実行記録にする
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.gdpr_deletion_requests
  ADD COLUMN IF NOT EXISTS subject_hash text,
  ADD COLUMN IF NOT EXISTS executor_type text,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS request_id text;

-- 既存の行は足した列が NULL なので、NULL を許す形の CHECK は必ず通る
ALTER TABLE public.gdpr_deletion_requests
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_subject_hash_format,
  ADD CONSTRAINT gdpr_deletion_requests_subject_hash_format
    CHECK (subject_hash IS NULL OR subject_hash ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_executor_type_check,
  ADD CONSTRAINT gdpr_deletion_requests_executor_type_check
    CHECK (executor_type IS NULL OR executor_type IN ('self', 'operator')),
  -- 理由はコードだけ (自由な文に個人の情報が入らないように)
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_reason_code,
  ADD CONSTRAINT gdpr_deletion_requests_reason_code
    CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$');

-- 利用者の行を指す外部キーを外す (退会の SET NULL / CASCADE が記録に届かない)。列は残す (既存の行の値は残る)。
-- 運営者 (executed_by) の外部キーは ON DELETE SET NULL のまま (20261010000100)。運営者が消えても記録の行は残る
ALTER TABLE public.gdpr_deletion_requests
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_user_id_fkey;

CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_requests_subject_hash
  ON public.gdpr_deletion_requests USING btree (subject_hash);

COMMENT ON TABLE public.gdpr_deletion_requests IS
  '#1562: 退会 (アカウント削除) の実行記録。個人を特定できない形 (利用者の id の HMAC = subject_hash) で、日時・理由・実行者 (本人 / 運営) を残す。利用者の行を指す外部キーは持たない。service_role だけが読み書きする。旧設計の「削除要求 → 30 日待機」には使わない';
COMMENT ON COLUMN public.gdpr_deletion_requests.user_id IS
  '#1562: 新しい記録では書かない (NULL)。旧設計の削除要求の名残。外部キーは外した';
COMMENT ON COLUMN public.gdpr_deletion_requests.subject_hash IS
  '#1562: 削除した利用者の id の HMAC-SHA256 (pii_hmac_hex(''account_deletion_subject'', id))。id そのものは残さない';
COMMENT ON COLUMN public.gdpr_deletion_requests.executor_type IS
  '#1562: 実行者。self = 本人の退会 / operator = 運営 (executed_by に運営者)';
COMMENT ON COLUMN public.gdpr_deletion_requests.reason IS
  '#1562: 理由のコード (user_request など)。自由な文は入れない';
COMMENT ON COLUMN public.gdpr_deletion_requests.request_id IS
  '#1562: 削除を実行した処理の request_id (app_logs の request_id と同じ。調査用)';
COMMENT ON COLUMN public.gdpr_deletion_requests.requested_at IS
  '#1562: 削除を始めた日時 (begin_account_deletion_record)';
COMMENT ON COLUMN public.gdpr_deletion_requests.executed_at IS
  '#1562: 削除が済んだ日時 (complete_account_deletion_record)。NULL = 始めたが済んでいない (途中で失敗した)';

-- 利用者向けのポリシーを外し、service_role だけにする (RLS は有効のまま。ポリシーが無いので anon / authenticated は 0 行)
DROP POLICY IF EXISTS gdpr_insert_self ON public.gdpr_deletion_requests;
DROP POLICY IF EXISTS gdpr_select ON public.gdpr_deletion_requests;
DROP POLICY IF EXISTS gdpr_update ON public.gdpr_deletion_requests;
ALTER TABLE public.gdpr_deletion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gdpr_deletion_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.gdpr_deletion_requests TO service_role;

-- 削除の直前に呼ぶ: 記録の行を作り (同じ利用者のまだ済んでいない記録があれば使い直す)、id を返す。
-- p_executor_type = 'operator' のときは p_operator_id (実行した運営者) が要る。'self' のときは p_operator_id を受け付けない
-- (本人の id を executed_by に入れると、記録から本人が分かってしまう)。
CREATE OR REPLACE FUNCTION public.begin_account_deletion_record(
  p_user_id uuid,
  p_executor_type text,
  p_reason text,
  p_request_id text,
  p_operator_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_hash pg_catalog.text;
  v_id   pg_catalog.uuid;
  v_now  pg_catalog.timestamptz := pg_catalog.now();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'begin_account_deletion_record: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_executor_type IS NULL OR p_executor_type NOT IN ('self', 'operator') THEN
    RAISE EXCEPTION 'begin_account_deletion_record: invalid p_executor_type' USING ERRCODE = '22023';
  END IF;
  IF p_executor_type = 'operator' AND p_operator_id IS NULL THEN
    RAISE EXCEPTION 'begin_account_deletion_record: p_operator_id is required for operator' USING ERRCODE = '22023';
  END IF;
  IF p_executor_type = 'self' AND p_operator_id IS NOT NULL THEN
    RAISE EXCEPTION 'begin_account_deletion_record: p_operator_id must be NULL for self' USING ERRCODE = '22023';
  END IF;

  v_hash := public.pii_hmac_hex('account_deletion_subject', p_user_id::pg_catalog.text);

  -- 同じ利用者の削除が同時に 2 本来ても、記録が 2 行にならないようにする
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account_deletion_record:' || v_hash, 0));

  SELECT r.id INTO v_id
    FROM public.gdpr_deletion_requests AS r
   WHERE r.subject_hash = v_hash
     AND r.executed_at IS NULL
     AND r.cancelled_at IS NULL
   ORDER BY r.requested_at DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- やり直し: 前回の途中で止まった記録を使い直す (始めた日時は前回のまま。実行者・理由・request_id は今回のもの)
    UPDATE public.gdpr_deletion_requests AS r
       SET executor_type = p_executor_type,
           executed_by   = p_operator_id,
           reason        = p_reason,
           request_id    = p_request_id
     WHERE r.id = v_id;
    RETURN v_id;
  END IF;

  -- cooling_until (旧設計の 30 日の待機) は使わないので、始めた日時と同じにする (列は NOT NULL)
  INSERT INTO public.gdpr_deletion_requests
    (user_id, subject_hash, executor_type, executed_by, reason, request_id, requested_at, cooling_until)
  VALUES
    (NULL, v_hash, p_executor_type, p_operator_id, p_reason, p_request_id, v_now, v_now)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;

REVOKE ALL ON FUNCTION public.begin_account_deletion_record(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_account_deletion_record(uuid, text, text, text, uuid) TO service_role;

COMMENT ON FUNCTION public.begin_account_deletion_record(uuid, text, text, text, uuid) IS
  '#1562: 退会の直前に呼ぶ。削除の実行記録 (gdpr_deletion_requests) の行を作り id を返す。利用者の id は HMAC (subject_hash) だけを残す。同じ利用者のまだ済んでいない記録があれば使い直す。service_role のみ';

-- 削除が済んだら呼ぶ: executed_at を入れる。すでに入っていれば何もしない (やり直しても同じ)。行が無ければ例外
CREATE OR REPLACE FUNCTION public.complete_account_deletion_record(p_record_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE public.gdpr_deletion_requests AS r
     SET executed_at = pg_catalog.now()
   WHERE r.id = p_record_id
     AND r.executed_at IS NULL;
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.gdpr_deletion_requests AS r WHERE r.id = p_record_id) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_RECORD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.complete_account_deletion_record(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_account_deletion_record(uuid) TO service_role;

COMMENT ON FUNCTION public.complete_account_deletion_record(uuid) IS
  '#1562: 退会の削除 (auth.admin.deleteUser) が済んだら呼ぶ。削除の実行記録の executed_at を入れる。済んでいれば何もしない。service_role のみ';
