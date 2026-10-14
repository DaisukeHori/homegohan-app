-- migration: 20261010090000_ai_consent_policy_version.sql
-- T15 (#1154 / #1133 / #1169): 外国の AI 事業者へのデータ提供について、同意の記録・確認・撤回の土台を作る
--   (未同意の利用者のデータを AI へ送らない判定は、アプリ (Next.js / Edge Functions) が送る手前で、このテーブルを読んで行う)
--
-- 背景:
--   設計書 (docs/design/cross/08-legal-compliance.md §4.3) は、外国の AI 事業者への提供の同意を記録するテーブルとして
--   external_data_consents を定めていて、本番にも作ってあった。しかしアプリはこのテーブルを一度も読み書きしておらず、
--   同意を取る画面も無いまま、xAI / Google / OpenAI へ食事の写真・健康診断の数値・相談文などが送られている (#1154)。
--   この PR で、同意画面・同意の記録・撤回と、未同意なら AI へ送らない判定を作る。テーブルの現状 (2026-10-07 の本番スナップショット) は次のとおり。
--     列: id / user_id / provider / consented / consented_at / ip_address / user_agent / revoked_at (同意した文面の版を持つ列が無い)
--     provider の CHECK: xai / anthropic / google / openai
--     有効な行は (user_id, provider) ごとに 1 件: 部分ユニーク索引 idx_ext_consents_active (WHERE revoked_at IS NULL)
--     RLS: ext_consent_self_read (SELECT: 自分の行) / ext_consent_self_insert (INSERT: user_id = 自分) / ext_consent_no_delete (DELETE: 常に拒否)
--     権限: anon / authenticated / service_role に全権限 (GRANT ALL)
--
-- 変更:
--   1. policy_version (text) を足す。同意したときの文面の版 (supabase/functions/_shared/ai-consent.ts の AI_CONSENT_VERSION)。
--      文面を改めたときに版を上げると、古い版に同意した人にだけもう一度確認できる。
--      既存の行 (あれば) は NULL のまま。アプリは「版が分からない = 古い版」として扱い、未同意として AI へ送らない (もう一度同意を取る)。
--   2. クライアント (anon / authenticated) からの書き込みを閉じる。
--      - INSERT ポリシー ext_consent_self_insert を DROP する。
--      - 権限を絞る: anon は全権限を外し、authenticated は SELECT だけにする (service_role は変えない)。
--      同意・撤回は、サーバーの API (POST /api/ai/consent, POST /api/ai/consent/revoke) が service role で書く。
--      理由: 同意の記録は「いつ・どの版の文面に・どの IP アドレス / 端末から同意したか」が証拠になる。
--      クライアントが自由に INSERT できると、日時・IP・User-Agent・版を利用者側が好きな値で書けてしまう。
--      IP アドレスと User-Agent はクライアントの申告ではなく、サーバーがリクエストから取る (x-forwarded-for の先頭の値)。
--      UPDATE のポリシーは元から無い (撤回はサーバーが revoked_at を入れる)。DELETE は ext_consent_no_delete が拒否する (監査のため行は残す)。
--      結果として、クライアントからは「自分の行の SELECT」だけができる (tests/integration/rls/external-data-consents.test.ts)。
--   3. 索引 idx_ext_consents_user_consented_at (user_id, consented_at DESC) を足す。
--      - 既存の部分ユニーク索引は有効な行 (revoked_at IS NULL) しか引けない。同意の状況の確認 (撤回済みの行を含めて直近を読む) と、
--        user_id の外部キー (アカウント削除時の ON DELETE CASCADE の探索) に使う。
--      - 画面を開くたびに状況を読むため、行が増えても全件走査にならないようにする。
--   4. provider の CHECK に perplexity / aimlapi を足す (xai / anthropic / google / openai はそのまま)。
--      実際に利用者のデータを送っている事業者を、コードの送信先から数え直した結果 (supabase/functions/_shared/ai-consent.ts の
--      AI_CONSENT_PROVIDERS)。Perplexity (api.perplexity.ai) は食事の写真の解析の栄養推定、AI/ML API (api.aimlapi.com) は
--      AI 相談・献立の作成で文章を検索用に数値化するのに使っている。同意は事業者ごとに 1 行で記録するので、CHECK に無いと記録できない。
--      既存の行はすべて元の 4 つのどれかなので、制約の付け直しで失敗する行は無い。
--
-- 既存の正当な利用経路への影響: なし。
--   - アプリ (Web・モバイル・Edge Function・scripts) は、この PR まで external_data_consents を読み書きしていない。
--     この PR から、AI へ送る経路が送る手前で有効な行を読む (本人のセッションか service role。読む列は provider / consented / policy_version)。
--   - 個人データのエクスポート (src/lib/account-export-tables.ts) は、本人のクライアントで SELECT * する。SELECT 権限と self_read は残る。
--     policy_version も自動で出力される。
--   - アカウント削除は auth.users の ON DELETE CASCADE で行が消える。権限の影響を受けない。
--
-- データの書き換え (UPDATE / DELETE): なし。列の追加・ポリシーの削除・権限の変更・索引の追加・CHECK の付け直しだけ。
--
-- 冪等: ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE INDEX IF NOT EXISTS / DROP CONSTRAINT IF EXISTS。
--   REVOKE / GRANT は何度流しても同じ結果になる。
-- ロールバック: supabase/rollbacks/20261010090000_ai_consent_policy_version.down.sql
--   (Web のデプロイを戻したあとに流すこと。列を落とすと、記録済みの「同意した文面の版」が失われる)
-- 確認: tests/integration/rls/external-data-consents.test.ts (16 件)。この migration の後は全件成功する
--   (X-12 は perplexity / aimlapi の行を入れるので、CHECK を付け直す前は失敗する)。

-- 1. 同意した文面の版
ALTER TABLE public.external_data_consents
  ADD COLUMN IF NOT EXISTS policy_version text;

COMMENT ON COLUMN public.external_data_consents.policy_version IS
  '同意したときの文面の版 (supabase/functions/_shared/ai-consent.ts の AI_CONSENT_VERSION)。NULL は版を記録する前の行。サーバー (service role) だけが書く';

-- 2. クライアントからの書き込みを閉じる (同意・撤回はサーバー (service role) の API だけが書く)
DROP POLICY IF EXISTS "ext_consent_self_insert" ON public.external_data_consents;

REVOKE ALL ON TABLE public.external_data_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.external_data_consents TO authenticated;

-- 3. 同意の状況の確認 (撤回済みの行を含む) と user_id の外部キーのための索引
CREATE INDEX IF NOT EXISTS idx_ext_consents_user_consented_at
  ON public.external_data_consents (user_id, consented_at DESC);

-- 4. 同意を取る事業者に perplexity / aimlapi を足す (実際に送っている事業者に合わせる)
ALTER TABLE public.external_data_consents
  DROP CONSTRAINT IF EXISTS external_data_consents_provider_check;
ALTER TABLE public.external_data_consents
  ADD CONSTRAINT external_data_consents_provider_check
  CHECK ((provider)::text = ANY (ARRAY['xai', 'anthropic', 'google', 'openai', 'perplexity', 'aimlapi']::text[]));
