-- migration: 20261008120100_csat_nps_summary_rpc.sql
-- #1217: NPS / CSAT 集計 API (GET /api/admin/finance/nps) の「数える処理」を DB の関数にする (関数 2 本の追加)
--
-- 背景:
--   GET /api/admin/finance/nps (src/app/api/admin/finance/nps/route.ts) は、nps_surveys と csat_feedbacks の
--   該当する行を全部読み込み、件数・平均・分布を JavaScript で数えていた (行数の上限が無い)。
--     - 行が増えるほど、DB からアプリへ送る量と処理時間が行数に比例して増える。
--     - Supabase の API は 1 回の応答で返す行数に上限があり (既定は 1000 行)、それを超えると
--       集計が黙って切り詰められる (1000 行ぶんしか数えない)。ローカルで 1,100 行を入れて確認した:
--       条件なしの select は 1000 行で打ち切られ、エラーも出ない。一方、送信数は件数だけを数える
--       リクエスト (head) で取っていて 1100 と正しく返るため、回答率 (回答数 ÷ 送信数) も食い違う。
--   索引 (idx_csat_feedbacks_created_at / idx_csat_feedbacks_user_id) は 20261007160300 で足し済み。
--   残っていたのは「全行を取って JS で数える」API の側なので、数える処理を DB の関数にする。
--   (CSAT / NPS を書き込むコードはまだ無く、表はほぼ空。行が増える前に直しておく。)
--
-- 変更 (関数の追加だけ。表・ポリシー・既存の行には一切触れない):
--   1. get_csat_summary(p_from timestamptz, p_to timestamptz)
--        csat_feedbacks を created_at の期間 (両端を含む。NULL はその側を絞らない) で絞り、
--        回答数・スコアの合計・星 1〜5 それぞれの件数を 1 行で返す。
--   2. get_nps_summary(p_from timestamptz, p_to timestamptz, p_plan_key text)
--        nps_surveys を sent_at の期間 (両端を含む。NULL はその側を絞らない) と plan_key (NULL は全プラン) で絞り、
--        送信数 (未回答を含む)・回答数 (responded_at あり)・推奨者 (9-10)・中立 (7-8)・批判者 (0-6)・
--        回答のスコア合計を 1 行で返す。回答数以下の 5 列は responded_at が入っている行だけを数える
--        (nps_surveys.score は NOT NULL なので、未回答の行にも何かのスコアが入っている。数えると結果が狂う)。
--   どちらも条件に合う行が 0 件でも、全部 0 の 1 行を返す (0 行にならない)。
--   平均・NPS スコア・回答率の割り算と小数第 1 位への丸めは、API 側 (src/lib/admin/nps-summary.ts) が
--   以前と同じ式で行う。関数は割り算も丸めもせず、数えた整数だけを返す (画面に出る数字は変わらない)。
--
-- 設計上の判断:
--   - SECURITY INVOKER (呼び出したユーザーの権限で動く)。表の行レベルセキュリティ (RLS) がそのまま効くので、
--     誰が何を見られるかは今の API (RLS 越しの SELECT) と変わらない。関数が RLS を飛び越えることはない。
--       csat_feedbacks: csat_access      本人の行 + support / admin / super_admin は全件
--       nps_surveys   : nps_select_admin admin / super_admin / support だけ (一般ユーザーは自分の行も読めない)
--     API ルートは finance ロールも通すが、RLS は finance を許していないため、finance だけの人には今も 0 件に見える。
--     これを変えるかどうか (RLS に finance を足すか、管理者用クライアントで読むか) は別の判断 (#1311) で、ここでは変えない。
--   - STABLE (表を読むだけで書き込まない)。SET search_path = ''、関数内の参照はすべて完全修飾。
--   - 期間は `created_at >= coalesce(p_from, '-infinity') AND created_at <= coalesce(p_to, 'infinity')` と書く。
--     SQL 関数の中の問い合わせは、引数の値を知らないまま計画が作られる (汎用プラン)。その計画で
--     `p_from IS NULL OR created_at >= p_from` と書くと、索引を範囲の条件に使えず表全体を読む。
--     「無制限」を無限大の日時で表せば、期間を指定してもしなくても同じ形の単純な範囲条件になり、
--     索引 (csat_feedbacks は idx_csat_feedbacks_created_at、nps_surveys は idx_nps_surveys_recent) を使える。
--     ローカルで 20 万行を入れて、実際の関数を呼んで確認した: 1 週間分 (約 2,500 行) の集計は、この書き方なら
--     索引を使って約 1.5 ms、OR の書き方だと表全体を読んで約 24 ms。期間なしの全件 (20 万行) の集計は約 35〜50 ms。
--   - 実行権限は authenticated だけ。API ルートはログインセッション (Cookie の JWT = authenticated) で呼ぶため。
--       PUBLIC / anon / service_role からは REVOKE (anon が呼ぶと 42501 permission denied)。
--       新しい関数は Supabase の既定権限で anon / authenticated / service_role に EXECUTE が自動付与されるため、
--       引数の型まで含めた完全形で、ロール個別に REVOKE する (20261007160000 / 20261007150300 と同じ理屈)。
--     ログインした一般ユーザーが直接呼んでも、RLS が許す行の集計しか返らない (CSAT は自分の分だけ、NPS は 0 件)。
--     将来 service_role で呼ぶ作りにするときは、そのときの migration で GRANT を足す。
--
-- 本番への影響: 既存の行・ポリシー・権限は変わらない。関数を 2 本足すだけで、表への書き込みを待たせるロックは取らない
--   (関数の本体を検査するときに、表の読み取り用の軽いロックを一瞬取るだけ)。
--   既存のデータを書き換える文 (UPDATE / DELETE) は無い。
--   足した関数は、この PR の API コードが切り替わるまで誰も呼ばない。
--   migration より先に API コードが切り替わった場合は、関数がまだ無いため、管理画面の NPS / CSAT のページだけが
--   エラーになる (migration が入れば直る。ほかの画面には影響しない)。
--
-- 冪等: CREATE OR REPLACE FUNCTION (新しい名前なので既存の関数は置き換えない)。REVOKE / GRANT / COMMENT は何度流しても同じ結果になる。
-- 適用順: API のコードと同じ PR。migration は version 順にマージする。
-- 確認: tests/integration/rls/csat-nps-summary-rpc.test.ts / tests/integration/security/admin-finance-nps-route.test.ts
-- ロールバック: supabase/rollbacks/20261008120100_csat_nps_summary_rpc.down.sql

-- ─────────────────────────────────────────────────────────
-- CSAT (csat_feedbacks。スコア 1〜5) の集計
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_csat_summary(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE (
  total_responses bigint,
  score_sum       bigint,
  score_1_count   bigint,
  score_2_count   bigint,
  score_3_count   bigint,
  score_4_count   bigint,
  score_5_count   bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT count(*),
         coalesce(sum(f.score), 0),
         count(*) FILTER (WHERE f.score = 1),
         count(*) FILTER (WHERE f.score = 2),
         count(*) FILTER (WHERE f.score = 3),
         count(*) FILTER (WHERE f.score = 4),
         count(*) FILTER (WHERE f.score = 5)
    FROM public.csat_feedbacks AS f
   WHERE f.created_at >= coalesce(p_from, '-infinity'::timestamptz)
     AND f.created_at <= coalesce(p_to, 'infinity'::timestamptz)
$$;

-- ─────────────────────────────────────────────────────────
-- NPS (nps_surveys。スコア 0〜10) の集計
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_nps_summary(
  p_from     timestamptz DEFAULT NULL,
  p_to       timestamptz DEFAULT NULL,
  p_plan_key text        DEFAULT NULL
)
RETURNS TABLE (
  sent_count      bigint,
  total_responses bigint,
  promoters       bigint,
  passives        bigint,
  detractors      bigint,
  score_sum       bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT count(*),
         count(*) FILTER (WHERE s.responded_at IS NOT NULL),
         count(*) FILTER (WHERE s.responded_at IS NOT NULL AND s.score >= 9),
         count(*) FILTER (WHERE s.responded_at IS NOT NULL AND s.score BETWEEN 7 AND 8),
         count(*) FILTER (WHERE s.responded_at IS NOT NULL AND s.score <= 6),
         coalesce(sum(s.score) FILTER (WHERE s.responded_at IS NOT NULL), 0)
    FROM public.nps_surveys AS s
   WHERE s.sent_at >= coalesce(p_from, '-infinity'::timestamptz)
     AND s.sent_at <= coalesce(p_to, 'infinity'::timestamptz)
     AND (p_plan_key IS NULL OR s.plan_key = p_plan_key)
$$;

-- 関数の権限: authenticated だけ。
REVOKE ALL ON FUNCTION public.get_csat_summary(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_csat_summary(timestamptz, timestamptz)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_nps_summary(timestamptz, timestamptz, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_nps_summary(timestamptz, timestamptz, text)
  TO authenticated;

COMMENT ON FUNCTION public.get_csat_summary(timestamptz, timestamptz) IS
  '#1217: CSAT (csat_feedbacks) の集計。created_at の期間 (両端を含む。NULL は無制限) の回答数・スコア合計・星 1〜5 の件数を 1 行で返す。SECURITY INVOKER (RLS は呼び出しユーザーで効く)。authenticated のみ。';
COMMENT ON FUNCTION public.get_nps_summary(timestamptz, timestamptz, text) IS
  '#1217: NPS (nps_surveys) の集計。sent_at の期間 (両端を含む。NULL は無制限) と plan_key (NULL は全プラン) の送信数・回答数・推奨者 (9-10)・中立 (7-8)・批判者 (0-6)・回答のスコア合計を 1 行で返す。回答数以下は responded_at ありの行だけ。SECURITY INVOKER (RLS は呼び出しユーザーで効く)。authenticated のみ。';
