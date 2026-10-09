-- rollback: 20261010090000_ai_consent_policy_version.sql
-- ⚠️ 戻すと次のことが起きる。緊急時の切り戻し専用。先に Web のデプロイ (同意画面・同意の API) を戻してから流すこと。
--    - policy_version の列が消え、記録済みの「同意した文面の版」が失われる。
--    - provider の CHECK が元の 4 つ (xai / anthropic / google / openai) に戻る。perplexity / aimlapi の行は消さない (監査のため)。
--      その行が残っていても戻せるよう、元の CHECK は NOT VALID で付ける (以後の INSERT / UPDATE だけを検査する)。
--    - anon / authenticated がこのテーブルへ書き込めるようになる (INSERT は ext_consent_self_insert で自分の行だけ)。
--      同意の記録 (日時・IP アドレス・User-Agent・版) を利用者側が好きな値で書けるため、証拠としての価値が下がる。
--
-- 内容: 2026-10-07 時点の本番の定義 (supabase/baseline/prod_schema.sql, prod_table_acl.sql) へ戻す。
--   ポリシー ext_consent_self_insert: FOR INSERT WITH CHECK (auth.uid() = user_id)
--   権限: anon / authenticated / service_role に全権限 (GRANT ALL)
--   provider の CHECK: xai / anthropic / google / openai
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

ALTER TABLE public.external_data_consents
  DROP CONSTRAINT IF EXISTS external_data_consents_provider_check;
ALTER TABLE public.external_data_consents
  ADD CONSTRAINT external_data_consents_provider_check
  CHECK ((provider)::text = ANY (ARRAY['xai', 'anthropic', 'google', 'openai']::text[])) NOT VALID;

DROP INDEX IF EXISTS public.idx_ext_consents_user_consented_at;

REVOKE ALL ON TABLE public.external_data_consents FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.external_data_consents TO anon, authenticated;

DROP POLICY IF EXISTS "ext_consent_self_insert" ON public.external_data_consents;
CREATE POLICY "ext_consent_self_insert" ON public.external_data_consents
  FOR INSERT
  WITH CHECK ((auth.uid() = user_id));

ALTER TABLE public.external_data_consents
  DROP COLUMN IF EXISTS policy_version;
