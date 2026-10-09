-- migration: 20261008200700_legal_documents_acceptance.sql
-- #1174: 利用規約・プライバシーポリシーへの「明示的な同意」と、同意した版の記録 (改定時の再同意ゲートの DB 側)
--
-- 背景:
--   サインアップ画面は「続行することで、利用規約およびプライバシーポリシーに同意したものとみなされます」という
--   みなし同意だった。同意した事実も、どの版に同意したかも、どこにも残っていない。
--   terms_acceptances (利用規約・プライバシーポリシー同意記録。UPDATE / DELETE 禁止) は本番に作ってあるが、
--   どのコードもまだ書き込んでいない (0 件)。規約を改定したときに「古い版にしか同意していない人」を見つける手段も無い。
--   これを、次の 3 つで直す (Web 側は lib/supabase/middleware.ts の同意ゲートと /legal-consent、POST /api/legal/accept)。
--     1. 利用者ごとに「同意済みの版」を持つ (user_profiles の 3 列)。ゲートは、すでに毎回読んでいる
--        user_profiles の行を使って判定する (追加のクエリを増やさない)。
--     2. 同意の証跡 (誰が・どの文書の・どの版に・いつ・どの IP / 端末から) を terms_acceptances に 1 回ずつ残す。
--     3. 上の 1 と 2 を書けるのは DB 関数 accept_legal_documents だけにする (本人の行だけ。端末情報はサーバーが渡す)。
--
-- 変更:
--   1. user_profiles に列を 3 つ足す (すべて NULL 可・既定値なし。NULL = 未同意)。
--        terms_version_accepted    利用規約で同意済みの版
--        privacy_version_accepted  プライバシーポリシーで同意済みの版
--        legal_accepted_at         いまの版の組に同意した日時
--      版の文字列は packages/shared/src/legal-versions.ts の LEGAL_DOCUMENTS.*.version。DB は版の中身を知らない
--      (どの版が「いま有効」かは Web 側で決める)。形式 (英数字・. _ -、1〜20 文字) だけを関数が検査する。
--   2. 特権列ガード guard_user_profiles_privileged (UPDATE) と guard_user_profiles_privileged_on_insert (INSERT) に、
--      上の 3 列を足す。authenticated / anon が直接 UPDATE / INSERT で書き換えると 42501 (CANNOT_MODIFY_PRIVILEGED_COLUMN)。
--      既存の保護はそのまま (列を足すだけ。本文は 20251126124224 のベースライン時点の定義 + 3 列)。
--      本人の初期設定の保存 (upsert) はこの 3 列を送らないので、これまでどおり通る。
--      service_role (管理 API) と、SECURITY DEFINER の関数 (所有者 postgres) は current_user が違うので対象外。
--   3. accept_legal_documents(p_terms_version, p_privacy_version, p_ip, p_user_agent) を足す (SECURITY DEFINER)。
--      - 書き込む行は常に auth.uid() 本人だけ (他人の ID を渡す引数が無い)。未ログイン (auth.uid() IS NULL) は NOT_AUTHENTICATED。
--      - プロフィール行が無ければ、アプリの既定値 (nickname 'Guest'、age_group / gender 'unspecified'。
--        /api/profile・/api/onboarding/progress、20261007150200 の #1273 と同じ) で作る。
--        新規登録した人は初期設定より前に同意するので、行がまだ無い。初期設定の日時は入れないため、初期設定の導線は変わらない。
--      - 行があるときは、この 3 列だけを更新する。同じ版を送り直しても、記録済みの同意日時は動かさない (冪等)。
--      - terms_acceptances に 2 行 (terms_of_service / privacy_policy) を足す。同じ (本人, 文書, 版) の行がすでにあれば足さない
--        (二重クリックや連打で記録が増えない)。端末情報は呼び出し側 (サーバー) が渡す。user_agent は 512 文字で切る。
--      - 権限は authenticated のみ。anon・service_role からは呼べない。
--
-- 設計上の判断:
--   - terms_acceptances の RLS (本人だけが SELECT / INSERT、UPDATE / DELETE は USING false) はこの migration で変えない。
--     「同意したか」の判定は user_profiles の列で行い、terms_acceptances は証跡なので、本人が直接 INSERT できても
--     ゲートは抜けられない (列は上のガードで守られている)。ただし直接 INSERT した行は端末情報を偽れるため、
--     証跡として確かなのは accept_legal_documents が書いた行。直接 INSERT を閉じるのは、parental_consent /
--     external_data_provision (未成年・AI の同意) の書き込みが関数経由になってから別 migration で行う (残課題)。
--   - 既存ユーザーの同意の補完 (バックフィル) はしない。既存データへの UPDATE / INSERT は一切流さない。
--     既存ユーザーは全員「未同意」から始まる。環境変数 LEGAL_CONSENT_ENFORCE=on にした日から、全員に同意画面が出る
--     (それまでは既定では何も出ない。LEGAL_CONSENT_NOTICE=on にしたときだけ、画面上部に控えめなお知らせが出る)。
--     強制やお知らせを始める日はオーナーが決める。
--   - 同意を記録する関数は、版が「いま有効な版」かを確かめない (DB は版の中身を知らない)。確かめるのは POST /api/legal/accept。
--
-- 本番への影響:
--   - ALTER TABLE ... ADD COLUMN (NULL 可・既定値なし) はテーブルの書き換えを伴わず、一瞬で終わる。既存の行・既存の列は変わらない。
--   - 特権列ガードは CREATE OR REPLACE のため、所有者・EXECUTE 権限・既存の保護は現行のまま。
--   - デプロイ順: この migration を先に (または同時に) 本番へ反映すること。Web は、列がまだ無い間 (42703) は
--     同意ゲートを素通りするようにしてあるが、同意画面の「同意する」は accept_legal_documents が無いと失敗する。
--
-- 冪等: ADD COLUMN IF NOT EXISTS、CREATE OR REPLACE FUNCTION。REVOKE / GRANT / COMMENT は何度流しても同じ結果になる。
-- ロールバック: supabase/rollbacks/20261008200700_legal_documents_acceptance.down.sql
--   (戻すと user_profiles の 3 列の値が消える。terms_acceptances の行は残る。先に Web のデプロイを戻すこと)

-- ─────────────────────────────────────────────────────────
-- 1. 列
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS terms_version_accepted   character varying(20),
  ADD COLUMN IF NOT EXISTS privacy_version_accepted character varying(20),
  ADD COLUMN IF NOT EXISTS legal_accepted_at        timestamp with time zone;

COMMENT ON COLUMN public.user_profiles.terms_version_accepted IS
  '利用規約で同意済みの版 (packages/shared の LEGAL_DOCUMENTS.terms_of_service.version)。NULL = 未同意。本人は直接変更できない (guard_user_profiles_privileged)。accept_legal_documents だけが書く。#1174';
COMMENT ON COLUMN public.user_profiles.privacy_version_accepted IS
  'プライバシーポリシーで同意済みの版 (packages/shared の LEGAL_DOCUMENTS.privacy_policy.version)。NULL = 未同意。本人は直接変更できない (guard_user_profiles_privileged)。accept_legal_documents だけが書く。#1174';
COMMENT ON COLUMN public.user_profiles.legal_accepted_at IS
  'terms_version_accepted / privacy_version_accepted の組に同意した日時。同じ版を送り直しても動かない。本人は直接変更できない (guard_user_profiles_privileged)。#1174';

-- ─────────────────────────────────────────────────────────
-- 2. 特権列ガード (UPDATE): 3 列を足す。それ以外は 20251126124224 のベースライン時点の定義のまま
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
       OR NEW.legal_accepted_at        IS DISTINCT FROM OLD.legal_accepted_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────
-- 2'. 特権列ガード (INSERT): 3 列は、本人が作る行では NULL (未同意) でなければならない
-- ─────────────────────────────────────────────────────────
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
       OR NEW.legal_accepted_at        IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────
-- 3. 同意の記録
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.accept_legal_documents(
  p_terms_version   text,
  p_privacy_version text,
  p_ip              inet DEFAULT NULL,
  p_user_agent      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 版の形式。packages/shared/src/legal-versions.ts の LEGAL_VERSION_PATTERN と同じ
  -- (terms_acceptances.document_version は varchar(20)。形式外を通すと、切り詰めや桁あふれのエラーになる)
  IF p_terms_version IS NULL OR p_terms_version !~ '^[0-9A-Za-z._-]{1,20}$'
     OR p_privacy_version IS NULL OR p_privacy_version !~ '^[0-9A-Za-z._-]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_LEGAL_VERSION' USING ERRCODE = '22023';
  END IF;

  -- 1. 本人のプロフィールに、同意した版を入れる。
  --    行が無ければ既定値で作る (新規登録した人は初期設定より前に同意するので、行がまだ無い。#1273 と同じ形)。
  --    ON CONFLICT DO UPDATE は、WHERE が偽でも対象の行をロックする。同じ本人の同時の呼び出しはここで直列化され、
  --    後から来た方は、先に来た方が commit した後の状態を見る。
  --    版も同意日時も変わらないなら更新しない (同じ版の送り直しで、記録済みの同意日時を動かさない)。
  INSERT INTO public.user_profiles AS p (
    id, nickname, age_group, gender,
    terms_version_accepted, privacy_version_accepted, legal_accepted_at
  ) VALUES (
    v_uid, 'Guest', 'unspecified', 'unspecified',
    p_terms_version, p_privacy_version, v_now
  )
  ON CONFLICT (id) DO UPDATE
     SET terms_version_accepted   = EXCLUDED.terms_version_accepted,
         privacy_version_accepted = EXCLUDED.privacy_version_accepted,
         legal_accepted_at        = EXCLUDED.legal_accepted_at
   WHERE p.terms_version_accepted   IS DISTINCT FROM EXCLUDED.terms_version_accepted
      OR p.privacy_version_accepted IS DISTINCT FROM EXCLUDED.privacy_version_accepted
      OR p.legal_accepted_at IS NULL;

  -- 2. 同意の証跡を 1 文書ずつ残す。同じ (本人, 文書, 版) がすでにあれば足さない。
  --    terms_acceptances は UPDATE / DELETE 禁止の不可逆な記録なので、重複して増やさないことが後で効く。
  INSERT INTO public.terms_acceptances (user_id, document_type, document_version, accepted_at, ip_address, user_agent)
  SELECT v_uid, d.document_type, d.document_version, v_now, p_ip, left(p_user_agent, 512)
    FROM (VALUES
            ('terms_of_service', p_terms_version),
            ('privacy_policy',   p_privacy_version)
         ) AS d (document_type, document_version)
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.terms_acceptances AS t
            WHERE t.user_id          = v_uid
              AND t.document_type    = d.document_type
              AND t.document_version = d.document_version
         );

  RETURN (
    SELECT jsonb_build_object(
             'terms_version_accepted',   p.terms_version_accepted,
             'privacy_version_accepted', p.privacy_version_accepted,
             'legal_accepted_at',        p.legal_accepted_at
           )
      FROM public.user_profiles AS p
     WHERE p.id = v_uid
  );
END
$$;

-- 関数の権限: authenticated のみ。
-- Supabase は関数作成時に anon / authenticated / service_role へ EXECUTE を自動付与し、PUBLIC にも EXECUTE が付く。
-- 引数の型まで含めた完全形で REVOKE してから、authenticated だけに付ける (accept_child_promotion と同じ形)。
REVOKE ALL ON FUNCTION public.accept_legal_documents(text, text, inet, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_legal_documents(text, text, inet, text)
  TO authenticated;

COMMENT ON FUNCTION public.accept_legal_documents(text, text, inet, text) IS
  '#1174: 呼び出した本人 (auth.uid()) が、利用規約とプライバシーポリシーの指定の版に同意したことを記録する。user_profiles の同意済みの版 3 列を更新し (行が無ければ既定値で作る)、terms_acceptances に証跡を 1 文書ずつ足す (同じ版は重複して足さない)。端末情報 (p_ip / p_user_agent) は呼び出し側のサーバーが渡す。authenticated のみ。';
