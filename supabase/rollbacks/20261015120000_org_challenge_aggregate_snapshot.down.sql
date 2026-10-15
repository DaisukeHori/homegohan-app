-- rollback: 20261015120000_org_challenge_aggregate_snapshot.sql
-- ⚠️ 守りが弱くなる: 戻すと、管理者向けの集計 (get_org_challenge_aggregates) が、参加者の行をその場で数える形と最小人数 5 人に戻り、
--    参加をやめる前後・メンバーを組織から外す前後の平均の差から、1 人の値を逆算できる状態に戻る。
--    参加の INSERT ポリシーも #1238 の形 (本人・自分の組織のチャレンジ・進捗 0・順位なし) に戻り、利用者の JWT で PostgREST に
--    直接 INSERT すると、別の部署向け・下書き・終わったチャレンジにも参加行を作れる状態に戻る (#1600 の前の状態)。
--    明示的な承認を得た場合に限って使う。
--
-- 内容:
--   1. update_org_challenge_progress(timestamptz) と get_org_challenge_aggregates(uuid) を、
--      20261014100100_org_challenge_progress.sql の定義にそのまま戻す (権限も同じ: service_role だけ)
--   2. refresh_org_challenge_aggregates(timestamptz) と表 organization_challenge_aggregates (集計の控え) を消す
--   3. 参加の INSERT ポリシー「Users can join challenges」を、#1238 の定義 (supabase/baseline/prod_schema.sql と同じ) に戻す
--   参加者の行・チャレンジの行には触れない。
--
-- 先に関数を戻してから表を消す (update_org_challenge_progress が refresh_org_challenge_aggregates を呼ばない形になってから消す)。
-- API・画面のコードは戻さなくてよい (関数の名前・引数・返す列は変わらない)。画面の説明文の「10人」は、
-- packages/shared の ORG_CHALLENGE_MIN_PARTICIPANTS を戻さない限り API が返す min_participants (5) で上書きされる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (冪等)。

SET LOCAL lock_timeout = '10s';

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
    'completed',    v_completed
  );
END
$$;

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
    -- 値を出すのに必要な最小人数 (#1120 の判断。個人を特定されない集計にする人数)
    SELECT 5 AS min_participants
  ),
  agg AS (
    SELECT c.id AS challenge_id,
           count(m.user_id)                                       AS participants,
           count(m.user_id) FILTER (WHERE m.rank IS NOT NULL)     AS ranked,
           avg(m.current_value) FILTER (WHERE m.rank IS NOT NULL) AS average_value
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
     WHERE c.organization_id = p_organization_id
     GROUP BY c.id
  )
  SELECT a.challenge_id,
         -- 参加者が最小人数に満たないときは、人数も出さない
         CASE WHEN a.participants >= cfg.min_participants THEN a.participants END,
         cfg.min_participants,
         -- 集計が済んだ (順位がついた) 参加者が最小人数に満たないときは、平均を出さない
         CASE WHEN a.ranked >= cfg.min_participants THEN round(a.average_value, 1) END
    FROM agg AS a
   CROSS JOIN cfg
$$;

REVOKE ALL ON FUNCTION public.update_org_challenge_progress(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_org_challenge_progress(timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.get_org_challenge_aggregates(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_aggregates(uuid)
  TO service_role;

COMMENT ON FUNCTION public.update_org_challenge_progress(timestamptz) IS
  '#1132: 開催中の組織チャレンジ (breakfast_rate / veg_score / cooking_rate) の参加者ごとの current_value を食事の記録 (user_daily_meals / planned_meals。JST の暦日。前日まで) から計算し、チャレンジの中で rank() をつける。終了日 (JST) を過ぎた開催中のチャレンジは completed にする。p_now は試験用。pg_cron が毎日 18:10 UTC (03:10 JST) に呼ぶ。service_role のみ。';
COMMENT ON FUNCTION public.get_org_challenge_aggregates(uuid) IS
  '#1132: 管理者向けの集計。組織のチャレンジごとに、参加者数 (今も組織のメンバーである人) と、集計が済んだ参加者の平均だけを返す。個人の値・ID は返さない。参加者が min_participants (5) に満たないときは参加者数を、集計が済んだ人が min_participants に満たないときは平均を NULL にする。SECURITY INVOKER。service_role のみ。';

DROP FUNCTION IF EXISTS public.refresh_org_challenge_aggregates(timestamptz);
DROP TABLE IF EXISTS public.organization_challenge_aggregates;

-- 参加の INSERT ポリシーを #1238 の定義 (supabase/baseline/prod_schema.sql) に戻す
DROP POLICY IF EXISTS "Users can join challenges" ON public.organization_challenge_participants;
CREATE POLICY "Users can join challenges" ON "public"."organization_challenge_participants" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM ("public"."organization_challenges" "oc"
     JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "oc"."organization_id")))
  WHERE (("oc"."id" = "organization_challenge_participants"."challenge_id") AND ("up"."id" = ( SELECT "auth"."uid"() AS "uid"))))) AND (COALESCE("current_value", (0)::numeric) = (0)::numeric) AND ("rank" IS NULL)));
