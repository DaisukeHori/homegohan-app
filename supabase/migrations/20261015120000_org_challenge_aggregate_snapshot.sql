-- migration: 20261015120000_org_challenge_aggregate_snapshot.sql
-- #1600: 組織チャレンジの集計 (管理者に見せる参加者数と平均) を強める。#1132 (20261014100100_org_challenge_progress.sql) の残り
--
-- 背景:
--   1. 集計の最小人数が 5 人だった。要件書 (docs/requirements/02-organization-management.md §6.4) は、匿名化集計の最低人数を 10 名以上とする。
--   2. 集計の差分: get_org_challenge_aggregates は、参加者の行をその場で数えていた。参加をやめる (DELETE) と行はすぐ消えるが、
--      ほかの人の値 (current_value) は夜の更新まで変わらないので、やめる前後の平均を比べると、やめた人の値を逆算できた
--      (やめた人の値 = 前の人数 × 前の平均 − 後の人数 × 後の平均)。管理者がメンバーを組織から外したとき
--      (user_profiles.organization_id が変わる) も同じで、外す前後の平均から、外した人の値が分かった。
--      終了したチャレンジは値がもう変わらないので、差がそのまま 1 人の値になった。最小人数の規則は、1 回の集計しか守らない。
--   3. 参加の INSERT ポリシー (#1238 の「Users can join challenges」) は、本人・自分の組織のチャレンジ・進捗 0・順位なししか見なかった。
--      部署の限定・状態・種類・終了日は API (POST /api/org/challenges/[id]/join) だけが見ていたので、利用者の JWT で PostgREST に
--      直接 INSERT すると、別の部署向け・下書き・終わったチャレンジにも参加行を作れ、夜の集計の順位と人数に混ざった。
--
-- 変更:
--   1. 表 organization_challenge_aggregates (チャレンジごとの集計の控え。1 チャレンジ 1 行) を作る。
--        participant_count (今も組織のメンバーである参加者の人数)・ranked_count (そのうち順位がついた人数)・
--        average_value (順位がついた人の平均。丸める前)・updated_at (値を書いた集計の時刻 = p_now)。
--        読み書きは service_role だけ (RLS を有効にしてポリシーは作らない。anon / authenticated の権限は外す)。
--        最小人数に満たない人数・平均もそのまま入れる (隠すのは読み出す関数 get_org_challenge_aggregates)。
--   2. refresh_org_challenge_aggregates(p_now timestamptz DEFAULT now())  SECURITY DEFINER / service_role だけが実行できる
--        開催中 (status = 'active') で開始日 (JST) を迎えたチャレンジについて、参加者の行から集計を数え直して控えに書く。
--        値が変わらない行は書き換えない (IS DISTINCT FROM)。書いた行の数を返す。
--        下書き・開始前のチャレンジは控えを作らない (人数も平均も出さない)。終了・中止のチャレンジは控えを書き換えない
--        (最後の集計の値のまま。終了したチャレンジは値が変わらないので、書き換えると差がそのまま 1 人の値になる)。
--   3. update_org_challenge_progress(p_now) が、進み具合と順位を書いたあと、終了にする前に refresh_org_challenge_aggregates(p_now) を呼ぶ。
--        定義は 20261014100100 のものに、この呼び出しと、返す jsonb の aggregates (控えを書いた行の数) を足しただけ。
--        終了日を過ぎたチャレンジは、終了にする前に最後の集計が控えに入る。
--   4. get_org_challenge_aggregates(p_organization_id) を、控えから読むように変える。最小人数を 10 人にする。
--        返す列・型・SECURITY INVOKER・STABLE・search_path は変えない。控えの無いチャレンジ (下書き・開始前・作ったばかり) は
--        人数も平均も NULL (最小人数に満たないときと同じ。「0 人」とは偽らない)。
--          参加者数 = 控えの参加者が 10 人に満たなければ NULL
--          平均     = 控えの、順位がついた参加者が 10 人に満たなければ NULL
--   5. 参加の INSERT ポリシー「Users can join challenges」に、API と同じ条件を足す:
--        チャレンジが開催中 (status = 'active')・食事の記録から計算できる種類 (breakfast_rate / veg_score / cooking_rate)・
--        終了日 (JST) を過ぎていない・部署を限定したチャレンジは、その部署のメンバーだけ。
--        元の条件 (本人・自分の組織のチャレンジ・進捗 0・順位なし) はそのまま。
--
-- 差分の攻撃をどう防ぐか (設計上の判断):
--   - 集計を「毎晩の更新の時点の控え」から返す。参加・参加のやめ・組織からの脱退や除名は、次の夜の更新でまとめて集計に入り、
--     その更新では全員の値 (current_value) も計算し直される。やめた (外れた) 人だけが動いた前後の平均を、管理者が取り出せない。
--     やめた人の行を夜まで残す (行の削除を遅らせる) 形は採らない: 管理者がメンバーを組織から外す経路
--     (user_profiles.organization_id の変更) と、値が動かない終了したチャレンジを守れないため。
--   - 参加者数も控えから返す。人数がその場で動くと、管理者があるメンバーを外した前後の人数の差から、その人が参加していたかが分かる。
--   - 残る限界: 夜の更新の前後で、ほかの人の値がほとんど動かない (前日に記録が少ない) ときは、前の夜と次の夜の平均の差から、
--     やめた人の値をおおよそ推し量れる。値に雑音を足す (差分プライバシー) ことはしない。
--     参加者どうしの順位表 (get_org_challenge_ranking) はこの migration では変えない (参加者に値を見せる表で、人数の下限も無い。#1132 の方針)。
--
-- 権限:
--   新しい関数は Supabase の既定権限で anon / authenticated / service_role に EXECUTE が自動付与されるため、
--   引数の型まで含めた完全形で、ロール個別に REVOKE してから service_role にだけ GRANT する (20261014100100 と同じ形)。
--   CREATE OR REPLACE は既存の権限を保つが、何度流しても同じになるよう、置き換える 2 本の権限も流し直す。
--   pg_cron は postgres ロールで update_org_challenge_progress() を呼び、その中から refresh_org_challenge_aggregates を呼ぶ
--   (SECURITY DEFINER の持ち主 postgres として動くので、GRANT は要らない)。
--
-- 本番のデータへの影響:
--   - 表を 1 つ足し、控えを最初に 1 回だけ作る:
--       * 終了・中止のチャレンジ: いまの参加者の行から数えた値 (この migration を流す前に管理者に見えていた値と同じ)
--       * 開催中で開始日を迎えたチャレンジ: refresh_org_challenge_aggregates(now()) で数えた値 (同じく、流す前に見えていた値と同じ)
--     既存の表の行は 1 件も書き換えない。
--   - 最小人数が 10 人になるので、参加者が 5〜9 人のチャレンジは、管理者の画面で人数も平均も出なくなる (「10人未満」)。
--   - 流したあとは、参加・参加のやめ・メンバーの脱退が、管理者に見える人数と平均に、次の夜の更新 (03:10 JST) まで反映されない。
--   - 新しい INSERT ポリシーは、既存の参加行には効かない (作るときだけ)。いまある「別の部署向け・下書き・終わったチャレンジ」の
--     参加行は消さない。
--   - 表への書き込みを待たせるロックは、ポリシーの付け替え (ACCESS EXCLUSIVE。一瞬) だけ。10 秒でロック待ちを諦める。
--
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS → CREATE POLICY /
--       控えの初回の作成は ON CONFLICT DO NOTHING と refresh (値が同じなら書かない)。何度流しても同じ結果になる。
-- 適用順: API・画面のコードと同じ PR。20261014100100_org_challenge_progress.sql の後。
-- 確認: tests/integration/rls/org-challenge-progress.test.ts / tests/integration/security/org-challenges-api.test.ts /
--       tests/integration/rls/challenge-participants-org-scope.test.ts / tests/org-challenge-aggregate-snapshot-migration-contract.test.ts
-- ロールバック: supabase/rollbacks/20261015120000_org_challenge_aggregate_snapshot.down.sql
--   (戻すと、集計がその場の数え方・最小人数 5 人に戻り、INSERT ポリシーも #1238 の形に戻る。差分の攻撃と直接の INSERT がまた通る)

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- 1. 集計の控え (service_role だけ)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_challenge_aggregates (
  challenge_id      uuid PRIMARY KEY REFERENCES public.organization_challenges(id) ON DELETE CASCADE,
  participant_count integer NOT NULL CHECK (participant_count >= 0),
  ranked_count      integer NOT NULL CHECK (ranked_count >= 0 AND ranked_count <= participant_count),
  average_value     numeric,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.organization_challenge_aggregates ENABLE ROW LEVEL SECURITY;
-- ポリシーは作らない (service_role は RLS を通り抜ける。それ以外のロールは 1 行も読めない)。権限も外す
REVOKE ALL ON TABLE public.organization_challenge_aggregates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organization_challenge_aggregates TO service_role;

COMMENT ON TABLE public.organization_challenge_aggregates IS
  '#1600: 組織チャレンジの集計の控え (1 チャレンジ 1 行)。毎晩の update_org_challenge_progress が refresh_org_challenge_aggregates で書き、get_org_challenge_aggregates が最小人数で隠して読む。参加・やめる・脱退の直後に集計が動かないようにして、前後の差から 1 人の値を逆算されるのを防ぐ。service_role のみ。';
COMMENT ON COLUMN public.organization_challenge_aggregates.participant_count IS
  '今も組織のメンバーである参加者の人数 (最小人数に満たなくてもそのまま入れる。隠すのは get_org_challenge_aggregates)';
COMMENT ON COLUMN public.organization_challenge_aggregates.ranked_count IS
  'participant_count のうち、順位がついた (集計が済んだ) 人数';
COMMENT ON COLUMN public.organization_challenge_aggregates.average_value IS
  '順位がついた参加者の current_value の平均 (丸める前)。順位がついた人がいなければ NULL';
COMMENT ON COLUMN public.organization_challenge_aggregates.updated_at IS
  '値を書いた集計の時刻 (refresh_org_challenge_aggregates の p_now)。値が変わらなかった集計では書き換えない';

-- ─────────────────────────────────────────────────────────
-- 2. 控えを数え直す (毎晩の更新から呼ぶ。試験・手動の再計算でも呼べる)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_org_challenge_aggregates(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today   date;
  v_written integer := 0;
BEGIN
  -- 今日 (JST の暦日)。開始日を迎えたチャレンジだけを数える
  v_today := (COALESCE(p_now, now()) AT TIME ZONE 'Asia/Tokyo')::date;

  -- update_org_challenge_progress と同じ鍵で直列にする (中から呼ばれたときは、同じトランザクションが持っている鍵をもう一度取るだけ)
  PERFORM pg_advisory_xact_lock(hashtextextended('public.update_org_challenge_progress', 0));

  WITH target AS (
    -- 開催中で、開始日 (JST) を迎えたチャレンジ。終了・中止は控えを書き換えない (最後の集計の値のまま)
    SELECT c.id AS challenge_id,
           c.organization_id
      FROM public.organization_challenges AS c
     WHERE c.status = 'active'
       AND c.start_date <= v_today
  ),
  agg AS (
    SELECT t.challenge_id,
           (count(m.user_id))::integer                                   AS participants,
           (count(m.user_id) FILTER (WHERE m.rank IS NOT NULL))::integer AS ranked,
           avg(m.current_value) FILTER (WHERE m.rank IS NOT NULL)        AS average_value
      FROM target AS t
      LEFT JOIN LATERAL (
        -- 今も組織のメンバーである参加者だけ
        SELECT p.user_id, p.rank, p.current_value
          FROM public.organization_challenge_participants AS p
          JOIN public.user_profiles AS up
            ON up.id = p.user_id
           AND up.organization_id = t.organization_id
         WHERE p.challenge_id = t.challenge_id
      ) AS m ON true
     GROUP BY t.challenge_id
  ),
  written AS (
    INSERT INTO public.organization_challenge_aggregates AS s
           (challenge_id, participant_count, ranked_count, average_value, updated_at)
    SELECT a.challenge_id, a.participants, a.ranked, a.average_value, COALESCE(p_now, now())
      FROM agg AS a
    ON CONFLICT (challenge_id) DO UPDATE
       SET participant_count = EXCLUDED.participant_count,
           ranked_count      = EXCLUDED.ranked_count,
           average_value     = EXCLUDED.average_value,
           updated_at        = EXCLUDED.updated_at
     -- 値が変わらない行は書き換えない
     WHERE (s.participant_count, s.ranked_count, s.average_value)
           IS DISTINCT FROM (EXCLUDED.participant_count, EXCLUDED.ranked_count, EXCLUDED.average_value)
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM written;

  RETURN v_written;
END
$$;

-- ─────────────────────────────────────────────────────────
-- 3. 進み具合と順位の計算 (20261014100100 の定義に、控えの数え直しを足す)
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
  v_aggregates   integer := 0;
  v_completed    integer := 0;
BEGIN
  -- 今日 (JST の暦日)。集計に含める最後の日は前日 (今日はまだ終わっていない)
  v_today    := (COALESCE(p_now, now()) AT TIME ZONE 'Asia/Tokyo')::date;
  v_last_day := v_today - 1;

  -- 同時に 2 回走らせない (同じ参加行の更新が順不同に重なってデッドロックするのを防ぐ)
  PERFORM pg_advisory_xact_lock(hashtextextended('public.update_org_challenge_progress', 0));

  WITH target AS (
    -- 開催中で、指標を食事の記録から出せる種類のチャレンジ。集計できる日が 1 日以上あるものだけ
    SELECT c.id AS challenge_id,
           c.organization_id,
           c.challenge_type,
           c.start_date,
           LEAST(c.end_date, v_last_day) AS last_day
      FROM public.organization_challenges AS c
     WHERE c.status = 'active'
       AND c.challenge_type IN ('breakfast_rate', 'veg_score', 'cooking_rate')
       AND c.start_date <= LEAST(c.end_date, v_last_day)
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

  -- 管理者に見せる集計の控えを、いま書いた値で数え直す (#1600)。終了にする前に呼ぶので、終了日を過ぎたチャレンジの最後の集計も入る
  v_aggregates := public.refresh_org_challenge_aggregates(p_now);

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
-- 4. 管理者に見せる集計 (控えから読む。人数と平均だけ。10 人に満たない間は値を返さない)
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

-- 関数の権限: service_role だけ (置き換えた 2 本も流し直す)
REVOKE ALL ON FUNCTION public.refresh_org_challenge_aggregates(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_org_challenge_aggregates(timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.update_org_challenge_progress(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_org_challenge_progress(timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.get_org_challenge_aggregates(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_aggregates(uuid)
  TO service_role;

COMMENT ON FUNCTION public.refresh_org_challenge_aggregates(timestamptz) IS
  '#1600: 開催中で開始日 (JST) を迎えた組織チャレンジの集計 (今も組織のメンバーである参加者の人数・順位がついた人数・その平均) を数え直し、organization_challenge_aggregates に書く。値が変わらない行は書かない。終了・中止のチャレンジは書き換えない。書いた行の数を返す。update_org_challenge_progress が毎晩呼ぶ。p_now は試験用。service_role のみ。';
COMMENT ON FUNCTION public.update_org_challenge_progress(timestamptz) IS
  '#1132: 開催中の組織チャレンジ (breakfast_rate / veg_score / cooking_rate) の参加者ごとの current_value を食事の記録 (user_daily_meals / planned_meals。JST の暦日。前日まで) から計算し、チャレンジの中で rank() をつける。#1600: そのあと集計の控え (organization_challenge_aggregates) を refresh_org_challenge_aggregates で数え直す。終了日 (JST) を過ぎた開催中のチャレンジは completed にする。p_now は試験用。pg_cron が毎日 18:10 UTC (03:10 JST) に呼ぶ。service_role のみ。';
COMMENT ON FUNCTION public.get_org_challenge_aggregates(uuid) IS
  '#1132 / #1600: 管理者向けの集計。組織のチャレンジごとに、毎晩の更新の時点の控え (organization_challenge_aggregates) から、参加者数と、集計が済んだ参加者の平均だけを返す。個人の値・ID は返さない。控えの参加者が min_participants (10) に満たないときは参加者数を、集計が済んだ人が min_participants に満たないときは平均を NULL にする。控えの無いチャレンジは両方 NULL。SECURITY INVOKER。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 5. 控えを最初に作る (流す前に管理者に見えていた値と同じ値)
-- ─────────────────────────────────────────────────────────
-- 終了・中止のチャレンジ: refresh は書き換えないので、ここで 1 回だけ数える
INSERT INTO public.organization_challenge_aggregates (challenge_id, participant_count, ranked_count, average_value)
SELECT c.id,
       (count(m.user_id))::integer,
       (count(m.user_id) FILTER (WHERE m.rank IS NOT NULL))::integer,
       avg(m.current_value) FILTER (WHERE m.rank IS NOT NULL)
  FROM public.organization_challenges AS c
  LEFT JOIN LATERAL (
    SELECT p.user_id, p.rank, p.current_value
      FROM public.organization_challenge_participants AS p
      JOIN public.user_profiles AS up
        ON up.id = p.user_id
       AND up.organization_id = c.organization_id
     WHERE p.challenge_id = c.id
  ) AS m ON true
 WHERE c.status IN ('completed', 'cancelled')
 GROUP BY c.id
ON CONFLICT (challenge_id) DO NOTHING;

-- 開催中で開始日を迎えたチャレンジ
SELECT public.refresh_org_challenge_aggregates(now());

-- ─────────────────────────────────────────────────────────
-- 6. 参加の INSERT ポリシーに、API と同じ条件を足す
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
