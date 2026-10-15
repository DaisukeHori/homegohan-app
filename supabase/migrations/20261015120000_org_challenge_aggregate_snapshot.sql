-- migration: 20261015120000_org_challenge_aggregate_snapshot.sql
-- #1600: 組織チャレンジの集計 (管理者に見せる参加者数と平均) と順位表を強める。#1132 (20261014100100_org_challenge_progress.sql) の残り
--
-- 背景:
--   1. 集計の最小人数が 5 人だった。要件書 (docs/requirements/02-organization-management.md §6.4) は、匿名化集計の最低人数を 10 名以上とする。
--   2. 集計の差分: get_org_challenge_aggregates は、参加者の行をその場で数えていた。参加をやめる (DELETE) と行はすぐ消えるが、
--      ほかの人の値 (current_value) は夜の更新まで変わらないので、やめる前後の平均を比べると、やめた人の値を逆算できた
--      (やめた人の値 = 前の人数 × 前の平均 − 後の人数 × 後の平均)。管理者がメンバーを組織から外したとき
--      (user_profiles.organization_id が変わる) も同じで、外す前後の平均から、外した人の値が分かった。
--      終了したチャレンジは値がもう変わらないので、差がそのまま 1 人の値になった。最小人数の規則は、1 回の集計しか守らない。
--      参加者に見せる順位表 (get_org_challenge_ranking) も参加者の行をその場で読むので、管理者がメンバーとして参加して順位表を見ると、
--      あるメンバーを組織から外す (またはやめさせる) 前後で消えた 1 行が、その人の値になった。
--   3. 参加の INSERT ポリシー (#1238 の「Users can join challenges」) は、本人・自分の組織のチャレンジ・進捗 0・順位なししか見なかった。
--      部署の限定・状態・種類・終了日は API (POST /api/org/challenges/[id]/join) だけが見ていたので、利用者の JWT で PostgREST に
--      直接 INSERT すると、別の部署向け・下書き・終わったチャレンジにも参加行を作れ、夜の集計の順位と人数に混ざった。
--
-- 変更:
--   1. 表 organization_challenge_aggregates (チャレンジごとの集計の控え。1 チャレンジ 1 行) を作る。
--        participant_count (今も組織のメンバーである参加者の人数)・ranked_count (そのうち順位がついた人数)・
--        average_value (順位がついた人の平均。丸める前)・counted_through (控えを書いたときの、集計に含める最後の日 (JST) = min(終了日, 前日))・
--        updated_at (控えを書いた集計の時刻 = p_now)。
--        読み書きは service_role だけ (RLS を有効にしてポリシーは作らない。anon / authenticated の権限は外す)。
--        最小人数に満たない人数・平均もそのまま入れる (隠すのは読み出す関数 get_org_challenge_aggregates)。
--   2. 表 organization_challenge_ranking_entries (順位表の控え。順位がついた参加者 1 人 1 行) を作る。
--        challenge_id・user_id・rank・current_value・joined_at (同じ順位の並べ方に使う)。権限は 1 と同じ (service_role だけ)。
--        アカウントを消した人の行は、その場で消える (auth.users を ON DELETE CASCADE で参照する)。
--   3. refresh_org_challenge_aggregates(p_now timestamptz DEFAULT now(), p_recomputed_ids uuid[] DEFAULT '{}', p_count_only_ids uuid[] DEFAULT '{}')
--        SECURITY DEFINER / service_role だけが実行できる。
--        参加者の行から、集計 (1) と順位表 (2) の控えを数え直す。どのチャレンジを書くかは自分では決めず、呼び出し元
--        (update_org_challenge_progress) が渡した 2 つの id の集合に従う:
--          * p_recomputed_ids (今夜、値と順位を計算し直したチャレンジ): 人数・順位がついた人数・平均・順位表を書く
--          * p_count_only_ids (今夜は値を計算しない開催中のチャレンジ = 開始前・食事の記録から計算できない種類): 人数だけを書く
--            (順位がついた人数は 0・平均は NULL・順位表は空。古い値を控えに入れない)
--        どちらも、開催中で、控えが無いか、集計に含める最後の日 (min(終了日, 前日)) が控えを書いたときより進んだものだけ書く
--        (渡されても、最後の日が進んでいなければ書かない)。
--        ほかに、終了・中止 (completed / cancelled) で控えがまだ無いものは、最初の 1 回だけ参加者の行のまま書く。
--        どちらの集合にも入っていない開催中のチャレンジは書かない (単独で呼んでも、値を計算し直さずに最後の日だけ進めることはない)。
--        下書きは控えを作らない。書いたチャレンジの数を返す。
--   4. update_org_challenge_progress(p_now) が、今夜、値を計算し直すチャレンジと人数だけを控えに書くチャレンジを 1 か所で選び、
--        値を計算し直すのはその集合だけにする (開催中で、控えが無いか最後の日が進んだもの。進まない夜は参加者の行の値も順位も書かない)。
--        進み具合と順位を書いたあと、終了にする前に refresh_org_challenge_aggregates(p_now, その 2 つの集合) を呼ぶ。
--        そのほかの定義は 20261014100100 のものと同じ (返す jsonb に aggregates (控えを書いたチャレンジの数) を足した)。
--        終了日を過ぎたチャレンジは、終了にする前に最後の集計が控えに入る。
--   5. get_org_challenge_aggregates(p_organization_id) を、控え (1) から読むように変える。最小人数を 10 人にする。
--        返す列・型・SECURITY INVOKER・STABLE・search_path は変えない。控えの無いチャレンジ (下書き・作ったばかり) は
--        人数も平均も NULL (最小人数に満たないときと同じ。「0 人」とは偽らない)。
--          参加者数 = 控えの参加者が 10 人に満たなければ NULL
--          平均     = 控えの、順位がついた参加者が 10 人に満たなければ NULL
--   6. get_org_challenge_ranking(p_challenge_id, p_user_id, p_limit, p_with_names) を、控え (2) から並べるように変える。
--        引数・返す列・型・SECURITY INVOKER・STABLE・search_path・人数の決め方 (cfg)・見られる人 (いま、そのチャレンジの参加者で
--        組織のメンバーである本人だけ) は変えない。参加をやめた人・組織から外れた人の行は、次の夜の更新まで順位表に残る。
--   7. 参加の INSERT ポリシー「Users can join challenges」に、API と同じ条件を足す:
--        チャレンジが開催中 (status = 'active')・食事の記録から計算できる種類 (breakfast_rate / veg_score / cooking_rate)・
--        終了日 (JST) を過ぎていない・部署を限定したチャレンジは、その部署のメンバーだけ。
--        元の条件 (本人・自分の組織のチャレンジ・進捗 0・順位なし) はそのまま。
--
-- 差分の攻撃をどう防ぐか (設計上の判断):
--   - 集計と順位表を「毎晩の更新の時点の控え」から返す。参加・参加のやめ・組織からの脱退や除名は、次の夜の更新でまとめて入り、
--     その更新では全員の値 (current_value) も、集計に含める日を 1 日足して計算し直される。
--     やめた (外れた) 人だけが動いた前後の平均・順位表を、管理者 (メンバーとして参加した管理者を含む) が並べて見る機会を作らない。
--     やめた人の行を夜まで残す (参加行の削除を遅らせる) 形は採らない: 管理者がメンバーを組織から外す経路
--     (user_profiles.organization_id の変更) を守れないため。
--   - 「値を計算し直すチャレンジ」と「控えに値を書くチャレンジ」を同じ集合にする。決めるのは update_org_challenge_progress の 1 か所だけで、
--     refresh_org_challenge_aggregates はその集合を受け取って書く (自分では選ばない)。2 つを別々の条件で選ぶと、値を計算し直さない夜にも
--     控えが書き直され、ほかの人の古い値のまま人の出入りだけが控えに入る (開始日を先へ動かす・種類を変える・数え直しだけを単独で呼ぶ、などの場面)。
--   - 選ぶのは「開催中で、控えが無いか、集計に含める最後の日が進んだ (counted_through より後になった)」チャレンジだけ。
--     進まない夜は、控えも、参加者の行の値と順位 (本人に見える自分の順位) も書かない。ほかの人の値が同じまま、
--     人の出入りだけが控えや順位に入るのを防ぐため。これで次の場面でも、控えも参加者の行も動かない:
--       * 終了したチャレンジを管理者が開催中に戻す (API の PUT でも、ポリシー "Org admins can manage challenges" で PostgREST を
--         直接叩いても): 最後の日は終了日のままで進まないので、計算も書き直しもしない (終了したチャレンジは値が変わらず、
--         書き直すと差がそのまま 1 人の値になる。順位が詰まると、自分より上の人が外れたことが分かる)
--       * 終了日を前の夜の最後の日 (以前) に縮める: 同じく進まない
--       * 同じ日に毎晩の更新や数え直しをもう一度流す: 同じく進まない
--       * 数え直し (refresh_org_challenge_aggregates) だけを単独で呼ぶ: 集合を渡さなければ、開催中のチャレンジは何も書かない
--   - 最後の日が進んでも値を計算しない開催中のチャレンジ (開始前・食事の記録から計算できない種類。管理者が開始日を先へ動かした・
--     種類を変えた場合を含む) は、人数だけを控えに書き、順位がついた人数 0・平均なし・順位表は空にする。
--     参加者の行に残った古い値・順位を、人の出入りのあとの人数と組み合わせて控えに入れないため。
--     開始日や種類を戻したあとの夜は、全員の値を計算し直してから控えに入る (前に値を書いた夜から 2 日以上進んだ値になる)。
--   - 参加者数も控えから返す。人数がその場で動くと、管理者があるメンバーを外した前後の人数の差から、その人が参加していたかが分かる。
--   - 残る限界:
--       * 値を計算し直す夜の前後で、ほかの人の値がほとんど動かない (その間の記録が少ない) ときは、前に値を書いた夜と次に値を書いた夜の
--         平均・順位表・自分の順位の差から、やめた人の値をおおよそ推し量れる (値を書かない夜を挟んでも、次に値を書く夜に
--         2 日以上分の記録が入るだけで、この限界は変わらない)。値に雑音を足す (差分プライバシー) ことはしない。
--       * 順位表は、参加者 (メンバーとして参加した管理者を含む) に、上位 20 人と本人の値を名前なしで見せる表で、人数の下限も無い (#1132 の方針)。
--         参加者が少なければ、参加者どうしで、ほかの人の値が見える。
--       * アカウントを消した人の順位表の行は、その場で消える (消した人の記録を夜まで残さない)。
--
-- 権限:
--   新しい関数は Supabase の既定権限で anon / authenticated / service_role に EXECUTE が自動付与されるため、
--   引数の型まで含めた完全形で、ロール個別に REVOKE してから service_role にだけ GRANT する (20261014100100 と同じ形)。
--   CREATE OR REPLACE は既存の権限を保つが、何度流しても同じになるよう、置き換える 3 本の権限も流し直す。
--   pg_cron は postgres ロールで update_org_challenge_progress() を呼び、その中から refresh_org_challenge_aggregates を呼ぶ
--   (SECURITY DEFINER の持ち主 postgres として動くので、GRANT は要らない)。
--
-- 本番のデータへの影響:
--   - 表を 2 つ足し、refresh_org_challenge_aggregates(now(), 開催中のチャレンジ全部, 空) で控えを最初に作る
--     (開催中・終了・中止のチャレンジ。下書きは作らない)。
--     値は、いまの参加者の行から数えたもの (この migration を流す前に管理者・参加者に見えていた値と同じ)。
--     既存の表の行は 1 件も書き換えない。
--   - 最小人数が 10 人になるので、参加者が 5〜9 人のチャレンジは、管理者の画面で人数も平均も出なくなる (「10人未満」)。
--   - 流したあとは、参加・参加のやめ・メンバーの脱退が、管理者に見える人数と平均・参加者に見える順位表に、
--     次の夜の更新 (03:10 JST) まで反映されない。
--     この migration を JST 0:00〜03:10 に流したときは、その日の 03:10 の更新でも最後の日が進まないので、控えも、
--     参加者の進み具合と順位も、その日は計算し直さず、翌日の 03:10 の更新で 2 日分まとめて進む。
--   - 新しい INSERT ポリシーは、既存の参加行には効かない (作るときだけ)。いまある「別の部署向け・下書き・終わったチャレンジ」の
--     参加行は消さない。
--   - 表への書き込みを待たせるロックは、ポリシーの付け替え (ACCESS EXCLUSIVE。一瞬) だけ。10 秒でロック待ちを諦める。
--
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS → CREATE POLICY /
--       控えの最初の作成は refresh (同じ日にもう一度流しても、最後の日が進まないので書かない)。何度流しても同じ結果になる。
-- 適用順: API・画面のコードと同じ PR。20261014100100_org_challenge_progress.sql の後。
-- 確認: tests/integration/rls/org-challenge-progress.test.ts / tests/integration/security/org-challenges-api.test.ts /
--       tests/integration/rls/challenge-participants-org-scope.test.ts / tests/org-challenge-aggregate-snapshot-migration-contract.test.ts
-- ロールバック: supabase/rollbacks/20261015120000_org_challenge_aggregate_snapshot.down.sql
--   (戻すと、集計と順位表がその場の数え方・最小人数 5 人に戻り、INSERT ポリシーも #1238 の形に戻る。差分の攻撃と直接の INSERT がまた通る)

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- 1. 集計の控え (service_role だけ)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_challenge_aggregates (
  challenge_id      uuid PRIMARY KEY REFERENCES public.organization_challenges(id) ON DELETE CASCADE,
  participant_count integer NOT NULL CHECK (participant_count >= 0),
  ranked_count      integer NOT NULL CHECK (ranked_count >= 0 AND ranked_count <= participant_count),
  average_value     numeric,
  counted_through   date NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.organization_challenge_aggregates ENABLE ROW LEVEL SECURITY;
-- ポリシーは作らない (service_role は RLS を通り抜ける。それ以外のロールは 1 行も読めない)。権限も外す
REVOKE ALL ON TABLE public.organization_challenge_aggregates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organization_challenge_aggregates TO service_role;

COMMENT ON TABLE public.organization_challenge_aggregates IS
  '#1600: 組織チャレンジの集計の控え (1 チャレンジ 1 行)。毎晩の update_org_challenge_progress が refresh_org_challenge_aggregates で書き、get_org_challenge_aggregates が最小人数で隠して読む。集計に含める最後の日が進み、その夜に全員の値を計算し直したときだけ値まで書き直し (値を計算しない開始前・対象外の種類は人数だけ)、参加・やめる・脱退の直後や、ほかの人の値が動かないとき (終了したチャレンジを開催中に戻したとき) に集計が動かないようにする。service_role のみ。';
COMMENT ON COLUMN public.organization_challenge_aggregates.participant_count IS
  '今も組織のメンバーである参加者の人数 (最小人数に満たなくてもそのまま入れる。隠すのは get_org_challenge_aggregates)';
COMMENT ON COLUMN public.organization_challenge_aggregates.ranked_count IS
  'participant_count のうち、順位がついた (集計が済んだ) 人数';
COMMENT ON COLUMN public.organization_challenge_aggregates.average_value IS
  '順位がついた参加者の current_value の平均 (丸める前)。順位がついた人がいなければ NULL';
COMMENT ON COLUMN public.organization_challenge_aggregates.counted_through IS
  '控えを書いたときの、集計に含める最後の日 (JST の暦日 = min(終了日, p_now の前日))。refresh_org_challenge_aggregates は、これより後の日まで集計に含められるようになったときだけ書き直す (値まで書くのは、update_org_challenge_progress がその夜に値を計算し直したチャレンジだけ)';
COMMENT ON COLUMN public.organization_challenge_aggregates.updated_at IS
  '控えを書いた集計の時刻 (refresh_org_challenge_aggregates の p_now)';

-- ─────────────────────────────────────────────────────────
-- 2. 順位表の控え (service_role だけ)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_challenge_ranking_entries (
  challenge_id  uuid NOT NULL REFERENCES public.organization_challenges(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rank          integer NOT NULL,
  current_value numeric,
  joined_at     timestamptz,
  PRIMARY KEY (challenge_id, user_id)
);

ALTER TABLE public.organization_challenge_ranking_entries ENABLE ROW LEVEL SECURITY;
-- ポリシーは作らない (1 と同じ)
REVOKE ALL ON TABLE public.organization_challenge_ranking_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organization_challenge_ranking_entries TO service_role;

COMMENT ON TABLE public.organization_challenge_ranking_entries IS
  '#1600: 組織チャレンジの順位表の控え (順位がついた参加者 1 人 1 行。今も組織のメンバーである人だけ)。organization_challenge_aggregates と同じとき (refresh_org_challenge_aggregates) に置き換え、get_org_challenge_ranking が読む。参加をやめた人・組織から外れた人の行は、次の夜の更新まで残る (前後の順位表の差から 1 人の値を読ませないため)。アカウントを消した人の行はその場で消える。service_role のみ。';
COMMENT ON COLUMN public.organization_challenge_ranking_entries.joined_at IS
  '参加した時刻 (organization_challenge_participants.joined_at の写し)。同じ順位の人の並べ方に使う';

-- ─────────────────────────────────────────────────────────
-- 3. 控えを数え直す (毎晩の更新から、値を計算し直した集合を渡して呼ぶ。試験・手動では集合を渡して呼ぶ)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_org_challenge_aggregates(
  p_now            timestamptz DEFAULT now(),
  p_recomputed_ids uuid[]      DEFAULT '{}'::uuid[],  -- 今夜、値と順位を計算し直したチャレンジ (値まで控えに書く)
  p_count_only_ids uuid[]      DEFAULT '{}'::uuid[]   -- 今夜は値を計算しない開催中のチャレンジ (人数だけ控えに書く)
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today      date;
  v_last_day   date;
  v_full       uuid[];
  v_count_only uuid[];
  v_written    integer := 0;
BEGIN
  -- 今日 (JST の暦日)。集計に含める最後の日は前日 (update_org_challenge_progress と同じ決め方)
  v_today    := (COALESCE(p_now, now()) AT TIME ZONE 'Asia/Tokyo')::date;
  v_last_day := v_today - 1;

  -- update_org_challenge_progress と同じ鍵で直列にする (中から呼ばれたときは、同じトランザクションが持っている鍵をもう一度取るだけ)
  PERFORM pg_advisory_xact_lock(hashtextextended('public.update_org_challenge_progress', 0));

  -- 書くチャレンジ (どれを書くかは呼び出し元が渡した集合に従い、ここでは「書いてよいか」だけを確かめる):
  --   開催中のチャレンジは、控えが無いか、集計に含める最後の日 (min(終了日, 前日)) が控えを書いたときより進んだものだけ。
  --     最後の日が進まない (終了したチャレンジを開催中に戻した・終了日を縮めた・同じ日にもう一度流した) ときは、渡されても書かない
  --     v_count_only: p_count_only_ids に入っているもの。人数だけ (両方に入っていたら、値を書かないこちらにする)
  --     v_full:       p_recomputed_ids に入っているもの。人数・順位がついた人数・平均・順位表
  --     どちらにも入っていないものは書かない (値を計算し直していないのに最後の日だけ進めると、次の計算の機会を飛ばし、
  --     ほかの人の古い値のまま人の出入りだけが控えに入る)
  --   終了・中止で、控えがまだ無いもの: 最初の 1 回だけ、参加者の行のまま (v_full。以後は開催中に戻されない限り書き直さない)
  --   下書きは控えを作らない
  WITH picked AS (
    SELECT c.id,
           CASE
             WHEN c.status = 'active' AND c.id = ANY (COALESCE(p_count_only_ids, '{}'::uuid[])) THEN 'count_only'
             WHEN c.status = 'active' AND c.id = ANY (COALESCE(p_recomputed_ids, '{}'::uuid[])) THEN 'full'
             WHEN c.status IN ('completed', 'cancelled') THEN 'full'
           END AS mode
      FROM public.organization_challenges AS c
      LEFT JOIN public.organization_challenge_aggregates AS s
        ON s.challenge_id = c.id
     WHERE (c.status = 'active'
            AND (s.challenge_id IS NULL OR LEAST(c.end_date, v_last_day) > s.counted_through))
        OR (c.status IN ('completed', 'cancelled') AND s.challenge_id IS NULL)
  )
  SELECT COALESCE(array_agg(k.id) FILTER (WHERE k.mode = 'full'), '{}'::uuid[]),
         COALESCE(array_agg(k.id) FILTER (WHERE k.mode = 'count_only'), '{}'::uuid[])
    INTO v_full, v_count_only
    FROM picked AS k;

  -- 集計 (人数と平均) の控え。人数だけのチャレンジは、順位がついた人数を 0・平均を NULL にする (参加者の行に残った古い値を入れない)
  WITH agg AS (
    SELECT c.id                                                          AS challenge_id,
           LEAST(c.end_date, v_last_day)                                 AS counted_through,
           (count(m.user_id))::integer                                   AS participants,
           CASE WHEN c.id = ANY (v_count_only) THEN 0
                ELSE (count(m.user_id) FILTER (WHERE m.rank IS NOT NULL))::integer
           END                                                           AS ranked,
           CASE WHEN c.id = ANY (v_count_only) THEN NULL
                ELSE avg(m.current_value) FILTER (WHERE m.rank IS NOT NULL)
           END                                                           AS average_value
      FROM public.organization_challenges AS c
      LEFT JOIN LATERAL (
        -- 今も組織のメンバーである参加者だけ
        SELECT p.user_id, p.rank, p.current_value
          FROM public.organization_challenge_participants AS p
          JOIN public.user_profiles AS up
            ON up.id = p.user_id
           AND up.organization_id = c.organization_id
         WHERE p.challenge_id = c.id
      ) AS m ON true
     WHERE c.id = ANY (v_full) OR c.id = ANY (v_count_only)
     GROUP BY c.id, c.end_date
  ),
  written AS (
    INSERT INTO public.organization_challenge_aggregates AS s
           (challenge_id, participant_count, ranked_count, average_value, counted_through, updated_at)
    SELECT a.challenge_id, a.participants, a.ranked, a.average_value, a.counted_through, COALESCE(p_now, now())
      FROM agg AS a
    ON CONFLICT (challenge_id) DO UPDATE
       SET participant_count = EXCLUDED.participant_count,
           ranked_count      = EXCLUDED.ranked_count,
           average_value     = EXCLUDED.average_value,
           counted_through   = EXCLUDED.counted_through,
           updated_at        = EXCLUDED.updated_at
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM written;

  -- 順位表の控え: 書いたチャレンジについて置き換える。値まで書くチャレンジだけ、いまの順位で入れる
  -- (順位がついた、今も組織のメンバーである参加者だけ)。人数だけのチャレンジは空にする
  DELETE FROM public.organization_challenge_ranking_entries AS e
   WHERE e.challenge_id = ANY (v_full) OR e.challenge_id = ANY (v_count_only);

  INSERT INTO public.organization_challenge_ranking_entries (challenge_id, user_id, rank, current_value, joined_at)
  SELECT c.id, p.user_id, p.rank, p.current_value, p.joined_at
    FROM public.organization_challenges AS c
    JOIN public.organization_challenge_participants AS p
      ON p.challenge_id = c.id
    JOIN public.user_profiles AS up
      ON up.id = p.user_id
     AND up.organization_id = c.organization_id
   WHERE c.id = ANY (v_full)
     AND p.rank IS NOT NULL;

  RETURN v_written;
END
$$;

-- ─────────────────────────────────────────────────────────
-- 4. 進み具合と順位の計算 (20261014100100 の定義に、今夜の対象を選ぶ 1 か所と、控えの数え直しを足す)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_org_challenge_progress(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today        date;
  v_last_day     date;
  v_challenges   integer := 0;
  v_participants integer := 0;
  v_changed      integer := 0;
  v_recompute    uuid[];
  v_count_only   uuid[];
  v_aggregates   integer := 0;
  v_completed    integer := 0;
BEGIN
  -- 今日 (JST の暦日)。集計に含める最後の日は前日 (今日はまだ終わっていない)
  v_today    := (COALESCE(p_now, now()) AT TIME ZONE 'Asia/Tokyo')::date;
  v_last_day := v_today - 1;

  -- 同時に 2 回走らせない (同じ参加行の更新が順不同に重なってデッドロックするのを防ぐ)
  PERFORM pg_advisory_xact_lock(hashtextextended('public.update_org_challenge_progress', 0));

  -- 今夜の対象を選ぶ (#1600。値を計算し直す集合と、控えに値を書く集合を同じにするため、選ぶのはここ 1 か所だけ):
  --   開催中で、控えが無いか、集計に含める最後の日 (min(終了日, 前日)) が控えを書いたときより進んだチャレンジ。
  --   最後の日が進まない夜 (終了したチャレンジを開催中に戻した・終了日を縮めた・同じ日にもう一度流した) は、
  --   参加者の行の値も順位も書かない (ほかの人の値が同じまま順位だけ詰まると、外れた人が自分より上だったかが分かる)
  --     v_recompute:  そのうち、食事の記録から計算できる種類で、集計できる日が 1 日以上あるもの (値と順位を計算し直し、控えに値まで書く)
  --     v_count_only: それ以外 (開始前・計算できない種類。控えには人数だけ書く)
  SELECT COALESCE(array_agg(x.id) FILTER (WHERE x.computable), '{}'::uuid[]),
         COALESCE(array_agg(x.id) FILTER (WHERE NOT x.computable), '{}'::uuid[])
    INTO v_recompute, v_count_only
    FROM (
      SELECT c.id,
             (c.challenge_type IN ('breakfast_rate', 'veg_score', 'cooking_rate')
              AND c.start_date <= LEAST(c.end_date, v_last_day)) AS computable
        FROM public.organization_challenges AS c
        LEFT JOIN public.organization_challenge_aggregates AS s
          ON s.challenge_id = c.id
       WHERE c.status = 'active'
         AND (s.challenge_id IS NULL OR LEAST(c.end_date, v_last_day) > s.counted_through)
    ) AS x;

  WITH target AS (
    -- 開催中で、指標を食事の記録から出せる種類のチャレンジ。集計できる日が 1 日以上あるもの (上で選んだ v_recompute)
    SELECT c.id AS challenge_id,
           c.organization_id,
           c.challenge_type,
           c.start_date,
           LEAST(c.end_date, v_last_day) AS last_day
      FROM public.organization_challenges AS c
     WHERE c.id = ANY (v_recompute)
  ),
  member AS (
    -- 参加者。今も、そのチャレンジの組織のメンバーである人だけ
    SELECT t.challenge_id,
           t.challenge_type,
           t.start_date,
           t.last_day,
           p.id AS participant_id,
           p.user_id
      FROM target AS t
      JOIN public.organization_challenge_participants AS p
        ON p.challenge_id = t.challenge_id
      JOIN public.user_profiles AS up
        ON up.id = p.user_id
       AND up.organization_id = t.organization_id
  ),
  agg AS (
    -- 参加者ごとの、期間内の記録の集計 (食事として数えるのは、完了していて 'skip' でないもの)
    SELECT m.participant_id,
           m.challenge_id,
           m.challenge_type,
           m.start_date,
           m.last_day,
           count(DISTINCT d.day_date) FILTER (WHERE pm.meal_type = 'breakfast') AS breakfast_days,
           avg(pm.veg_score)                                                    AS veg_avg,
           count(pm.id)                                                         AS meals,
           count(pm.id) FILTER (WHERE COALESCE(pm.mode, 'cook') IN ('cook', 'quick')) AS cook_meals
      FROM member AS m
      LEFT JOIN public.user_daily_meals AS d
        ON d.user_id = m.user_id
       AND d.is_sandbox = false
       AND d.day_date BETWEEN m.start_date AND m.last_day
      LEFT JOIN public.planned_meals AS pm
        ON pm.daily_meal_id = d.id
       AND pm.is_completed = true
       AND pm.mode IS DISTINCT FROM 'skip'
     GROUP BY m.participant_id, m.challenge_id, m.challenge_type, m.start_date, m.last_day
  ),
  scored AS (
    SELECT a.participant_id,
           a.challenge_id,
           CASE a.challenge_type
             WHEN 'breakfast_rate' THEN round(100.0 * a.breakfast_days / (a.last_day - a.start_date + 1), 1)
             WHEN 'veg_score'      THEN COALESCE(round(a.veg_avg, 1), 0)
             WHEN 'cooking_rate'   THEN CASE WHEN a.meals = 0 THEN 0 ELSE round(100.0 * a.cook_meals / a.meals, 1) END
           END AS progress
      FROM agg AS a
  ),
  ranked AS (
    -- チャレンジごとの順位。値が大きいほど上位。同じ値は同じ順位 (1, 1, 3, ...)
    SELECT s.participant_id,
           s.challenge_id,
           s.progress,
           (rank() OVER (PARTITION BY s.challenge_id ORDER BY s.progress DESC))::integer AS place
      FROM scored AS s
  ),
  upd AS (
    UPDATE public.organization_challenge_participants AS p
       SET current_value = r.progress,
           rank          = r.place
      FROM ranked AS r
     WHERE p.id = r.participant_id
       AND (p.current_value IS DISTINCT FROM r.progress OR p.rank IS DISTINCT FROM r.place)
    RETURNING p.id
  )
  SELECT (SELECT count(DISTINCT r.challenge_id) FROM ranked AS r),
         (SELECT count(*) FROM ranked),
         (SELECT count(*) FROM upd)
    INTO v_challenges, v_participants, v_changed;

  -- 管理者に見せる集計と、参加者に見せる順位表の控えを、いま書いた値で数え直す (#1600)。書くのは上で選んだ 2 つの集合だけ。
  -- 終了にする前に呼ぶので、終了日を過ぎたチャレンジの最後の集計も入る
  v_aggregates := public.refresh_org_challenge_aggregates(p_now, v_recompute, v_count_only);

  -- 終了日を過ぎた開催中のチャレンジを終了にする。最後の日までの値は、上で計算済み
  UPDATE public.organization_challenges
     SET status = 'completed'
   WHERE status = 'active'
     AND end_date < v_today;
  GET DIAGNOSTICS v_completed = ROW_COUNT;

  RETURN jsonb_build_object(
    'today_jst',    v_today,
    'last_day',     v_last_day,
    'challenges',   v_challenges,
    'participants', v_participants,
    'changed',      v_changed,
    'aggregates',   v_aggregates,
    'completed',    v_completed
  );
END
$$;


-- ─────────────────────────────────────────────────────────
-- 5. 管理者に見せる集計 (控えから読む。人数と平均だけ。10 人に満たない間は値を返さない)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_org_challenge_aggregates(p_organization_id uuid)
RETURNS TABLE (
  challenge_id      uuid,
  participant_count bigint,
  min_participants  integer,
  average_value     numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH cfg AS (
    -- 値を出すのに必要な最小人数 (要件書 §6.4 の匿名化集計の最低人数。個人を特定されない集計にする人数)
    SELECT 10 AS min_participants
  )
  SELECT c.id,
         -- 控えの参加者が最小人数に満たないときは、人数も出さない (控えが無いチャレンジも出さない)
         CASE WHEN s.participant_count >= cfg.min_participants THEN s.participant_count::bigint END,
         cfg.min_participants,
         -- 控えの、集計が済んだ (順位がついた) 参加者が最小人数に満たないときは、平均を出さない
         CASE WHEN s.ranked_count >= cfg.min_participants THEN round(s.average_value, 1) END
    FROM public.organization_challenges AS c
    LEFT JOIN public.organization_challenge_aggregates AS s
      ON s.challenge_id = c.id
   CROSS JOIN cfg
   WHERE c.organization_id = p_organization_id
$$;

-- ─────────────────────────────────────────────────────────
-- 6. 参加者に見せる順位表 (控えから並べる。参加者どうしにだけ。他人の ID は返さない)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_org_challenge_ranking(
  p_challenge_id uuid,
  p_user_id      uuid,
  p_limit        integer DEFAULT NULL,  -- NULL は既定の人数 (下の cfg.default_limit)
  p_with_names   boolean DEFAULT false
)
RETURNS TABLE (
  rank         integer,
  current_value numeric,
  is_me        boolean,
  nickname     text,
  ranked_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH cfg AS (
    -- 順位表に出す人数 (上位から。本人の行は、圏外でも別に付ける)
    --   default_limit: p_limit が NULL のときの人数。画面の順位表の人数 (src/lib/org-challenges.ts の RANKING_ENTRY_LIMIT) と同じ値にする
    --                  (設計書 docs/design/org/07-challenge.md「上位 20 人と本人の行」。tests/org-challenges-lib.test.ts が同じ値かを確かめる)
    --   max_limit:     p_limit に大きな値が渡されても、1 回に返す行数をこの人数で打ち切る (順位表は上位だけを見せるもので、
    --                  大きな組織の全員分を返さない。API が 1 回に受け取れる行数の上限 1000 行よりも十分小さくする)
    SELECT 20 AS default_limit, 100 AS max_limit
  ),
  ranked AS (
    -- 順位表の控え (毎晩の更新の時点で、順位がついていた、組織のメンバーである参加者)。
    -- 参加をやめた人・組織から外れた人の行も、次の夜の更新まで残す (前後の順位表の差から、その人の値を読ませない)
    SELECT e.rank,
           e.current_value,
           e.user_id,
           CASE WHEN p_with_names THEN up.nickname END AS nickname,
           row_number() OVER (ORDER BY e.rank, e.joined_at, e.user_id) AS pos,
           count(*) OVER () AS total
      FROM public.organization_challenge_ranking_entries AS e
      LEFT JOIN public.user_profiles AS up
        ON up.id = e.user_id
     WHERE e.challenge_id = p_challenge_id
  )
  SELECT r.rank,
         r.current_value,
         (r.user_id = p_user_id),
         r.nickname,
         r.total
    FROM ranked AS r
   CROSS JOIN cfg
   -- 人数は 1 人以上・max_limit 人以下にそろえる (0 以下が渡されても、1 人は返す)
   WHERE (r.pos <= LEAST(GREATEST(COALESCE(p_limit, cfg.default_limit), 1), cfg.max_limit) OR r.user_id = p_user_id)
     -- 順位表を見られるのは、いま、そのチャレンジの参加者本人 (今も組織のメンバー) だけ。参加していない人・やめた人には 0 行
     AND EXISTS (
       SELECT 1
         FROM public.organization_challenges AS c2
         JOIN public.organization_challenge_participants AS me
           ON me.challenge_id = c2.id
          AND me.user_id = p_user_id
         JOIN public.user_profiles AS meup
           ON meup.id = me.user_id
          AND meup.organization_id = c2.organization_id
        WHERE c2.id = p_challenge_id
     )
   ORDER BY r.pos
$$;

-- 関数の権限: service_role だけ (置き換えた 3 本も流し直す)
REVOKE ALL ON FUNCTION public.refresh_org_challenge_aggregates(timestamptz, uuid[], uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_org_challenge_aggregates(timestamptz, uuid[], uuid[])
  TO service_role;

REVOKE ALL ON FUNCTION public.update_org_challenge_progress(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_org_challenge_progress(timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.get_org_challenge_aggregates(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_aggregates(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean)
  TO service_role;

COMMENT ON FUNCTION public.refresh_org_challenge_aggregates(timestamptz, uuid[], uuid[]) IS
  '#1600: 組織チャレンジの集計の控え (organization_challenge_aggregates: 今も組織のメンバーである参加者の人数・順位がついた人数・その平均・集計に含めた最後の日) と順位表の控え (organization_challenge_ranking_entries) を、参加者の行から数え直す。書くチャレンジは自分では選ばず、呼び出し元が渡した集合に従う: p_recomputed_ids (その夜に値と順位を計算し直したもの) は値まで、p_count_only_ids (値を計算しない開催中のもの = 開始前・対象外の種類) は人数だけ (順位がついた人数 0・平均 NULL・順位表は空)。どちらも開催中で、控えが無いか集計に含める最後の日 (min(終了日, 前日)) が控えを書いたときより進んだものだけ書く。ほかに、控えがまだ無い終了・中止のチャレンジを最初の 1 回だけ書く (下書きは作らない)。集合を渡さずに単独で呼んでも、開催中のチャレンジは書かない。書いたチャレンジの数を返す。update_org_challenge_progress が毎晩呼ぶ。p_now は試験用。service_role のみ。';
COMMENT ON FUNCTION public.update_org_challenge_progress(timestamptz) IS
  '#1132: 開催中の組織チャレンジ (breakfast_rate / veg_score / cooking_rate) の参加者ごとの current_value を食事の記録 (user_daily_meals / planned_meals。JST の暦日。前日まで) から計算し、チャレンジの中で rank() をつける。#1600: 計算し直すのは、控えが無いか集計に含める最後の日 (min(終了日, 前日)) が控えを書いたときより進んだチャレンジだけ (進まない夜は参加者の行の値も順位も書かない)。そのあと集計と順位表の控え (organization_challenge_aggregates / organization_challenge_ranking_entries) を、計算し直した集合と人数だけ書く集合 (開始前・対象外の種類) を渡して refresh_org_challenge_aggregates で数え直す。終了日 (JST) を過ぎた開催中のチャレンジは completed にする。p_now は試験用。pg_cron が毎日 18:10 UTC (03:10 JST) に呼ぶ。service_role のみ。';
COMMENT ON FUNCTION public.get_org_challenge_aggregates(uuid) IS
  '#1132 / #1600: 管理者向けの集計。組織のチャレンジごとに、毎晩の更新の時点の控え (organization_challenge_aggregates) から、参加者数と、集計が済んだ参加者の平均だけを返す。個人の値・ID は返さない。控えの参加者が min_participants (10) に満たないときは参加者数を、集計が済んだ人が min_participants に満たないときは平均を NULL にする。控えの無いチャレンジ (下書き・作ったばかり) は両方 NULL。SECURITY INVOKER。service_role のみ。';
COMMENT ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean) IS
  '#1132 / #1600: 参加者に見せる順位表。p_user_id が、いまそのチャレンジの参加者 (今も組織のメンバー) のときだけ、毎晩の更新の時点の順位表の控え (organization_challenge_ranking_entries) から、上位 p_limit 人 (NULL は既定の default_limit = 20 人。1〜max_limit = 100 人にそろえる) と本人の行を返す (参加していない人には 0 行)。参加をやめた人・組織から外れた人の行は、次の夜の更新まで残る。他人の user_id は返さない (is_me だけ)。nickname は p_with_names が true のときだけ入る。SECURITY INVOKER。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 7. 控えを最初に作る (流す前に管理者・参加者に見えていた値と同じ値。開催中・終了・中止のチャレンジ。下書きは作らない)
-- ─────────────────────────────────────────────────────────
-- 開催中のチャレンジは全部、いまの参加者の行の値のまま書く (p_recomputed_ids に渡す。値は前の夜の更新が計算したもの)。
-- 終了・中止は、控えの無いものとして最初の 1 回だけ書かれる
SELECT public.refresh_org_challenge_aggregates(
  now(),
  ARRAY(SELECT c.id FROM public.organization_challenges AS c WHERE c.status = 'active'),
  '{}'::uuid[]
);

-- ─────────────────────────────────────────────────────────
-- 8. 参加の INSERT ポリシーに、API と同じ条件を足す
-- ─────────────────────────────────────────────────────────
-- API (POST /api/org/challenges/[id]/join) が見ている条件と同じ:
--   開催中 (status = 'active')・食事の記録から計算できる種類 (src/lib/org-challenges.ts の ORG_CHALLENGE_TYPES と同じ 3 つ)・
--   終了日 (JST) を過ぎていない・部署を限定したチャレンジは、その部署のメンバーだけ。
-- 元の条件 (本人・自分の組織のチャレンジ・進捗 0・順位なし) はそのまま。
DROP POLICY IF EXISTS "Users can join challenges" ON public.organization_challenge_participants;
CREATE POLICY "Users can join challenges" ON public.organization_challenge_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
        FROM public.organization_challenges AS oc
        JOIN public.user_profiles AS up
          ON up.organization_id = oc.organization_id
       WHERE oc.id = organization_challenge_participants.challenge_id
         AND up.id = (SELECT auth.uid())
         AND oc.status = 'active'
         AND oc.challenge_type IN ('breakfast_rate', 'veg_score', 'cooking_rate')
         AND oc.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date
         AND (oc.department_id IS NULL OR oc.department_id = up.department_id)
    )
    AND COALESCE(current_value, 0) = 0
    AND rank IS NULL
  );
