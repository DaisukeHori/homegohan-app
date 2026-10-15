-- migration: 20261015120000_user_badge_period_awards.sql
-- 比較ランキングのバッジを、どの期間に取ったかを 1 期間 1 行で残す表 (#1528)
--
-- 背景:
--   比較ランキングのバッジ (1 位・上位 n%・平均超え・改善) は、Edge Function calculate-segment-stats の確定の回
--   (期間が切り替わった直後の回。previousPeriod: true) だけが付ける (#1491 / #1500)。付けたバッジは user_badges に入るが、
--   user_badges は (user_id, badge_id) が主キーで、upsert は ignoreDuplicates (すでに持っていれば何もしない)。
--   そのため、同じバッジを 2 回目以降の期間で取っても記録が残らず、獲得済みのバッジの一覧で「どの期間に取ったか」
--   「何回取ったか」を出せなかった (残るのは最初に取った期間の context_json だけ)。
--   #1528 で、確定したバッジ (先週・先月の 1 位など) を獲得済みのバッジの一覧で期間とともに見せることになった。
--
-- 変更 (表を 1 つ足す。既存の表・関数は変えない):
--   1. 表 public.user_badge_period_awards を足す。(利用者, バッジ, 期間の種類, 期間の開始日) ごとに 1 行。
--      Edge Function calculate-segment-stats の確定の回が、user_badges と同じ判定の結果を、期間つきでここにも書く
--      (upsert・ignoreDuplicates。確定の回の再試行で同じ期間をやり直しても 2 行にはならない)。
--      GET /api/badges がこの表を読み、獲得済みのバッジに「最新の期間」と「取った回数」を添えて返す。
--   2. 既存の user_badges のうち、context_json に期間 (period_type が daily / weekly / monthly、period_start が YYYY-MM-DD) が
--      入っている行を、この表へ写す (最初に取った期間の 1 行。すでにあれば何もしない)。
--
-- 権限:
--   - RLS を有効にする。authenticated には SELECT だけを付け、ポリシーで本人の行 (auth.uid() = user_id) だけにする。
--     書くのは service_role (Edge Function) だけ。利用者が自分で行を足す・変えることはできない (バッジの自己付与を防ぐ。
--     user_badges に自己 INSERT のポリシーを置かないのと同じ理由。#1215)。
--   - anon には何も付けない。Supabase の default privileges は CREATE TABLE の時点で anon / authenticated / service_role に
--     表の権限を自動で付けるので、ロール個別に完全形で REVOKE してから付け直す (20261011120000 と同じ形)。
--
-- 消すとき: 利用者 (auth.users) を消すと行も消える (ON DELETE CASCADE。user_badges と同じ)。バッジのマスター (badges) の行を
--   消したときも消える。
-- 個人データのエクスポート (#1131) には、src/lib/account-export-tables.ts の ACCOUNT_EXPORT_TABLES に足して含める。
--
-- 適用の順: この migration を流してから、表に書く Edge Function calculate-segment-stats をデプロイする
--   (先にデプロイすると、確定の回が「表が無い」で 500 になり、0:20・0:35 の再試行も同じく失敗する。確定の回は JST 0:05 だけ)。
--   GET /api/badges は、この表を読めなくても一覧は返す (期間を添えないだけ) ので、Web の順番は問わない。
-- 何度流しても同じ結果になる (CREATE TABLE IF NOT EXISTS / DROP POLICY IF EXISTS / INSERT ... ON CONFLICT DO NOTHING)。
-- 確かめるテスト:
--   tests/user-badge-period-awards-migration-contract.test.ts (ファイルどうしの突き合わせ。DB 無し)
--   tests/integration/rls/user-badge-period-awards.test.ts (実 DB: 本人の行だけ読める・利用者は書けない・写し)
-- ロールバック: supabase/rollbacks/20261015120000_user_badge_period_awards.down.sql

CREATE TABLE IF NOT EXISTS public.user_badge_period_awards (
  user_id      UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  badge_id     UUID        NOT NULL REFERENCES public.badges (id) ON DELETE CASCADE,
  period_type  TEXT        NOT NULL CHECK (period_type IN ('daily', 'weekly', 'monthly')),
  period_start DATE        NOT NULL,
  context_json JSONB,
  message      TEXT,
  awarded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, badge_id, period_type, period_start)
);

ALTER TABLE public.user_badge_period_awards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_badge_period_awards FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.user_badge_period_awards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_badge_period_awards TO service_role;

DROP POLICY IF EXISTS user_badge_period_awards_select_own ON public.user_badge_period_awards;
CREATE POLICY user_badge_period_awards_select_own ON public.user_badge_period_awards
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.user_badge_period_awards IS
  '#1528: 比較ランキングのバッジを取った期間 (1 期間 1 行)。Edge Function calculate-segment-stats の確定の回が user_badges と同じ判定の結果を書き、GET /api/badges が獲得済みのバッジに最新の期間と回数を添えるために読む。利用者は本人の行の SELECT だけ。書くのは service_role だけ。';
COMMENT ON COLUMN public.user_badge_period_awards.period_type IS
  '期間の種類 (daily / weekly / monthly)。segment_stats_finalized_periods.period_type と同じ値';
COMMENT ON COLUMN public.user_badge_period_awards.period_start IS
  '期間の開始日 (JST の暦日)。週は月曜日、月は 1 日';
COMMENT ON COLUMN public.user_badge_period_awards.context_json IS
  'その期間の判定の元 (segment_id / metric_id / rank / percentile / vs_avg_rate など)。user_badges.context_json と同じ形';
COMMENT ON COLUMN public.user_badge_period_awards.message IS
  '利用者に見せる文 (例: 「🏆 全体の朝食率で1位！」)。user_badges.message と同じ作り方';
COMMENT ON COLUMN public.user_badge_period_awards.awarded_at IS
  'その期間のバッジを付けた時刻 (確定の回の時刻)';

-- 既存の user_badges のうち、期間の入った行を写す (最初に取った期間の 1 行)
INSERT INTO public.user_badge_period_awards (user_id, badge_id, period_type, period_start, context_json, message, awarded_at)
SELECT
  ub.user_id,
  ub.badge_id,
  ub.context_json ->> 'period_type',
  (ub.context_json ->> 'period_start')::date,
  ub.context_json,
  ub.message,
  COALESCE(ub.obtained_at, now())
FROM public.user_badges AS ub
WHERE ub.context_json ->> 'period_type' IN ('daily', 'weekly', 'monthly')
  AND ub.context_json ->> 'period_start' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
ON CONFLICT (user_id, badge_id, period_type, period_start) DO NOTHING;
