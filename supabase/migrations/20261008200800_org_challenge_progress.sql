-- migration: 20261008200800_org_challenge_progress.sql
-- #1132: 組織チャレンジの進み具合 (current_value) と順位 (rank) を、食事の記録から毎日自動で計算する
--
-- 背景:
--   organization_challenges / organization_challenge_participants (current_value・rank) は、作成・参加・人数の表示までは
--   あったが、記録から current_value / rank を計算して書き込む処理がどこにも無く、参加しても進み具合も順位も一切動かなかった。
--   2026-10-08 のオーナー判断 (#1132): 参加は任意。食事の記録から出せる 3 つの指標 (朝食をとれた日の割合・野菜スコア・自炊の割合) で始める。
--   順位は参加者どうしにだけ見せ、管理者には集計 (人数と平均) だけを見せる。歩数と体重は、健康データの同意の仕組みを作った後に足す。
--
-- 変更 (表・列は増やさない):
--   1. update_org_challenge_progress(p_now timestamptz DEFAULT now())  SECURITY DEFINER / service_role だけが実行できる
--        開催中 (status = 'active') で、指標が食事の記録から出せる種類 (breakfast_rate / veg_score / cooking_rate) のチャレンジについて、
--        参加者ごとに current_value を計算し、チャレンジの中で rank() をつけて organization_challenge_participants に書く。
--        そのあと、終了日 (end_date) を過ぎた開催中のチャレンジを status = 'completed' にする (歩数・体重・自由入力の種類も含む)。
--   2. get_org_challenge_aggregates(p_organization_id uuid)  SECURITY INVOKER / service_role だけが実行できる
--        管理者に見せる集計。チャレンジごとの参加者数と、集計が済んだ参加者の平均だけを返す (個人の値・ID は返さない)。
--        少人数から個人が分かってしまうのを防ぐため、人数が 5 人に満たないときは値を NULL にして返す:
--          参加者数  = 参加者が 5 人に満たなければ NULL
--          平均      = 集計が済んだ (順位がついた) 参加者が 5 人に満たなければ NULL
--   3. get_org_challenge_ranking(p_challenge_id, p_user_id, p_limit, p_with_names)  SECURITY INVOKER / service_role だけが実行できる
--        参加者に見せる順位表。p_user_id がそのチャレンジの参加者 (今も組織のメンバー) のときだけ、上位 p_limit 人と本人の行を返す。
--        他人の user_id は返さない (本人かどうかの is_me だけ)。表示名 (nickname) は p_with_names が true のときだけ入れる。
--   4. pg_cron: update-org-challenge-progress を毎日 18:10 UTC (= 03:10 JST) に登録する。
--   5. organization_challenge_participants の行レベルセキュリティ (RLS) を、本人の行だけに絞る。
--        SELECT: 「Org members can view participants」(同じ組織の全員が、全参加者の user_id・current_value・rank を読める) をやめ、
--                「Users can view own participation」(本人の行だけ) にする。
--        DELETE: 「Users can leave challenges」(本人の行だけ) を足す。参加は任意なので、いつでもやめられるようにする。
--        INSERT: 変更しない (#1238 の「Users can join challenges」のまま)。UPDATE: ポリシーなしのまま (利用者は進み具合を書き換えられない)。
--
-- 指標の定義 (対象は参加者本人の記録だけ。user_daily_meals.is_sandbox = false のもの。ハンズオンのお試しの記録は数えない):
--   食事として数える記録 = planned_meals の is_completed = true で、mode が 'skip' (食べない) でないもの。
--   期間 = チャレンジの開始日から、min(終了日, 前日) までの日 (JST の暦日)。
--     今日はまだ終わっていないので含めない。夜中 03:10 の実行で、前日までの記録が集計される。
--     チャレンジの開始日が今日 (または先) のときは、集計できる日がまだ無いので何もしない (rank は NULL のまま)。
--   breakfast_rate (朝食をとれた日の割合, %)
--       朝食 (meal_type = 'breakfast') を食べた日の数 ÷ 期間の日数 × 100。同じ日に朝食が 2 件あっても 1 日と数える。
--   veg_score (野菜スコアの平均, 点)
--       期間内の食事のうち、veg_score が入っているものの平均。1 件も無ければ 0。
--       注意: veg_score は書き込み元によって尺度が違う。列のコメントと /api/ai/nutrition の AI 推定は 1〜5 点だが、
--       写真の解析 (Edge Function analyze-meal-photo。nutrition-pipeline の estimateVegetableScore) は 0〜100 点で書く。
--       ここでは換算せず、入っている値をそのまま平均する (比較機能 calculate-segment-stats の veg_score_avg と同じ値の扱い)。
--       尺度をそろえるのは別の課題 (尺度が混ざっていれば、野菜スコアのチャレンジの順位は、点数の大きい書き込み元の人が有利になる)。
--   cooking_rate (自炊の割合, %)
--       期間内の食事のうち、mode が 'cook' または 'quick' (未設定は、列の既定値と同じ 'cook' とみなす) のものの割合。食事が 1 件も無ければ 0。
--       'ai_creative' (AI が作った献立をそのまま選んだもの) は自炊に数えない。バッジ (src/app/api/badges/route.ts) と
--       ホーム画面の自炊率 (src/hooks/useHomeData.ts) と同じ数え方 (画面に出ている自炊率と食い違わないようにする)。
--   値は小数第 1 位に丸める。順位は丸めた値 (画面に出る値) で決め、同じ値は同じ順位にする (1 位が 2 人なら次は 3 位)。
--   参加した日より前の記録も、期間内なら数える (全員を同じ期間で比べるため)。
--   記録が 1 件も無い参加者は 0 になり、順位は最下位 (同点) になる。
--   「JST」: 今日の日付は p_now を Asia/Tokyo の暦日にして決める。user_daily_meals.day_date は、アプリが JST の暦日で入れる date 型 (#1210 / #1211)。
--
-- 設計上の判断:
--   - 今も組織のメンバーである参加者だけを数える (user_profiles.organization_id がチャレンジの組織と同じ人)。
--     脱退・除名した人の行は残るが、更新も順位づけもしない。
--   - 参加の取り消し (DELETE) は参加行を消す。取り消した人の記録は、集計にも順位にも残らない。
--   - 同時に 2 回走ると同じ行の更新が順不同に重なるため、pg_advisory_xact_lock で直列にする。
--   - 値が変わらない行は書き換えない (IS DISTINCT FROM)。毎晩の実行で、変化のない行に書き込みが出ないようにする。
--   - p_now は試験と手動の再計算のための引数 (既定は now())。service_role だけが呼べる。
--   - get_org_challenge_aggregates は SECURITY INVOKER にする。service_role は RLS を通り抜けるので動き、
--     万一ほかのロールに EXECUTE を渡しても、そのロールには RLS が効いて他人の行を数えられない。
--   - 集計の最小人数 (5) は、この関数の中だけに書く。API は min_participants の値をそのまま画面に渡す。
--     (#1120 の判断と同じ。個人を特定されない集計にするための人数)
--     最小人数に満たないときは、平均だけでなく参加者数も出さない (「5 人未満」とだけ分かる)。人数が少ないと、
--     誰が参加しているかを推測されやすいため。メンバー向けの API も同じ関数で人数を取る (管理者はメンバーとしても API を呼べるので、
--     メンバー向けにだけ人数を出すと、管理者への制限が回避できてしまう)。最小人数を下げたいときは、この数字を変えるだけでよい。
--   - 順位表 (get_org_challenge_ranking) の絞り込み (上位と本人の行) を DB 側で行うのは、API が 1 回に受け取れる行数の上限
--     (既定 1000 行) を超える大きな組織でも、本人の行が欠けないようにするため。順位表を見られるのは参加者本人だけで、
--     この条件も関数の中で確かめる (API の確認が漏れても、参加していない人には何も返らない)。
--
-- 本番のデータへの影響:
--   - この migration は、既存の行を 1 件も書き換えない (関数・ポリシー・ジョブの登録だけ。関数もここでは呼ばない)。
--   - 最初の定時実行 (翌日 03:10 JST) で、次のように既存の行が更新される:
--       * 終了日を過ぎたまま 'active' になっているチャレンジが 'completed' になる (これまで自動で終わらせる処理が無かったため)
--       * 開催中の 3 種類のチャレンジの参加者の current_value / rank に、計算した値が入る
--     いずれも、このチャレンジ機能が意図している動き。元の値は戻せない (current_value は 0、rank は NULL に戻せるだけ)。
--   - 参加者の SELECT を絞るため、同じ組織の他の人の参加行を読んでいたコードは読めなくなる。
--     リポジトリ内でそうしていたのは管理者向けの GET /api/org/challenges の参加者数だけで、同じ PR で get_org_challenge_aggregates に切り替える。
--   - 表への書き込みを待たせるロックは、ポリシーの付け替え (ACCESS EXCLUSIVE。一瞬) だけ。10 秒でロック待ちを諦める。
--
-- 冪等: CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS → CREATE POLICY / 既存の同名ジョブの登録解除 → 登録。何度流しても同じ結果になる。
-- 適用順: API・画面のコードと同じ PR。migration は version 順にマージする (20261008200800)。
-- 確認: tests/integration/rls/org-challenge-progress.test.ts / tests/integration/security/org-challenges-api.test.ts
-- ロールバック: supabase/rollbacks/20261008200800_org_challenge_progress.down.sql
--   (ポリシーを元に戻すと、同じ組織の全員が参加行を読めるようになる。権限が広がるので注意)

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- 1. 進み具合と順位の計算 (毎日の定時実行と、試験・手動の再計算)
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

-- ─────────────────────────────────────────────────────────
-- 2. 管理者に見せる集計 (人数と平均だけ。個人の値は返さない。5 人に満たない間は値を返さない)
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

-- ─────────────────────────────────────────────────────────
-- 3. 参加者に見せる順位表 (参加者どうしにだけ。他人の ID は返さない)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_org_challenge_ranking(
  p_challenge_id uuid,
  p_user_id      uuid,
  p_limit        integer DEFAULT 20,
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
  WITH ranked AS (
    -- 順位がついている (集計が済んだ) 参加者。今も、そのチャレンジの組織のメンバーである人だけ
    SELECT p.rank,
           p.current_value,
           p.user_id,
           CASE WHEN p_with_names THEN up.nickname END AS nickname,
           row_number() OVER (ORDER BY p.rank, p.joined_at, p.user_id) AS pos,
           count(*) OVER () AS total
      FROM public.organization_challenges AS c
      JOIN public.organization_challenge_participants AS p
        ON p.challenge_id = c.id
      JOIN public.user_profiles AS up
        ON up.id = p.user_id
       AND up.organization_id = c.organization_id
     WHERE c.id = p_challenge_id
       AND p.rank IS NOT NULL
  )
  SELECT r.rank,
         r.current_value,
         (r.user_id = p_user_id),
         r.nickname,
         r.total
    FROM ranked AS r
   WHERE (r.pos <= LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) OR r.user_id = p_user_id)
     -- 順位表を見られるのは、そのチャレンジの参加者本人 (今も組織のメンバー) だけ。参加していない人には 0 行
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

-- 関数の権限: service_role だけ。
-- 新しい関数は Supabase の既定権限で anon / authenticated / service_role に EXECUTE が自動付与されるため、
-- 引数の型まで含めた完全形で、ロール個別に REVOKE してから service_role にだけ GRANT する。
-- (pg_cron はこの migration を流したロール = postgres で動くので、GRANT は要らない)
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

COMMENT ON FUNCTION public.update_org_challenge_progress(timestamptz) IS
  '#1132: 開催中の組織チャレンジ (breakfast_rate / veg_score / cooking_rate) の参加者ごとの current_value を食事の記録 (user_daily_meals / planned_meals。JST の暦日。前日まで) から計算し、チャレンジの中で rank() をつける。終了日 (JST) を過ぎた開催中のチャレンジは completed にする。p_now は試験用。pg_cron が毎日 18:10 UTC (03:10 JST) に呼ぶ。service_role のみ。';
COMMENT ON FUNCTION public.get_org_challenge_aggregates(uuid) IS
  '#1132: 管理者向けの集計。組織のチャレンジごとに、参加者数 (今も組織のメンバーである人) と、集計が済んだ参加者の平均だけを返す。個人の値・ID は返さない。参加者が min_participants (5) に満たないときは参加者数を、集計が済んだ人が min_participants に満たないときは平均を NULL にする。SECURITY INVOKER。service_role のみ。';
COMMENT ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean) IS
  '#1132: 参加者に見せる順位表。p_user_id がそのチャレンジの参加者 (今も組織のメンバー) のときだけ、順位がついている参加者を上位 p_limit 人 (最大 100) と本人の行について返す (参加していない人には 0 行)。他人の user_id は返さない (is_me だけ)。nickname は p_with_names が true のときだけ入る。SECURITY INVOKER。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 4. 毎日の定時実行 (pg_cron が無い DB では何もしない)
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron が無いため、update-org-challenge-progress の定期実行は登録しません';
    RETURN;
  END IF;

  -- 同じ名前のジョブがあれば登録解除してから登録し直す (何度流しても 1 本だけになる)
  PERFORM cron.unschedule(j.jobid)
     FROM cron.job AS j
    WHERE j.jobname = 'update-org-challenge-progress';

  -- 毎日 18:10 UTC = 03:10 JST。前日 (JST) の記録がそろってから集計する
  PERFORM cron.schedule(
    'update-org-challenge-progress',
    '10 18 * * *',
    'SELECT public.update_org_challenge_progress()'
  );
END
$$;

-- ─────────────────────────────────────────────────────────
-- 5. 参加者の行を、本人の行だけに絞る (参加は任意。順位は参加者どうし、管理者には集計だけ)
-- ─────────────────────────────────────────────────────────
-- SELECT: 同じ組織の全員が読めた「Org members can view participants」をやめ、本人の行だけにする。
--   順位表は API が、参加者であることを確かめたあとに service_role で読んで組み立てる (表示名を出すかどうかも API が決める)。
DROP POLICY IF EXISTS "Org members can view participants" ON public.organization_challenge_participants;
DROP POLICY IF EXISTS "Users can view own participation" ON public.organization_challenge_participants;
CREATE POLICY "Users can view own participation" ON public.organization_challenge_participants
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- DELETE: 本人の参加行だけ消せる (参加をやめる)。
DROP POLICY IF EXISTS "Users can leave challenges" ON public.organization_challenge_participants;
CREATE POLICY "Users can leave challenges" ON public.organization_challenge_participants
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));
